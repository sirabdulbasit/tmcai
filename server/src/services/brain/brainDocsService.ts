/**
 * Typed Brain Docs — canonical replay/audit store for every Brain output.
 *
 * v16's `RiskFlagDoc / MorningBriefDoc / AskInvocationDoc / ProposalDoc /
 * ThoughtObject` pattern lands here as one table (`brain_docs`) keyed by
 * doc_type + version. Every Brain reasoning pass — synchronous or async —
 * writes one row through `writeDoc()`. That row is:
 *   - **typed**:     doc_type narrows the shape of `output`
 *   - **versioned**: version auto-bumps on input change so audit history
 *                    survives intra-day re-runs
 *   - **replayable**: input_summary + inputs_hash + source_event_ids
 *                     let any consumer re-derive the run later
 *   - **chainable**: superseded_by points at the doc that replaced this
 *                    one, giving a navigable history graph
 *
 * Specialized read-projections (e.g. RiskFlagDoc) stay; they're
 * denormalized for fast UI queries and are cross-linked via
 * `brain_docs.projection_id`.
 */
import crypto from 'crypto';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('brain-docs');

export type BrainDocType =
  | 'morning_brief'
  | 'risk_radar'
  | 'ask_invocation'
  | 'proposal'
  | 'thought'
  | 'weekly_review'
  | 'pattern_finding'
  | 'shadow_calibration'
  | 'criticality_review';

export type BrainDocStatus = 'active' | 'superseded' | 'failed' | 'draft';

export interface BrainDoc {
  id: string;
  clientNumber: string;
  userId: number;
  docType: BrainDocType;
  version: number;
  status: BrainDocStatus;
  inputsHash: string | null;
  inputSummary: Record<string, unknown>;
  sourceEventIds: string[];
  output: Record<string, unknown>;
  prose: string | null;
  summary: string | null;
  model: string | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  generationMs: number | null;
  error: string | null;
  supersededById: string | null;
  createdAt: Date;
  projectionId: string | null;
}

export interface WriteDocInput {
  clientNumber: string;
  userId: number;
  docType: BrainDocType;
  /** Stable scope key (e.g. '2026-04-28' for daily docs, threadId for ask).
   *  Combined with docType to form the deterministic id. Optional —
   *  omit and we'll generate a uuid-like id. */
  scopeKey?: string;
  /** Canonical input summary — what fed this run. The hash is derived
   *  from this for cache-hit detection. */
  inputSummary?: Record<string, unknown>;
  sourceEventIds?: string[];
  output: Record<string, unknown>;
  prose?: string | null;
  summary?: string | null;
  model?: string | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  generationMs?: number | null;
  /** When provided, link this doc to a specialized read-projection row
   *  (e.g. risk_flag_docs.id). UI consumers read the projection; replay
   *  / audit consumers read brain_docs. */
  projectionId?: string | null;
}

/**
 * Write or version-bump a typed Brain Doc.
 *
 * Behavior:
 *   - If no prior doc exists for (client, user, type, scopeKey): version=1.
 *   - If a prior doc exists with the SAME inputs_hash and status='active':
 *     return the existing doc unchanged (cache hit; caller can short-circuit).
 *   - If a prior doc exists with DIFFERENT inputs: mark prior as superseded,
 *     write a new row with version+1, and chain via supersededBy.
 *
 * The id format `${docType}:${client}:${user}:${scopeKey}:v${version}`
 * is deterministic so a given run always yields the same row.
 */
export async function writeDoc(input: WriteDocInput): Promise<{ doc: BrainDoc; cacheHit: boolean }> {
  const inputSummary = input.inputSummary ?? {};
  const inputsHash = hashInputs(inputSummary);
  const scopeKey = input.scopeKey ?? new Date().toISOString().slice(0, 10);

  // Check for an existing active doc for this logical (type, scope).
  const prior = await prisma.brainDoc.findFirst({
    where: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      docType: input.docType,
      status: 'active',
      id: { startsWith: `${input.docType}:${input.clientNumber}:${input.userId}:${scopeKey}:` },
    },
    orderBy: { version: 'desc' },
  });

  // Cache hit — same inputs as the latest active doc, return unchanged.
  if (prior && prior.inputsHash && prior.inputsHash === inputsHash) {
    return { doc: prior as unknown as BrainDoc, cacheHit: true };
  }

  const nextVersion = prior ? prior.version + 1 : 1;
  const newId = `${input.docType}:${input.clientNumber}:${input.userId}:${scopeKey}:v${nextVersion}`;

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.brainDoc.create({
      data: {
        id: newId,
        clientNumber: input.clientNumber,
        userId: input.userId,
        docType: input.docType,
        version: nextVersion,
        status: 'active',
        inputsHash,
        inputSummary: inputSummary as object,
        sourceEventIds: input.sourceEventIds ?? [],
        output: input.output as object,
        prose: input.prose ?? null,
        summary: input.summary ?? null,
        model: input.model ?? null,
        tokensInput: input.tokensInput ?? null,
        tokensOutput: input.tokensOutput ?? null,
        generationMs: input.generationMs ?? null,
        projectionId: input.projectionId ?? null,
      },
    });
    if (prior) {
      await tx.brainDoc.update({
        where: { id: prior.id },
        data: { status: 'superseded', supersededById: row.id },
      });
    }
    return row;
  });

  log.info('brain_doc written', {
    clientNumber: input.clientNumber,
    userId: input.userId,
    docType: input.docType,
    version: nextVersion,
    cacheHit: false,
    superseded: prior?.id ?? null,
  });
  return { doc: created as unknown as BrainDoc, cacheHit: false };
}

/** Latest active doc of a given type for a user. */
export async function getLatest(
  clientNumber: string,
  userId: number,
  docType: BrainDocType,
): Promise<BrainDoc | null> {
  const row = await prisma.brainDoc.findFirst({
    where: { clientNumber, userId, docType, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  return (row as unknown as BrainDoc) ?? null;
}

/** Recent docs of a type, including superseded versions. */
export async function getHistory(
  clientNumber: string,
  userId: number,
  docType: BrainDocType,
  limit = 30,
): Promise<BrainDoc[]> {
  const rows = await prisma.brainDoc.findMany({
    where: { clientNumber, userId, docType },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows as unknown as BrainDoc[];
}

/** Read a single doc by id with strict tenant + user ACL. */
export async function getById(
  clientNumber: string,
  userId: number,
  id: string,
): Promise<BrainDoc | null> {
  const row = await prisma.brainDoc.findUnique({ where: { id } });
  if (!row) return null;
  if (row.clientNumber !== clientNumber || row.userId !== userId) return null;
  return row as unknown as BrainDoc;
}

/** Read every Brain Doc that cites a given feed event (audit / regression). */
export async function findBySourceEvent(
  clientNumber: string,
  feedEventId: string,
  limit = 50,
): Promise<BrainDoc[]> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM brain_docs
      WHERE client_number = $1
        AND $2 = ANY(source_event_ids)
      ORDER BY created_at DESC
      LIMIT $3`,
    clientNumber, feedEventId, limit,
  ).catch(() => [] as any[]);
  return rows as unknown as BrainDoc[];
}

/** Mark a doc as failed (preserving inputs for diagnostics). */
export async function markFailed(id: string, error: string): Promise<void> {
  await prisma.brainDoc.updateMany({
    where: { id },
    data: { status: 'failed', error: error.slice(0, 4000) },
  });
}

/** Compose a stable hash of canonical input summary for cache-hit detection. */
export function hashInputs(input: Record<string, unknown>): string {
  // Sort keys recursively so {a:1,b:2} and {b:2,a:1} hash identically.
  const canonical = canonicalJson(input);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
