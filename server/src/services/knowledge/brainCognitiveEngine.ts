/**
 * Brain Cognitive Engine — the continuous thinking loop.
 *
 * Sits on top of Feed (raw events) + Wiki (source + concept pages) and
 * asks, on a 30-minute tick, "what's happening right now, what should
 * I have noticed, what's changing?". Produces two kinds of output:
 *
 *   observation  wiki pages — discrete insights Brain surfaced this tick
 *                 (e.g. "Raazia hasn't replied in 7 days on EXIM",
 *                  "Satori topic has 4 new mentions this week",
 *                  "New external contact: Greenwood Interior")
 *
 *   mind_state   one page per (clientNumber, userId) — a single
 *                running snapshot of "what Brain thinks is happening right
 *                now". Overwritten each tick. Small, dense, LLM-synthesized.
 *
 * Analyzers (composable, each one produces 0..N observation candidates):
 *
 *   A1. Open loops     — DELEGATED items with no inbound reply > 3 days
 *   A2. Stale threads  — sender_topic pages stuck > 5 days with status open
 *   A3. New contacts   — entity_person created last 24h with >=2 sources
 *   A4. Rising topics  — topic pages with linkedPageCount doubled in 7d
 *   A5. Frequency shift— senders whose 7d rate > 2× their 30d baseline
 *
 * Cheap and bounded per tick: each analyzer is one SQL query, no LLM
 * unless a candidate is worth promoting to a filed observation. The
 * mind_state paragraph is ONE LLM call per user per tick.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('brain-cognitive');

const MAX_OBSERVATIONS_PER_TICK = 8;

export interface Observation {
  kind: 'open_loop' | 'stale_thread' | 'new_contact' | 'rising_topic' | 'frequency_shift' | 'instruction_follow_up' | 'instruction_match' | 'instruction_veto';
  title: string;
  summary: string;
  /** Subject pageIds — what this observation points at. */
  anchors: string[];
  /** Urgency 0..1 — drives whether this surfaces on Day Brief. */
  urgency: number;
}

// ─── Analyzers ─────────────────────────────────────────────────

async function analyzeOpenLoops(clientNumber: string, userId: number): Promise<Observation[]> {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, delegatee_name AS delegatee, updated_at
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        AND status = 'DELEGATED'
        AND updated_at < $3
      ORDER BY updated_at ASC
      LIMIT 10`,
    clientNumber, userId, threeDaysAgo,
  ).catch(() => []);

  return rows.map((r) => {
    const days = Math.floor((Date.now() - new Date(r.updated_at).getTime()) / (24 * 60 * 60 * 1000));
    return {
      kind: 'open_loop' as const,
      title: `Waiting on ${r.delegatee ?? 'delegatee'} — ${String(r.title).slice(0, 80)}`,
      summary: `Delegated ${days} days ago, no update since. Consider a nudge or reassigning.`,
      anchors: [r.id],
      urgency: Math.min(0.9, 0.3 + days * 0.05),
    };
  });
}

async function analyzeStaleThreads(clientNumber: string, userId: number): Promise<Observation[]> {
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, last_updated_at
       FROM wiki_pages
      WHERE client_number = $1 AND user_id = $2
        AND page_type = 'sender_topic'
        AND status = 'active'
        AND last_updated_at < $3
        AND (metadata->>'totalInteractions')::int >= 3
      ORDER BY last_updated_at ASC
      LIMIT 6`,
    clientNumber, userId, fiveDaysAgo,
  ).catch(() => []);

  return rows.map((r) => {
    const days = Math.floor((Date.now() - new Date(r.last_updated_at).getTime()) / (24 * 60 * 60 * 1000));
    return {
      kind: 'stale_thread' as const,
      title: `Thread went quiet — ${String(r.title).split('::')[0].slice(0, 80)}`,
      summary: `${days} days since last activity on an active thread with 3+ messages. May need a follow-up.`,
      anchors: [r.id],
      urgency: Math.min(0.7, 0.2 + days * 0.03),
    };
  });
}

async function analyzeNewContacts(clientNumber: string, userId: number): Promise<Observation[]> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, (metadata->>'linkedPageCount')::int AS lpc, (metadata->>'personScope') AS scope
       FROM wiki_pages
      WHERE client_number = $1
        AND page_type = 'entity_person'
        AND status = 'active'
        AND created_at > $2
        AND (metadata->>'linkedPageCount')::int >= 2
      ORDER BY (metadata->>'linkedPageCount')::int DESC
      LIMIT 5`,
    clientNumber, oneDayAgo,
  ).catch(() => []);

  return rows.map((r) => ({
    kind: 'new_contact' as const,
    title: `New ${r.scope ?? 'contact'}: ${String(r.title).slice(0, 60)}`,
    summary: `Brain saw ${r.lpc} interactions with this person in the last 24h — first time they appear in your wiki.`,
    anchors: [r.id],
    urgency: r.scope === 'external' ? 0.5 : 0.3,
  }));
}

async function analyzeRisingTopics(clientNumber: string, userId: number): Promise<Observation[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  // Topic pages whose linked source count grew meaningfully in the last week.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT wp.id, wp.title, (wp.metadata->>'linkedPageCount')::int AS lpc,
            wp.last_updated_at
       FROM wiki_pages wp
      WHERE wp.client_number = $1
        AND wp.page_type = 'topic'
        AND wp.status = 'active'
        AND wp.last_updated_at > $2
        AND (wp.metadata->>'linkedPageCount')::int >= 3
      ORDER BY (wp.metadata->>'linkedPageCount')::int DESC
      LIMIT 5`,
    clientNumber, sevenDaysAgo,
  ).catch(() => []);

  return rows.map((r) => ({
    kind: 'rising_topic' as const,
    title: `Topic heating up: ${String(r.title).slice(0, 70)}`,
    summary: `${r.lpc} linked sources; Brain updated this concept page this week. Worth a look at what's moving.`,
    anchors: [r.id],
    urgency: 0.45,
  }));
}

async function analyzeFrequencyShift(clientNumber: string, userId: number): Promise<Observation[]> {
  // Senders whose 7-day rate materially exceeds their 30-day baseline.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `WITH rate AS (
       SELECT sender_email AS email, sender_name AS name,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::float AS w7,
              COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::float AS m30
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2
          AND sender_email IS NOT NULL
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY sender_email, sender_name
     )
     SELECT email, name, w7, m30,
            CASE WHEN m30 > 0 THEN (w7 * 30.0 / 7.0) / m30 ELSE 1 END AS ratio
       FROM rate
      WHERE w7 >= 4 AND m30 >= 6
        AND (w7 * 30.0 / 7.0) / m30 > 2.0
      ORDER BY ratio DESC
      LIMIT 5`,
    clientNumber, userId,
  ).catch(() => []);

  return rows.map((r) => ({
    kind: 'frequency_shift' as const,
    title: `${r.name ?? r.email} — activity spiked`,
    summary: `${Math.round(r.w7)} messages in 7 days vs ~${(r.m30 * 7 / 30).toFixed(1)} baseline. Something's moving with them.`,
    anchors: [],
    urgency: Math.min(0.75, 0.3 + Math.log(r.ratio) * 0.2),
  }));
}

/**
 * Instruction follow-up analyzer.
 *
 * Reads active user instructions and surfaces:
 *   - `follow_up` / `scheduled` / `todo` rows whose dueAt is within 24h
 *     (or already past) — so the user sees the reminder on Day Brief.
 *   - `standing_rule` / `watchpoint` rows that were recently *matched*
 *     against a feed event (tenant_log `instruction_match` entries in
 *     the last 24h) — so the user sees "Brain noticed your rule fired".
 *
 * Keeps this thin on purpose: Brain should not "act" on the instruction
 * here, just make it visible. Acting happens either through composer
 * (when the user asks something related) or through an explicit UI
 * workflow the user drives.
 */
async function analyzeInstructionFollowUps(clientNumber: string, userId: number): Promise<Observation[]> {
  const out: Observation[] = [];
  try {
    const { getActiveInstructions } = await import('./instructionService');
    const active = await getActiveInstructions(clientNumber, userId, 50);

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    for (const ins of active) {
      if (!ins.dueAt) continue;
      if (!['follow_up', 'scheduled', 'todo', 'update_request'].includes(ins.kind)) continue;
      const due = Date.parse(ins.dueAt);
      if (!Number.isFinite(due)) continue;
      const deltaHours = (due - now) / (60 * 60 * 1000);
      // Within 24h OR overdue by ≤14 days
      if (deltaHours > 24) continue;
      if (deltaHours < -24 * 14) continue;

      const overdue = deltaHours < 0;
      const label = overdue
        ? `Overdue by ${Math.abs(Math.round(deltaHours / 24))} day${Math.abs(deltaHours / 24) >= 2 ? 's' : ''}`
        : `Due in ${Math.max(0, Math.round(deltaHours))}h`;

      out.push({
        kind: 'instruction_follow_up',
        title: `${ins.title} — ${label}`,
        summary: `${ins.originalText}${ins.action ? ` · action: ${ins.action}` : ''}`,
        anchors: [ins.id],
        urgency: overdue ? 0.85 : Math.max(0.4, 0.7 - deltaHours / 48),
      });
    }
  } catch { /* analyzer is best-effort */ }

  // Recent matches — read tenant_log for instruction_match events in the last 24h.
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT title, body_markdown AS "body", last_updated_at AS "at"
         FROM wiki_pages
        WHERE client_number = $1 AND user_id = $2
          AND page_type = 'tenant_log'
          AND last_updated_at >= $3::timestamp
        ORDER BY last_updated_at DESC
        LIMIT 1`,
      clientNumber, userId, sinceIso,
    ).catch(() => []);
    // tenant_log is rolled into a single wiki page; parse recent lines
    // for `kind=instruction_match` entries to promote as an observation.
    const body = String(rows[0]?.body ?? '');
    const matches = body.split('\n').filter((l) => l.includes('[instruction_match]')).slice(0, 3);
    for (const line of matches) {
      out.push({
        kind: 'instruction_match',
        title: line.slice(0, 160).replace(/^[^]*?\]\s*/, '').trim() || 'Standing instruction fired on a recent event',
        summary: 'One of your standing instructions matched a newly received event. Check the Attention list or the Instructions panel.',
        anchors: [],
        urgency: 0.5,
      });
    }
    // Vetoes are more urgent than matches — the user's standing rule
    // actively blocked Brain from auto-acting, and the event is waiting.
    const vetoes = body.split('\n').filter((l) => l.includes('[instruction_veto]')).slice(0, 3);
    for (const line of vetoes) {
      out.push({
        kind: 'instruction_veto',
        title: line.slice(0, 160).replace(/^[^]*?\]\s*/, '').trim() || 'Brain held an auto-action for your approval',
        summary: 'Your standing instruction blocked Brain from auto-acting on an incoming event. Review and approve or dismiss in Attention.',
        anchors: [],
        urgency: 0.75,
      });
    }
  } catch { /* best effort */ }

  return out;
}

// ─── Filing ────────────────────────────────────────────────────

export interface RunResult {
  observationsFiled: number;
  mindStateUpdated: boolean;
  durationMs: number;
}

export async function runCognitiveTick(clientNumber: string, userId: number): Promise<RunResult> {
  const t0 = Date.now();
  const candidates: Observation[] = [];
  try {
    const [a1, a2, a3, a4, a5, a6] = await Promise.all([
      analyzeOpenLoops(clientNumber, userId),
      analyzeStaleThreads(clientNumber, userId),
      analyzeNewContacts(clientNumber, userId),
      analyzeRisingTopics(clientNumber, userId),
      analyzeFrequencyShift(clientNumber, userId),
      analyzeInstructionFollowUps(clientNumber, userId),
    ]);
    candidates.push(...a1, ...a2, ...a3, ...a4, ...a5, ...a6);
  } catch (err: any) {
    log.warn('analyzers failed', { userId, error: err.message });
  }

  // Rank by urgency, cap the tick output
  candidates.sort((a, b) => b.urgency - a.urgency);
  const top = candidates.slice(0, MAX_OBSERVATIONS_PER_TICK);

  let filed = 0;
  for (const obs of top) {
    const ok = await fileObservation(clientNumber, userId, obs);
    if (ok) filed++;
  }

  const mindOk = await updateMindState(clientNumber, userId, top);

  const durationMs = Date.now() - t0;
  log.info('cognitive tick complete', { clientNumber, userId, filed, mindOk, durationMs });
  return { observationsFiled: filed, mindStateUpdated: mindOk, durationMs };
}

async function fileObservation(clientNumber: string, userId: number, obs: Observation): Promise<boolean> {
  // Dedupe on title within a 24h window — so the same stale thread
  // doesn't spawn a new observation every tick.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await prisma.wikiPage.findFirst({
    where: {
      clientNumber, userId, pageType: 'observation',
      title: obs.title,
      lastUpdatedAt: { gte: since },
    } as any,
    select: { id: true },
  }).catch(() => null);
  if (existing) {
    // bump the urgency / body but don't create a duplicate
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: { bodyMarkdown: renderObservationBody(obs), metadata: { ...obs, schemaVersion: BRAIN_SCHEMA_VERSION, authoredBy: 'cognitive_engine' } as any, lastUpdatedAt: new Date() },
    }).catch(() => {});
    return false;
  }
  try {
    const created = await prisma.wikiPage.create({
      data: {
        clientNumber, userId, pageType: 'observation',
        title: obs.title.slice(0, 300),
        bodyMarkdown: renderObservationBody(obs),
        metadata: { ...obs, schemaVersion: BRAIN_SCHEMA_VERSION, authoredBy: 'cognitive_engine' } as any,
        storage: 'postgres', status: 'active',
        sourceCount: obs.anchors.length,
        lastUpdatedBy: 'cognitive_engine',
      },
    });
    // Link observation → each anchor page
    for (const a of obs.anchors) {
      await prisma.wikiPageLink.upsert({
        where: { fromPageId_toPageId_linkType: { fromPageId: created.id, toPageId: a, linkType: 'related' } } as any,
        update: {},
        create: { clientNumber, userId, fromPageId: created.id, toPageId: a, linkType: 'related' },
      }).catch(() => {});
    }
    // Embed so observation is reachable by semantic search
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(created.id);
      } catch { /* best effort */ }
    })();
    return true;
  } catch {
    return false;
  }
}

function renderObservationBody(obs: Observation): string {
  const badge = obs.kind.replace('_', ' ');
  const urg = obs.urgency >= 0.6 ? '🔴 high' : obs.urgency >= 0.4 ? '🟡 medium' : '⚪ low';
  return [
    `# ${obs.title}`,
    '',
    `**Kind:** ${badge}`,
    `**Urgency:** ${urg} (${obs.urgency.toFixed(2)})`,
    `**Noticed:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    '## What Brain noticed',
    obs.summary,
    '',
    obs.anchors.length > 0 ? `## Anchors\n${obs.anchors.map((a) => `- \`${a}\``).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

async function updateMindState(clientNumber: string, userId: number, obs: Observation[]): Promise<boolean> {
  // One LLM call: synthesize "what's happening right now" from the
  // analyzer output + recent tenant_log tail. Cheap (~200 tokens out).
  try {
    const logTail = await prisma.wikiPage.findFirst({
      where: { clientNumber, userId, pageType: 'tenant_log', title: 'Tenant Log' },
      select: { bodyMarkdown: true },
    }).catch(() => null);
    const recentLines = String(logTail?.bodyMarkdown ?? '')
      .split('\n').filter((l) => l.startsWith('## ['))
      .slice(-12).join('\n');

    const prompt = `Observations from this tick:\n${obs.length > 0
      ? obs.map((o) => `- [${o.kind}] ${o.title} — ${o.summary}`).join('\n')
      : '(no analyzer hits this tick)'}\n\nRecent tenant activity:\n${recentLines || '(nothing recent)'}`;

    const sys = `You are Brain's situational awareness module. In 2-3 short sentences (plain prose, max 80 words), describe what is happening in the user's workspace right now: what's active, what's waiting, what's emerging. No bullets, no headers. No speculation beyond the data. This is Brain's running "mind state" — overwritten every 30 minutes, read by Brain before answering future questions.`;
    const r = await callLLM(sys, prompt, {
      maxTokens: 180,
      userId, clientNumber, purpose: 'cognitive_mind_state',
    });
    const summary = r.text.trim();
    if (!summary) return false;

    const title = 'Mind State';
    const body = [
      `# ${title}`,
      '',
      `**Updated:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      '',
      summary,
    ].join('\n');

    const existing = await prisma.wikiPage.findFirst({
      where: { clientNumber, userId, pageType: 'mind_state', title },
      select: { id: true },
    }).catch(() => null);

    if (existing) {
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: { bodyMarkdown: body, lastUpdatedAt: new Date(), lastUpdatedBy: 'cognitive_engine' },
      }).catch(() => {});
    } else {
      await prisma.wikiPage.create({
        data: {
          clientNumber, userId, pageType: 'mind_state', title,
          bodyMarkdown: body,
          metadata: { schemaVersion: BRAIN_SCHEMA_VERSION, authoredBy: 'cognitive_engine' },
          storage: 'postgres', status: 'active',
          lastUpdatedBy: 'cognitive_engine',
        },
      }).catch(() => {});
    }
    return true;
  } catch (err: any) {
    log.warn('mind state update failed', { userId, error: err.message });
    return false;
  }
}

export async function getLatestObservations(clientNumber: string, userId: number, limit = 5): Promise<any[]> {
  return prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, body_markdown AS body, metadata, last_updated_at AS "lastUpdatedAt",
            (metadata->>'urgency')::float AS urgency, (metadata->>'kind') AS kind
       FROM wiki_pages
      WHERE client_number = $1 AND user_id = $2
        AND page_type = 'observation' AND status = 'active'
      ORDER BY (metadata->>'urgency')::float DESC, last_updated_at DESC
      LIMIT $3`,
    clientNumber, userId, limit,
  ).catch(() => []);
}

export async function getMindState(clientNumber: string, userId: number): Promise<{ body: string | null; updatedAt: Date | null }> {
  const p = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: 'mind_state', title: 'Mind State' },
    select: { bodyMarkdown: true, lastUpdatedAt: true },
  }).catch(() => null);
  return { body: p?.bodyMarkdown ?? null, updatedAt: p?.lastUpdatedAt ?? null };
}
