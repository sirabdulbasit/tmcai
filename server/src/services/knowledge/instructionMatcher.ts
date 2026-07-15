/**
 * Instruction matcher — runs active standing instructions against every
 * inbound feed event. Lives next to instructionService so the matching
 * logic stays close to the data shape.
 *
 * Matching is DELIBERATELY simple:
 *   - standing_rule / watchpoint / update_request / follow_up with a
 *     `subject` → case-insensitive substring hit against sender name,
 *     sender email, subject, snippet or body.
 *   - scheduled / todo have no subject → skipped here (cognitive engine
 *     handles their time-based firing).
 *
 * Why simple: the goal at this layer is recall, not precision. A false
 * positive here surfaces a tagged item to Brain; Brain decides what to
 * do with it. A false negative means the user's standing rule is
 * invisible, which is the real failure mode.
 */
import {
  getActiveInstructions,
  type ActiveInstructionRow,
  type InstructionKind,
} from './instructionService';

export interface InstructionMatchInput {
  senderEmail?: string | null;
  senderName?: string | null;
  subject?: string | null;
  snippet?: string | null;
  body?: string | null;
}

export interface InstructionMatch {
  instruction: ActiveInstructionRow;
  matchedOn: 'sender' | 'subject' | 'body';
}

const MATCH_KINDS: InstructionKind[] = [
  'standing_rule', 'watchpoint', 'follow_up', 'update_request',
];

function hay(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' \n ').toLowerCase();
}

/**
 * Find every active instruction whose `subject` appears in the event.
 * Returns matches with the locus (sender / subject / body) so callers
 * can decide how to react. Empty array = no active rules apply.
 */
export async function matchInstructionsForEvent(
  clientNumber: string,
  userId: number,
  input: InstructionMatchInput,
): Promise<InstructionMatch[]> {
  const active = await getActiveInstructions(clientNumber, userId, 50);
  if (active.length === 0) return [];

  const senderBlob = hay([input.senderEmail, input.senderName]);
  const subjectBlob = hay([input.subject]);
  const bodyBlob = hay([input.snippet, input.body]);

  const out: InstructionMatch[] = [];
  for (const ins of active) {
    if (!MATCH_KINDS.includes(ins.kind)) continue;
    const needle = (ins.subject ?? '').trim().toLowerCase();
    if (needle.length < 3) continue;  // avoid matching tiny tokens like "IT"

    if (senderBlob.includes(needle))       { out.push({ instruction: ins, matchedOn: 'sender' });  continue; }
    if (subjectBlob.includes(needle))      { out.push({ instruction: ins, matchedOn: 'subject' }); continue; }
    if (bodyBlob.includes(needle))         { out.push({ instruction: ins, matchedOn: 'body' });    continue; }
  }
  return out;
}

/** Convenience — the single highest-priority match. Watchpoints take
 *  precedence over standing rules (alerting beats routing), then
 *  follow-ups. Tie-break by creation order (newest first). */
export function pickPrimaryMatch(matches: InstructionMatch[]): InstructionMatch | null {
  if (matches.length === 0) return null;
  const rank: Record<InstructionKind, number> = {
    watchpoint: 4,
    standing_rule: 3,
    follow_up: 2,
    update_request: 1,
    scheduled: 0,
    todo: 0,
    unknown: 0,
  };
  const sorted = [...matches].sort((a, b) => {
    const rd = rank[b.instruction.kind] - rank[a.instruction.kind];
    if (rd !== 0) return rd;
    return (b.instruction.createdAt ?? '').localeCompare(a.instruction.createdAt ?? '');
  });
  return sorted[0];
}

// ─── Veto semantics ─────────────────────────────────────────────
//
// A veto short-circuits Brain's autonomous action and forces the event
// back to the human. Two triggers:
//
//   1. An instruction whose action text explicitly says "ask first" /
//      "notify me" / "never auto" / "approve" / "confirm" / "manual".
//      These are user-authored "stop and check" rules.
//   2. A matching watchpoint (kind='watchpoint'). By definition a
//      watchpoint is "alert me if X happens" — auto-dispatch of an X
//      event defeats the purpose of the watchpoint.
//
// A veto may be **global** (instruction has no subject, so it applies
// to every event) or **specific** (subject matches event). Global
// vetoes are the "never auto-send anything without my approval" case.

const VETO_ACTION_PATTERNS: RegExp[] = [
  /\bask (?:me|first)\b/i,
  /\bapprov(?:e|al)\b/i,
  /\bconfirm\b/i,
  /\bcheck with me\b/i,
  /\bnever auto(?:[- ]?send|[- ]?reply|[- ]?forward|[- ]?delegate)?\b/i,
  /\bdon'?t auto(?:[- ]?send|[- ]?reply|[- ]?forward|[- ]?delegate)?\b/i,
  /\bdo not auto(?:[- ]?send|[- ]?reply|[- ]?forward|[- ]?delegate)?\b/i,
  /\bmanual(?:ly)?\b/i,
  /\bmy approval\b/i,
  /\bmy decision\b/i,
  /\breview first\b/i,
  /\bnotify me\b/i,
  /\balert me\b/i,
  /\bhold (?:it|for me|for approval)\b/i,
  /\bflag (?:it|for me)\b/i,
];

/**
 * Does this instruction's action text say "don't auto, ask me first"?
 * Watchpoints always return true — they're alerting by construction.
 */
function isVetoInstruction(ins: ActiveInstructionRow): boolean {
  if (ins.kind === 'watchpoint') return true;
  if (ins.kind !== 'standing_rule') return false;
  const text = `${ins.action ?? ''} ${ins.originalText ?? ''}`;
  return VETO_ACTION_PATTERNS.some((p) => p.test(text));
}

export interface VetoResult {
  instruction: ActiveInstructionRow;
  reason: 'subject_match' | 'global_rule' | 'watchpoint_match';
}

/**
 * Does any active instruction veto auto-execution on this event?
 *
 *   - If an instruction with veto-phrase action has NO subject, it
 *     applies globally to every event (→ 'global_rule').
 *   - If a veto-phrase instruction's subject hits the event, 'subject_match'.
 *   - If a watchpoint's subject hits the event, 'watchpoint_match'.
 *
 * Returns the single highest-priority veto (watchpoint > global > subject-specific)
 * or null when no veto applies.
 */
export async function findVetoForEvent(
  clientNumber: string,
  userId: number,
  input: InstructionMatchInput,
): Promise<VetoResult | null> {
  const active = await getActiveInstructions(clientNumber, userId, 50);
  if (active.length === 0) return null;

  const senderBlob = hay([input.senderEmail, input.senderName]);
  const subjectBlob = hay([input.subject]);
  const bodyBlob = hay([input.snippet, input.body]);
  const eventBlob = `${senderBlob} ${subjectBlob} ${bodyBlob}`;

  const vetoes: VetoResult[] = [];

  for (const ins of active) {
    if (!isVetoInstruction(ins)) continue;
    const needle = (ins.subject ?? '').trim().toLowerCase();

    // Global: veto phrase with no subject → applies to every event.
    if (!needle && ins.kind === 'standing_rule') {
      vetoes.push({ instruction: ins, reason: 'global_rule' });
      continue;
    }

    if (!needle) continue;
    if (!eventBlob.includes(needle)) continue;

    vetoes.push({
      instruction: ins,
      reason: ins.kind === 'watchpoint' ? 'watchpoint_match' : 'subject_match',
    });
  }

  if (vetoes.length === 0) return null;

  const rank: Record<VetoResult['reason'], number> = {
    watchpoint_match: 3,
    global_rule: 2,
    subject_match: 1,
  };
  vetoes.sort((a, b) => rank[b.reason] - rank[a.reason]);
  return vetoes[0];
}
