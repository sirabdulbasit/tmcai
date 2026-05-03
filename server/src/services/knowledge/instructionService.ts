/**
 * Instructions — the 6th layer of MyOS.
 *
 * Standing orders the user has given Brain that Brain MUST respect across
 * every reasoning turn and every autonomous action. Different from Feed
 * (which is what happened) and different from ShadowRules (which are
 * learned from behaviour). Instructions are explicit human intent.
 *
 * Examples:
 *   "Always delegate Raazia's emails to Asad"                  (standing_rule)
 *   "Alert me immediately if anyone mentions EXIM"             (watchpoint)
 *   "Follow up with Fahim if no reply by Thursday"            (follow_up)
 *   "Send me a weekly summary every Friday 5pm"                (scheduled)
 *   "Call Kate next Wednesday"                                 (todo)
 *   "Update me when Project 846 hits UAT"                      (update_request)
 *
 * Storage: wiki_pages with pageType='instruction'. Metadata carries the
 * structured form; body is the natural-language original so Brain can
 * quote it back when citing. Linked into the graph so clicking "Raazia"
 * in her entity_person page shows any instruction that mentions her.
 *
 * Lifecycle:
 *   status=active    → respected by every composer / triage / cognitive turn
 *   status=paused    → user pressed pause, Brain reads but doesn't act
 *   status=fulfilled → one-shot done (e.g. a todo completed)
 *   status=archived  → user removed
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('instruction');

export type InstructionKind =
  | 'standing_rule' | 'watchpoint' | 'follow_up'
  | 'scheduled' | 'todo' | 'update_request' | 'unknown';

export type InstructionStatus = 'active' | 'paused' | 'fulfilled' | 'archived';

/**
 * Scope of an instruction.
 *   'client' → tenant-wide. Visible to every user in the clientNumber. Only
 *              SA/AD can create or modify. Intended for compliance, brand
 *              voice, delegation policy, SLA rules.
 *   'user'   → per-user. Visible only to the author. Default for
 *              personal preferences, watchpoints, follow-ups.
 *
 * The composer renders the two blocks separately so Brain can weight
 * client rules as organizational-authoritative and user rules as
 * personal-preference.
 */
export type InstructionScope = 'client' | 'user';

export interface StructuredInstruction {
  kind: InstructionKind;
  title: string;
  originalText: string;
  /** Who / what to watch. Free-form. Example: "Raazia", "EXIM", "Project 846". */
  subject?: string | null;
  /** When to fire (ISO) OR null for standing / watchpoint. */
  dueAt?: string | null;
  /** Freeform condition — Brain interprets. "no reply by Thursday", "if urgent". */
  condition?: string | null;
  /** Action implied — "delegate to Asad", "notify me", "draft reply", "add to open items". */
  action?: string | null;
}

const PARSER_SYSTEM = `You parse natural-language commands from an executive into a STRUCTURED instruction that an AI assistant can act on. Output ONLY a JSON object with this shape:

{
  "kind": "standing_rule" | "watchpoint" | "follow_up" | "scheduled" | "todo" | "update_request" | "unknown",
  "title": "short 3-8 word label",
  "subject": "who or what is being watched (name/email/topic/id, or null)",
  "dueAt": "ISO timestamp if a specific time was named, otherwise null",
  "condition": "short condition phrase in the user's words, or null",
  "action": "the action Brain should take (delegate to X / notify me / draft reply / remind me / add open item), or null"
}

Rules:
- kind=standing_rule when it's an "always do X" rule (no deadline, no one-off)
- kind=watchpoint when it's "alert/notify/tell me IF X happens"
- kind=follow_up when it names a person/topic AND a deadline
- kind=scheduled when it's on a cron-like schedule ("every Friday", "daily at 9am")
- kind=todo when it's a one-off personal task the user wants to do themselves
- kind=update_request when it's "update me when X changes"
- Use kind=unknown if you truly can't tell
- Never invent times or subjects. If not stated, return null.

Examples:
Input: "Always delegate Raazia's emails to Asad"
Output: {"kind":"standing_rule","title":"Delegate Raazia's emails to Asad","subject":"Raazia","dueAt":null,"condition":"email from Raazia","action":"delegate to Asad"}

Input: "Remind me to call Kate next Wednesday"
Output: {"kind":"todo","title":"Call Kate","subject":"Kate","dueAt":null,"condition":"next Wednesday","action":"remind me"}

Input: "Notify me immediately if anyone mentions EXIM"
Output: {"kind":"watchpoint","title":"EXIM mentions alert","subject":"EXIM","dueAt":null,"condition":"anyone mentions EXIM","action":"notify me immediately"}`;

export async function parseInstruction(
  text: string,
  userId: number,
  clientNumber: string,
): Promise<StructuredInstruction> {
  const fallback: StructuredInstruction = {
    kind: 'unknown',
    title: text.slice(0, 60),
    originalText: text,
    subject: null, dueAt: null, condition: null, action: null,
  };
  try {
    const r = await callLLM(PARSER_SYSTEM, text, {
      maxTokens: 320,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId, clientNumber, purpose: 'instruction_parse',
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const obj = JSON.parse(m[0]);
    const kind: InstructionKind =
      ['standing_rule','watchpoint','follow_up','scheduled','todo','update_request','unknown'].includes(obj.kind)
        ? obj.kind : 'unknown';
    return {
      kind,
      title: String(obj.title ?? text).slice(0, 120),
      originalText: text,
      subject: obj.subject ? String(obj.subject).slice(0, 200) : null,
      dueAt: obj.dueAt || null,
      condition: obj.condition ? String(obj.condition).slice(0, 300) : null,
      action: obj.action ? String(obj.action).slice(0, 300) : null,
    };
  } catch (err: any) {
    log.warn('parseInstruction failed', { error: err.message });
    return fallback;
  }
}

export async function createInstructionFromText(
  clientNumber: string,
  userId: number,
  text: string,
  scope: InstructionScope = 'user',
): Promise<{ id: string; structured: StructuredInstruction; scope: InstructionScope } | null> {
  const clean = text.trim();
  if (!clean) return null;

  const structured = await parseInstruction(clean, userId, clientNumber);

  const body = [
    `# ${structured.title}`,
    '',
    `**Scope:** ${scope}`,
    `**Kind:** ${structured.kind}`,
    `**Status:** active`,
    `**Given:** ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    structured.subject ? `**Subject:** ${structured.subject}` : '',
    structured.dueAt ? `**Due:** ${structured.dueAt}` : '',
    structured.condition ? `**Condition:** ${structured.condition}` : '',
    structured.action ? `**Action:** ${structured.action}` : '',
    '',
    '## Original text',
    clean,
  ].filter(Boolean).join('\n');

  const metadata = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope,
    authoredBy: `user:${userId}`,
    status: 'active' as InstructionStatus,
    kind: structured.kind,
    subject: structured.subject,
    dueAt: structured.dueAt,
    condition: structured.condition,
    action: structured.action,
    originalText: clean,
    createdAt: new Date().toISOString(),
    lastFiredAt: null as string | null,
    fireCount: 0,
  };

  try {
    const created = await prisma.wikiPage.create({
      data: {
        clientNumber, userId,
        pageType: 'instruction', title: structured.title.slice(0, 300),
        bodyMarkdown: body, metadata: metadata as any,
        storage: 'postgres', status: 'active',
        lastUpdatedBy: 'instruction_service',
      },
    });
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(created.id);
      } catch { /* best effort */ }
    })();
    log.info('instruction created', { userId, scope, kind: structured.kind, id: created.id, title: structured.title });
    // Bust the per-user instructions cache so the composer envelope
    // sees the new rule on the next turn instead of a 30s-stale list.
    void (async () => {
      try {
        const { invalidate } = await import('../../utils/redisClient');
        if (scope === 'client') {
          // Client-scope rules are visible to every user — invalidate all.
          await invalidate(`instructions:${clientNumber}:*`);
        } else {
          await invalidate(`instructions:${clientNumber}:${userId}`);
        }
      } catch { /* best effort */ }
    })();
    return { id: created.id, structured, scope };
  } catch (err: any) {
    log.warn('createInstruction failed', { error: err.message });
    return null;
  }
}

export interface ActiveInstructionRow {
  id: string;
  title: string;
  kind: InstructionKind;
  scope: InstructionScope;
  subject: string | null;
  dueAt: string | null;
  condition: string | null;
  action: string | null;
  originalText: string;
  createdAt: string;
}

/**
 * Active instructions visible to `userId` in `clientNumber`.
 * Returns BOTH scopes:
 *   - every client-scope instruction in the tenant
 *   - every user-scope instruction the user authored
 *
 * Client-scope rules come first so the renderer (and Brain) reads them
 * as the organizational-authoritative layer; user-scope rules follow
 * as personal preferences stacked on top.
 */
export async function getActiveInstructions(
  clientNumber: string,
  userId: number,
  limit = 30,
): Promise<ActiveInstructionRow[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, metadata->>'kind' AS kind,
            COALESCE(metadata->>'scope', 'user') AS scope,
            metadata->>'subject' AS subject, metadata->>'dueAt' AS "dueAt",
            metadata->>'condition' AS condition, metadata->>'action' AS action,
            metadata->>'originalText' AS "originalText",
            metadata->>'createdAt' AS "createdAt"
       FROM wiki_pages
      WHERE client_number = $1
        AND page_type = 'instruction'
        AND status = 'active'
        AND metadata->>'status' = 'active'
        AND (
          COALESCE(metadata->>'scope', 'user') = 'client'
          OR user_id = $2
        )
      ORDER BY (COALESCE(metadata->>'scope', 'user') = 'client') DESC,
               (metadata->>'createdAt') DESC
      LIMIT $3`,
    clientNumber, userId, limit,
  ).catch(() => []);
  return rows as ActiveInstructionRow[];
}

/** Render active instructions as a markdown block Brain can drop into
 *  its compose prompt. Two subsections (client then user) so Brain can
 *  weight client compliance/brand rules as organizational-authoritative
 *  and user rules as personal preferences. Empty sections are skipped. */
export function renderInstructionsBlock(rows: ActiveInstructionRow[]): string {
  if (rows.length === 0) return '';
  const clientRules = rows.filter((r) => r.scope === 'client');
  const userRules = rows.filter((r) => r.scope !== 'client');
  const lines: string[] = [];
  lines.push('## Standing instructions (non-negotiable)');
  lines.push('These are explicit orders. Respect every one in your answer and any action you take. Client rules are organizational policy and override conflicting user preferences.');

  const renderRow = (r: ActiveInstructionRow): string => {
    const extras: string[] = [];
    if (r.subject)   extras.push(`subject: ${r.subject}`);
    if (r.condition) extras.push(`condition: ${r.condition}`);
    if (r.action)    extras.push(`action: ${r.action}`);
    if (r.dueAt)     extras.push(`due: ${r.dueAt}`);
    return `- [${r.kind}] **${r.title}** — ${r.originalText}${extras.length ? `  (${extras.join('; ')})` : ''}`;
  };

  if (clientRules.length > 0) {
    lines.push('');
    lines.push('### Client rules (tenant-wide — compliance, brand voice, delegation policy)');
    for (const r of clientRules) lines.push(renderRow(r));
  }
  if (userRules.length > 0) {
    lines.push('');
    lines.push('### User rules (personal — only this user)');
    for (const r of userRules) lines.push(renderRow(r));
  }
  return lines.join('\n');
}

export async function updateInstructionStatus(
  clientNumber: string,
  userId: number,
  id: string,
  status: InstructionStatus,
  opts: { isAdmin?: boolean } = {},
): Promise<{ ok: boolean; reason?: string }> {
  try {
    // Client-scope rules are tenant-wide; any user may own the row, but
    // only admins (SA/AD) can mutate. User-scope rules may only be
    // mutated by their author.
    const page = await prisma.wikiPage.findFirst({
      where: { id, clientNumber, pageType: 'instruction' },
      select: { id: true, metadata: true, userId: true },
    });
    if (!page) return { ok: false, reason: 'not found' };
    const meta: any = page.metadata ?? {};
    const scope: InstructionScope = meta.scope === 'client' ? 'client' : 'user';
    if (scope === 'client') {
      if (!opts.isAdmin) return { ok: false, reason: 'client-scope instructions require admin' };
    } else {
      if (page.userId !== userId) return { ok: false, reason: 'not your instruction' };
    }
    meta.status = status;
    await prisma.wikiPage.update({
      where: { id: page.id },
      data: {
        metadata: meta as any,
        status: status === 'archived' ? 'deleted' : 'active',
        lastUpdatedAt: new Date(),
        lastUpdatedBy: 'instruction_service',
      },
    });
    void (async () => {
      try {
        const { invalidate } = await import('../../utils/redisClient');
        await invalidate(`instructions:${clientNumber}:*`);
      } catch { /* best effort */ }
    })();
    return { ok: true };
  } catch (err: any) {
    log.warn('updateInstructionStatus failed', { id, error: err.message });
    return { ok: false, reason: err.message };
  }
}
