/**
 * promptBlockService — composable prompt fragments stored as data.
 *
 * Phase 1 of the reasoning-first / data-driven refactor (2026-05-22).
 * Replaces (over the migration phases) the hardcoded TS constants in
 * brainComposer.ts: CORE_CONVERSATIONAL_RULES, ACTION_RULES,
 * FACTUAL_HONESTY_RULES, AUTHORITY_RULES, SURFACE_EXCLUSIVITY_RULES,
 * DAY_BRIEF_FORMAT_RULES, OUTPUT_SHAPE_RULES, and the communication
 * contract added in 373ef31.
 *
 * Public API:
 *   getApplicableBlocks(userId, ctx) — returns ordered list of blocks
 *     for the given turn context.
 *   assemblePrompt(blocks) — concatenates by priority into a single
 *     prompt string.
 *   getById, getByName — for Settings UI.
 *   create / update / archive — for user-proposed blocks (with
 *     approval workflow).
 *
 * Selection logic in getApplicableBlocks:
 *   1. system + tenant + user scope rows, is_active=true
 *   2. filter by whenToInclude.intent if specified
 *   3. filter by whenToInclude.requiresActionTurn vs ctx.isActionTurn
 *   4. filter by whenToInclude.channels vs ctx.channel
 *   5. user-scope blocks override system blocks of the same NAME
 *      (so a user-confirmed style override beats the system default).
 *   6. sort by priority descending → assembled in that order.
 */
import prisma from '../../db/prisma';

export type BlockScope = 'system' | 'tenant' | 'user';
export type BlockSource = 'seeded' | 'user_proposed' | 'system' | 'inferred';

export interface PromptBlockRecord {
  id: string;
  name: string;
  content: string;
  scope: BlockScope;
  priority: number;
  source: BlockSource;
  whenToInclude: WhenToIncludeRule | null;
  isActive: boolean;
  approvedAt: Date | null;
  updatedAt: Date;
}

export interface WhenToIncludeRule {
  intent?: string[];                  // e.g. ['action', 'factual']
  requiresActionTurn?: boolean;
  channels?: Array<'web' | 'whatsapp'>;
  languageHint?: string;
}

export interface BlockContext {
  intent?: string;
  isActionTurn?: boolean;
  channel?: 'web' | 'whatsapp';
}

/** Get all blocks applicable for the given user + context, sorted
 *  by priority descending. User-scope blocks of the same name as a
 *  system block REPLACE (not append) the system one — that's how
 *  user overrides work. */
export async function getApplicableBlocks(
  userId: number,
  clientNumber: string,
  ctx: BlockContext = {},
): Promise<PromptBlockRecord[]> {
  // Pull system, tenant (matching clientNumber), user-scope rows.
  const rows = await (prisma as any).promptBlock.findMany({
    where: {
      isActive: true,
      OR: [
        { scope: 'system' },
        { scope: 'tenant', clientNumber },
        { scope: 'user', userId, approvedAt: { not: null } },
      ],
    },
    orderBy: { priority: 'desc' },
  });
  // Filter by whenToInclude.
  const filtered = rows.filter((r: any) => passesContext(r.whenToInclude, ctx));
  // Override layer: user-scope blocks of the same NAME replace system/tenant ones.
  const userOverrides = new Map<string, any>();
  for (const r of filtered) {
    if (r.scope === 'user') userOverrides.set(r.name, r);
  }
  const result: any[] = [];
  const seenNames = new Set<string>();
  for (const r of filtered) {
    if (r.scope === 'user') {
      if (!seenNames.has(r.name)) {
        result.push(r);
        seenNames.add(r.name);
      }
    } else {
      if (userOverrides.has(r.name)) continue; // user override wins
      if (!seenNames.has(r.name)) {
        result.push(r);
        seenNames.add(r.name);
      }
    }
  }
  return result.map(toRecord);
}

/** Concatenate blocks into a single system prompt string. Each
 *  block is rendered as-is; the priority order from the query is
 *  preserved. A blank line separates blocks for readability. */
export function assemblePrompt(blocks: PromptBlockRecord[]): string {
  return blocks.map((b) => b.content.trim()).filter(Boolean).join('\n\n');
}

/** Look up a single block by name + scope + (user scope) owner. */
export async function getBlockByName(
  name: string,
  scope: BlockScope,
  userId?: number,
): Promise<PromptBlockRecord | null> {
  const row = await (prisma as any).promptBlock.findFirst({
    where: { name, scope, ...(scope === 'user' ? { userId: userId ?? -1 } : {}) },
  });
  return row ? toRecord(row) : null;
}

/** Insert a new prompt block. For user_proposed blocks, leaves
 *  approvedAt=null so it doesn't apply until user confirms. */
export async function createBlock(args: {
  clientNumber: string | null;
  userId: number | null;
  name: string;
  content: string;
  scope: BlockScope;
  priority?: number;
  whenToInclude?: WhenToIncludeRule | null;
  source: BlockSource;
  preApproved?: boolean;
}): Promise<PromptBlockRecord> {
  const row = await (prisma as any).promptBlock.create({
    data: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      name: args.name,
      content: args.content,
      scope: args.scope,
      priority: args.priority ?? 100,
      whenToInclude: (args.whenToInclude as any) ?? null,
      source: args.source,
      approvedAt: args.preApproved ? new Date() : null,
    },
  });
  return toRecord(row);
}

/** Approve a previously-proposed user block. Called from Settings UI. */
export async function approveBlock(blockId: string, userId: number): Promise<void> {
  await (prisma as any).promptBlock.update({
    where: { id: blockId },
    data: { approvedAt: new Date() },
  });
}

/** Archive (soft-delete) a block. */
export async function archiveBlock(blockId: string): Promise<void> {
  await (prisma as any).promptBlock.update({
    where: { id: blockId },
    data: { isActive: false },
  });
}

// ─── Internal ────────────────────────────────────────────────────

function passesContext(rule: any, ctx: BlockContext): boolean {
  if (!rule || typeof rule !== 'object') return true;
  if (Array.isArray(rule.intent) && rule.intent.length > 0) {
    if (!ctx.intent || !rule.intent.includes(ctx.intent)) return false;
  }
  if (typeof rule.requiresActionTurn === 'boolean') {
    if (rule.requiresActionTurn !== !!ctx.isActionTurn) return false;
  }
  if (Array.isArray(rule.channels) && rule.channels.length > 0) {
    if (!ctx.channel || !rule.channels.includes(ctx.channel)) return false;
  }
  return true;
}

function toRecord(row: any): PromptBlockRecord {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    scope: row.scope as BlockScope,
    priority: row.priority,
    source: row.source as BlockSource,
    whenToInclude: (row.whenToInclude as WhenToIncludeRule | null) ?? null,
    isActive: row.isActive,
    approvedAt: row.approvedAt ?? null,
    updatedAt: row.updatedAt,
  };
}
