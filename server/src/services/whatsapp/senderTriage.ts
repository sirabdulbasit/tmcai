/**
 * Section 35 Phase 1 — sender triage at the tenant WhatsApp door.
 *
 * Replaces the silent drop for non-registered senders (owner ruling
 * 2026-08-04). Order of decision for an inbound from an unknown number:
 *
 *   1. standing policy row — 'ignored' drops silently (the owner's own
 *      decision, honored until countermanded); 'allowed' relays the
 *      message to the owner (Phase 2 adds the scoped conversation);
 *      'pending' updates last_inbound_at and stays quiet (ask-once:
 *      repeat messages NEVER re-prompt).
 *   2. concern evidence — deterministic joins over the owner's own data
 *      (delegation counterpart, prior Brain outbound to this number,
 *      person-facet phone match). Any evidence ⇒ auto-allow with the
 *      evidence recorded; the owner is notified with the message.
 *   3. no evidence ⇒ mark pending + ask the owner ONCE:
 *      "+92… sent: … Reply to them or ignore?"
 *
 * Fail-closed: any lookup failure is treated as 'unknown' (ask), never as
 * 'allowed'. The Brain never recommends ignoring anyone — the ask is
 * neutral and the decision is the owner's alone.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { whatsappPhoneVariants } from './inboundIdentity';

const log = createLogger('whatsapp:sender-triage');

export type SenderPolicy = 'pending' | 'allowed' | 'ignored';

export interface TriageOutcome {
  action: 'dropped_ignored' | 'held_pending' | 'relayed_allowed' | 'asked_owner' | 'no_owner';
  policy: SenderPolicy | null;
  evidence?: string[];
}

/** Resolve the tenant owner (SA first, then AD) — the person who decides. */
async function resolveOwner(clientNumber: string): Promise<number | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE
       AND user_type IN ('SA','AD') ORDER BY user_type, id LIMIT 1`,
    clientNumber,
  ).catch(() => [] as any[]);
  return rows[0]?.id ? Number(rows[0].id) : null;
}

/**
 * Deterministic concern evidence. These are factual joins over the
 * owner's own data — presence checks, not judgment calls — so a regex/SQL
 * boundary is legitimate here (invariant §2.3 governs judgment, and
 * "does a delegation thread exist for this number" is not judgment).
 */
export async function gatherConcernEvidence(
  clientNumber: string,
  phone: string,
): Promise<string[]> {
  const evidence: string[] = [];
  const variants = whatsappPhoneVariants(phone);
  if (!variants.length) return evidence;
  const digits = variants[1]; // bare digits form

  const [thread, priorOutbound, facet] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM delegation_threads
        WHERE client_number = $1 AND counterpart_number_canonical LIKE '%' || $2
        LIMIT 1`,
      clientNumber, digits,
    ).catch(() => [] as any[]),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM whatsapp_messages
        WHERE client_number = $1 AND direction = 'outbound' AND from_number LIKE '%' || $2
        LIMIT 1`,
      clientNumber, digits,
    ).catch(() => [] as any[]),
    // The contact catalog lives in wiki_pages (page_type='entity_person')
    // with the number in metadata.phone — NOT in persons/person_facets.
    // Google Contacts import, WhatsApp ingest and manual entry all land
    // here, so this is the join that actually sees the owner's address
    // book. Same status filter as the Contacts screen: archived/deleted
    // rows are not evidence of concern.
    prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'entity_person'
          AND status NOT IN ('archived', 'inactive', 'deleted', 'contradicted')
          AND regexp_replace(COALESCE(metadata->>'phone', ''), '[^0-9]', '', 'g') LIKE '%' || $2
        LIMIT 1`,
      clientNumber, digits,
    ).catch(() => [] as any[]),
  ]);

  if (thread.length) evidence.push('delegation_thread');
  if (priorOutbound.length) evidence.push('prior_brain_outbound');
  if (facet.length) evidence.push('contact_phone_match');
  return evidence;
}

/**
 * Best-known human name for a phone, or null.
 *
 * Owner request 2026-08-04: the triage ask must name the person, not just
 * the number — "+92… (Hamna Latif) sent…" is answerable at a glance;
 * a bare number is not. Sources, in order of trust: the contact catalog
 * (wiki_pages entity_person, phone in metadata.phone — where the Google
 * Contacts import lands), then a WhatsApp connection display name.
 * Returns null rather than guessing — an unnamed sender is shown as the
 * number alone, never with an invented or closest-match name.
 */
export async function resolveSenderName(
  clientNumber: string,
  phone: string,
): Promise<string | null> {
  const variants = whatsappPhoneVariants(phone);
  if (!variants.length) return null;
  const digits = variants[1];
  try {
    // Contact catalog = wiki_pages(page_type='entity_person'), phone in
    // metadata.phone. This is where the Google Contacts import lands, so
    // a phone synced from the owner's Android address book resolves here.
    // Highest confidence first; archived/contradicted rows excluded.
    const person = await prisma.$queryRawUnsafe<any[]>(
      `SELECT title AS name
         FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'entity_person'
          AND status NOT IN ('archived', 'inactive', 'deleted', 'contradicted')
          AND regexp_replace(COALESCE(metadata->>'phone', ''), '[^0-9]', '', 'g') LIKE '%' || $2
        ORDER BY confidence DESC NULLS LAST, last_updated_at DESC
        LIMIT 1`,
      clientNumber, digits,
    );
    const name = String(person[0]?.name ?? '').trim();
    // A page titled with the bare number (no name known yet) is not a name.
    if (name && name.replace(/[^\d]/g, '') !== digits.replace(/[^\d]/g, '')) return name;

    const conn = await prisma.$queryRawUnsafe<any[]>(
      `SELECT display_name AS name FROM whatsapp_connections
        WHERE client_number = $1 AND regexp_replace(phone_number, '[^0-9]', '', 'g') LIKE '%' || $2
        LIMIT 1`,
      clientNumber, digits,
    );
    const connName = String(conn[0]?.name ?? '').trim();
    // Auto-learned @lid alias rows carry a synthetic label, not a person.
    if (connName && !/^auto-learned/i.test(connName)) return connName;
    return null;
  } catch (error: any) {
    log.warn('sender name lookup failed', { error: error?.message });
    return null;
  }
}

/** "+92300… (Hamna Latif)" when known, "+92300…" when not. */
export function describeSender(phone: string, name: string | null): string {
  return name ? `${phone} (${name})` : phone;
}

/**
 * Interpret the owner's answer to the triage ask. Strict unambiguous
 * forms are accepted directly (fast prefilter); anything else goes to the
 * LLM classifier — the regex is never the final boundary for an unclear
 * answer, it only fast-paths the exact ones.
 */
export async function interpretSenderDecision(
  answer: string,
  classify: (system: string, user: string) => Promise<string> =
    async (s, u) => (await (await import('../llmRouter')).callLLM(s, u, { timeoutMs: 8_000 })).text,
): Promise<'allow' | 'ignore' | 'unclear'> {
  const t = answer.trim().toLowerCase();
  if (/^(ignore|block|no|nahi|mat karo|ignore it|ignore him|ignore her)\b/.test(t)) return 'ignore';
  if (/^(reply|allow|yes|haan|respond|talk|reply to (him|her|them))\b/.test(t)) return 'allow';
  try {
    const raw = await classify(
      'You classify an owner\'s decision about whether their assistant should reply to a WhatsApp sender. ' +
      'Answer with exactly one word: ALLOW, IGNORE, or UNCLEAR. The owner may answer in English, Urdu, or Roman-Urdu. ' +
      'Only output IGNORE if the owner clearly wants the sender ignored/blocked; only ALLOW if they clearly want a reply/conversation.',
      `Owner's answer: "${answer.slice(0, 300)}"`,
    );
    const v = String(raw).trim().toUpperCase();
    if (v.startsWith('ALLOW')) return 'allow';
    if (v.startsWith('IGNORE')) return 'ignore';
    return 'unclear';
  } catch (error: any) {
    log.warn('sender decision classify failed', { error: error?.message });
    return 'unclear';
  }
}

/** Persist an owner decision (or evidence auto-allow). */
export async function decideSenderPolicy(args: {
  clientNumber: string;
  phone: string;
  ownerUserId: number;
  policy: SenderPolicy;
  decidedBy: 'owner_decision' | 'concern_evidence';
  evidence?: string[];
  note?: string;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO wa_sender_policy
       (client_number, phone, owner_user_id, policy, decided_by, decided_at, evidence, note, last_inbound_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6::jsonb, $7, NOW())
     ON CONFLICT (client_number, phone) DO UPDATE
       SET policy = $4, decided_by = $5, decided_at = NOW(),
           evidence = $6::jsonb, note = $7`,
    args.clientNumber, args.phone, args.ownerUserId, args.policy,
    args.decidedBy, JSON.stringify(args.evidence ?? []), args.note ?? null,
  );
}

/**
 * The door. Called for a non-registered inbound AFTER delegation capture
 * declined it. Never throws — a triage failure must not break the inbound
 * pipeline; the failure mode is "held as unknown", not "allowed in".
 */
export async function triageUnregisteredInbound(params: {
  clientNumber: string;
  fromNumber: string;
  body: string;
}): Promise<TriageOutcome> {
  // Hoisted out of the try so the DEF-060 fallback below can still reach the
  // owner when the main path throws. Scoping them inside the try is what made
  // "who do I tell?" unanswerable at the moment it mattered most.
  let ownerUserId: number | null = null;
  let senderName: string | null = null;
  try {
    ownerUserId = await resolveOwner(params.clientNumber);
    if (!ownerUserId) return { action: 'no_owner', policy: null };

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT policy FROM wa_sender_policy WHERE client_number = $1 AND phone = $2`,
      params.clientNumber, params.fromNumber,
    ).catch(() => [] as any[]);
    const policy = existing[0]?.policy as SenderPolicy | undefined;

    if (policy) {
      await prisma.$executeRawUnsafe(
        `UPDATE wa_sender_policy SET last_inbound_at = NOW() WHERE client_number = $1 AND phone = $2`,
        params.clientNumber, params.fromNumber,
      ).catch(() => undefined);
    }

    if (policy === 'ignored') {
      log.info('inbound dropped — owner standing ignore', { from: params.fromNumber });
      return { action: 'dropped_ignored', policy };
    }
    if (policy === 'pending') {
      // Ask-once: the owner already has the question; never re-prompt.
      log.info('inbound held — sender decision pending', { from: params.fromNumber });
      return { action: 'held_pending', policy };
    }

    if (policy === 'allowed') {
      const name = await resolveSenderName(params.clientNumber, params.fromNumber);
      await relayToOwner(params, ownerUserId, ['owner_allowed'], name);
      return { action: 'relayed_allowed', policy };
    }

    // No policy row — evidence check, then ask.
    // Assigns the hoisted binding rather than shadowing it, so the fallback
    // in the catch can still name the sender.
    const [evidence, resolvedName] = await Promise.all([
      gatherConcernEvidence(params.clientNumber, params.fromNumber),
      resolveSenderName(params.clientNumber, params.fromNumber),
    ]);
    senderName = resolvedName;
    if (evidence.length > 0) {
      await decideSenderPolicy({
        clientNumber: params.clientNumber, phone: params.fromNumber, ownerUserId,
        policy: 'allowed', decidedBy: 'concern_evidence', evidence,
      });
      await relayToOwner(params, ownerUserId, evidence, senderName);
      return { action: 'relayed_allowed', policy: 'allowed', evidence };
    }

    await decideSenderPolicy({
      clientNumber: params.clientNumber, phone: params.fromNumber, ownerUserId,
      policy: 'pending', decidedBy: 'owner_decision', note: 'awaiting owner triage answer',
    });
    const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
    await enqueueBrainPrompt({
      userId: ownerUserId,
      clientNumber: params.clientNumber,
      question:
        `${describeSender(params.fromNumber, senderName)} sent me a message: ` +
        `"${params.body.slice(0, 120)}". ` +
        `Should I reply to them, or ignore this number? (An ignore stays until you tell me otherwise.)`,
      // DEF-060 (2026-08-05): this said 'normal', which is not a Criticality.
      // The valid set is routine | high | top and the DB enforces it with a
      // CHECK constraint, so EVERY enqueue from this path failed with Postgres
      // 23514 and the inbound was silently "held". No owner has been asked
      // about an unknown sender since the constraint landed — the owner found
      // it as "Hamna responded and it didn't notify me".
      //
      // 'routine', not 'high': channelForCriticality escalates high to a voice
      // note or a business call, and a wrong number must never ring the owner.
      criticality: 'routine',
      dedupKey: `wa_sender_triage:${params.fromNumber}`,
      sideEffect: {
        kind: 'wa_sender_policy_decision',
        data: { phone: params.fromNumber, clientNumber: params.clientNumber, ownerUserId },
      },
      metadata: { source: 'sender_triage', from: params.fromNumber },
      // No `as any`. The cast is what let 'normal' past the compiler and left
      // the database to reject it at runtime, five days later, in a swallowed
      // catch. A type error here is worth more than a clean-looking call site.
    });
    log.info('owner asked about unknown sender', { from: params.fromNumber });
    return { action: 'asked_owner', policy: 'pending' };
  } catch (error: any) {
    log.warn('sender triage failed — inbound held', { error: error?.message, from: params.fromNumber });

    // DEF-060 — a failure HERE must not mean the owner hears nothing.
    //
    // For five days every enqueue on this path threw (criticality 'normal'
    // violated a CHECK constraint) and the only trace was this warn line. Real
    // people messaged and the owner was never told, because the sole route to
    // him was a queue that was rejecting the insert.
    //
    // brainContactsUser is a direct send and does not touch brain_prompt_queue,
    // so it survives exactly the class of failure that caused this. A notice
    // that says less is worth far more than silence.
    try {
      const { brainContactsUser } = await import('../notifications/brainOutboundService');
      const who = describeSender(params.fromNumber, senderName);
      await brainContactsUser({
        userId: ownerUserId,
        kind: 'wa_counterpart_message',
        summary: `WhatsApp from ${who}`,
        body: `${who} messaged me:\n"${params.body.slice(0, 300)}"\n\n`
          + 'I could not queue this for a proper decision, so I am passing it straight on. '
          + 'Tell me to reply or to ignore that number.',
        urgency: 'normal',
        dedupKey: `wa_triage_fallback:${params.fromNumber}`,
      } as any);
      log.info('triage fallback relayed direct to owner', { from: params.fromNumber });
    } catch (fallbackError: any) {
      log.error('triage fallback ALSO failed — owner not informed', {
        from: params.fromNumber, error: fallbackError?.message,
      });
    }
    return { action: 'held_pending', policy: null };
  }
}

/** Surface an allowed sender's message to the owner (Phase 2 replaces
 *  this relay with the scoped counterpart conversation). */
async function relayToOwner(
  params: { clientNumber: string; fromNumber: string; body: string },
  ownerUserId: number,
  evidence: string[],
  senderName: string | null,
): Promise<void> {
  const { brainContactsUser } = await import('../notifications/brainOutboundService');
  const who = describeSender(params.fromNumber, senderName);
  await brainContactsUser({
    userId: ownerUserId,
    kind: 'wa_counterpart_message',
    summary: `WhatsApp from ${who}`,
    body:
      `${who} — ${evidence.join(', ') || 'allowed'} — says:\n` +
      `"${params.body.slice(0, 500)}"`,
    urgency: 'normal',
    dedupKey: `wa_counterpart:${params.fromNumber}:${params.body.slice(0, 40)}`,
  } as any).catch((error: any) => {
    log.warn('counterpart relay to owner failed', { error: error?.message });
  });
}
