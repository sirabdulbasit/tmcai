/**
 * MyOS Gap 1b — 5-Pass Conditional Signal Classifier
 *
 * Classifies every incoming feed item (email, WhatsApp, chat, ERP, tasks)
 * through up to 5 passes. Most items exit early (~85% by Pass 2).
 *
 * Pass 1: Fast entity match (resolve ~60%) — zero LLM calls
 * Pass 2: Gemini Flash classification with confidence (resolve ~25%)
 * Pass 3: Second Gemini Flash with rephrased prompt — disagreement check (~10%)
 * Pass 4: Historical pattern recall from DecisionLog (~3-4%)
 * Pass 5: HITL — creates an alert OpenItem for user to classify (~2%)
 *
 * Feature flag: ff_feed_intelligence (must be enabled per tenant)
 * All queries scoped by clientNumber. userId is number (Int).
 */

import crypto from 'crypto';
import prisma from '../db/prisma';
import * as entityService from './entityService';
import * as openItemsService from './openItemsService';
import * as brainConfigService from './brainConfigService';
import { isFeatureEnabled } from './featureFlagService';

// ─── Types ──────────────────────────────────────────────────────

export type FeedSource = 'gmail' | 'whatsapp' | 'chat' | 'erp' | 'crm' | 'tasks' | 'manual';

export type Intent =
  | 'NEW_TASK' | 'PROGRESS_UPDATE' | 'ESCALATION'
  | 'INFORMATION' | 'RISK' | 'OPPORTUNITY' | 'FYI' | 'NOISE';

export type PrioritySignal = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface RawFeedItem {
  sourceRef: string;
  source: FeedSource;
  connectorSlug: string;
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  body: string;            // max 4000 chars — caller truncates
  receivedAt: Date;
  clientNumber: string;
  userId: number;
}

export interface ClassifiedFeedItem {
  id: string;
  clientNumber: string;
  userId: number;
  source: FeedSource;
  connectorSlug: string;
  entityId: string | null;
  intent: Intent;
  prioritySignal: PrioritySignal;
  confidence: number;
  classificationPass: number;
  idempotencyKey: string;
  summary: string;
  body: string;
  sourceRef: string;
  receivedAt: Date;
}

// ─── Idempotency ────────────────────────────────────────────────

function buildIdempotencyKey(item: RawFeedItem): string {
  const raw = `${item.clientNumber}:${item.userId}:${item.source}:${item.sourceRef}:${item.body.slice(0, 100)}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─── Main classifier ────────────────────────────────────────────

export async function classifyFeedItem(raw: RawFeedItem): Promise<ClassifiedFeedItem | null> {
  // Feature flag check
  const enabled = await isFeatureEnabled(raw.clientNumber, 'ff_feed_intelligence', false);
  if (!enabled) return null;

  // Idempotency — skip if already processed
  const idempotencyKey = buildIdempotencyKey(raw);
  const existing = await prisma.openItem.findFirst({
    where: { idempotencyKey, clientNumber: raw.clientNumber },
  });
  if (existing) return null;

  // ── PASS 1: Fast entity match (~60%) ──────────────────────
  let entityId: string | null = null;
  if (raw.senderEmail) {
    const entity = await entityService.findByEmail(raw.clientNumber, raw.senderEmail);
    if (entity) {
      entityId = entity.id;
      await entityService.touchInteraction(entity.id);
      const prioritySignal: PrioritySignal =
        entity.sentimentScore && entity.sentimentScore < -0.5 ? 'HIGH' : 'MEDIUM';
      return buildResult(raw, entityId, 'INFORMATION', prioritySignal, 0.95, 1, idempotencyKey,
        `Message from ${entity.name}`);
    }
  }

  // ── PASS 2: Gemini Flash LLM classification (~25%) ────────
  const escalationRules = await brainConfigService.getEscalationRules(raw.userId);
  const pass2 = await callClassifier(raw, escalationRules, 'primary');

  if (pass2 && pass2.confidence >= 0.85) {
    return buildResult(raw, entityId, pass2.intent as Intent, pass2.prioritySignal as PrioritySignal,
      pass2.confidence, 2, idempotencyKey, pass2.summary);
  }

  // ── PASS 3: Second Gemini Flash (rephrased) (~10%) ────────
  // Same model, different prompt framing — 200× cheaper than Claude
  const pass3 = await callClassifier(raw, escalationRules, 'secondary');

  if (pass2 && pass3 && pass2.intent === pass3.intent) {
    const combinedConfidence = (pass2.confidence + pass3.confidence) / 2;
    return buildResult(raw, entityId, pass2.intent as Intent, pass2.prioritySignal as PrioritySignal,
      combinedConfidence, 3, idempotencyKey, pass2.summary);
  }

  // ── PASS 4: Historical pattern recall from DecisionLog (~3-4%) ─
  // NOTE: Pass 4 will be no-op for first ~30 days until DecisionLog accumulates data.
  // Items that reach here will fall through to Pass 5 (HITL). Expected behaviour.
  try {
    const patterns = await prisma.decisionLog.groupBy({
      by: ['itemType', 'suggestedAction'],
      where: {
        clientNumber: raw.clientNumber,
        userId: raw.userId,
        isMatch: true,
        createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 1,
    });

    if (patterns.length > 0 && patterns[0]._count.id >= 5) {
      return buildResult(raw, entityId, (patterns[0].suggestedAction || 'INFORMATION') as Intent,
        'MEDIUM', 0.75, 4, idempotencyKey, 'Pattern-based classification');
    }
  } catch {
    // DecisionLog may not have data yet — continue to Pass 5
  }

  // ── PASS 5: HITL — human in the loop (~2%) ────────────────
  // Detect forwarded emails first — when someone forwards an email to the
  // user, the actionable signal is in the FORWARDER'S note, not the raw
  // subject. Build a clean title/description that surfaces the real ask.
  const { parseForwardedEmail, buildOpenItemFromForward } = await import('./openItems/forwardedEmailParser');
  const { qualifyAutoOpenItem } = await import('./openItems/qualityGate');
  const parsed = parseForwardedEmail(raw.subject ?? null, raw.body);
  let title: string;
  let description: string;
  if (parsed.isForwarded) {
    const built = buildOpenItemFromForward(
      parsed,
      raw.senderEmail ?? null,
      raw.senderName ?? null,
      raw.subject ?? raw.body.slice(0, 80),
    );
    title = built.title;
    description = `${built.description}\n\nUnable to automatically classify this forwarded ${raw.source} item. Please review.`;
  } else {
    title = `Classification needed: ${raw.subject ?? raw.body.slice(0, 80)}`;
    description = `Unable to automatically classify this ${raw.source} item. Please review.\n\nContent: ${raw.body.slice(0, 500)}`;
  }

  // Quality gate — Pass 5 only fires on the ~2% that nothing else
  // resolved, but we still drop pure-FYI / no-signal residue rather than
  // dump it on the user's Action Center.
  const verdict = qualifyAutoOpenItem({
    title,
    body: parsed.innerBody ?? raw.body,
    intent: pass2?.intent ?? null,
    confidence: pass2?.confidence ?? 0,
    senderEmail: raw.senderEmail ?? null,
    archetype: parsed.isForwarded ? 'reply_needed' : null,
    minConfidence: 0,  // confidence already failed pass2/3 — gate on signals only
  });
  if (verdict.verdict === 'reject') {
    return null;  // dropped silently — not a real ask
  }

  // Priority floor from the sender's user-given stars. Policy: unrated
  // is normal; criticality starts with stars; 5★ = top critical.
  // - 0–2★ → no floor (medium default stays)
  // - 3★ → at least medium (no-op vs default)
  // - 4★ → at least high
  // - 5★ → at least critical
  let priority: 'low' | 'medium' | 'high' | 'critical' = 'medium';
  try {
    const { getStarsForSender } = await import('./knowledge/entitySweepService');
    const stars = await getStarsForSender(raw.clientNumber, raw.userId, raw.senderEmail ?? null);
    if (stars >= 5) priority = 'critical';
    else if (stars === 4) priority = 'high';
  } catch { /* no sender or stars unavailable — keep default */ }

  await openItemsService.createItem(raw.userId, raw.clientNumber, {
    title,
    description,
    type: 'alert',
    priority,
    sourceFeed: raw.source,
    sourceRef: raw.sourceRef,
    metadata: {
      classificationPass: 5,
      pass2Intent: pass2?.intent,
      pass3Intent: pass3?.intent,
      requiresHITL: true,
      idempotencyKey,
      // Surface for downstream hooks (star cadence in openItemsService
      // looks these up to schedule WhatsApp notifications).
      senderEmail: raw.senderEmail ?? null,
      senderName: raw.senderName ?? null,
      forwarded: parsed.isForwarded ? {
        forwarderEmail: raw.senderEmail ?? null,
        forwarderName: raw.senderName ?? null,
        originalSenderEmail: parsed.originalSenderEmail,
        originalSenderName: parsed.originalSenderName,
        forwarderNote: parsed.forwarderNote,
      } : undefined,
      qualityGate: { code: verdict.code, reason: verdict.reason },
    },
  });

  return null; // surfaced as open item, not as classified item
}

// ─── LLM classifier call ────────────────────────────────────────

interface ClassifierResult {
  intent: string;
  prioritySignal: string;
  confidence: number;
  summary: string;
}

async function callClassifier(
  raw: RawFeedItem,
  escalationRules: any[],
  variant: 'primary' | 'secondary',
): Promise<ClassifierResult | null> {
  try {
    const { getGenAI } = await import('./genaiClient');
    const genai = getGenAI();

    const criticalContacts = escalationRules
      .filter((r: any) => r.priority === 'critical')
      .map((r: any) => r.condition)
      .join(', ');

    const prompt = variant === 'primary'
      ? `Classify this ${raw.source} message for a business executive.

Message from: ${raw.senderName ?? 'unknown'} <${raw.senderEmail ?? 'unknown'}>
Subject: ${raw.subject ?? 'none'}
Content: ${raw.body.slice(0, 2000)}

Critical contacts/conditions: ${criticalContacts || 'not specified'}

Return ONLY valid JSON: { "intent": "NEW_TASK"|"PROGRESS_UPDATE"|"ESCALATION"|"INFORMATION"|"RISK"|"OPPORTUNITY"|"FYI"|"NOISE", "prioritySignal": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW", "confidence": 0.0-1.0, "summary": "one sentence" }`
      : `You are reviewing a business communication to determine what action it requires.

From: ${raw.senderEmail ?? 'unknown'}
Text: ${raw.body.slice(0, 2000)}

Critical escalation conditions: ${criticalContacts || 'not specified'}

What does this require? Return ONLY valid JSON: { "intent": "NEW_TASK"|"PROGRESS_UPDATE"|"ESCALATION"|"INFORMATION"|"RISK"|"OPPORTUNITY"|"FYI"|"NOISE", "prioritySignal": "CRITICAL"|"HIGH"|"MEDIUM"|"LOW", "confidence": 0.0-1.0, "summary": "one sentence" }`;

    const response = await genai.models.generateContent({ model: 'gemini-2.0-flash', contents: prompt });
    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        intent: parsed.intent || 'INFORMATION',
        prioritySignal: parsed.prioritySignal || 'MEDIUM',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        summary: parsed.summary || '',
      };
    }
  } catch (err: any) {
    console.error(`[feedIntelligence] Pass ${variant} LLM error:`, err.message?.slice(0, 100));
  }
  return null;
}

// ─── Result builder ─────────────────────────────────────────────

function buildResult(
  raw: RawFeedItem,
  entityId: string | null,
  intent: Intent,
  prioritySignal: PrioritySignal,
  confidence: number,
  classificationPass: number,
  idempotencyKey: string,
  summary: string,
): ClassifiedFeedItem {
  return {
    id: crypto.randomUUID(),
    clientNumber: raw.clientNumber,
    userId: raw.userId,
    source: raw.source,
    connectorSlug: raw.connectorSlug,
    entityId,
    intent,
    prioritySignal,
    confidence,
    classificationPass,
    idempotencyKey,
    summary,
    body: raw.body,
    sourceRef: raw.sourceRef,
    receivedAt: raw.receivedAt,
  };
}
