/**
 * DEF-354 — Integrations Stage 1: mapping decisions, the KPI catalogue, and the
 * turn-on / pause transitions.
 *
 * Spec INTEGRATIONS_DESIGN.md §2.3 (field-wise approval), §2.5 (turn on), §3.
 * Ported from vm integrationSyncService approveSuggestions / approveMapping and
 * the "§6 activation rule written as code" of the port notes, with the vm
 * defects closed:
 *
 *  - Approval is FIELD-wise and VERSION-scoped (vm §9 "proposable ≠ writable"):
 *    only PENDING rows of a DRAFT version can be approved. The version that is
 *    running (APPROVED) and replaced ones (SUPERSEDED) are frozen — a change to a
 *    running mapping goes through a new proposal, which carries the approved
 *    rows, so a scheduled run never writes a field that no dry run has seen.
 *  - One field, one owner (vm §9): kpi_definitions.source_integration_id names
 *    the ONE integration allowed to feed a KPI. Approving a row whose KPI another
 *    integration owns is refused, naming that integration.
 *  - Turn-on is ONE transaction (vm did approveMapping + PUT status as two client
 *    calls and set ACTIVE without any server check). It requires ≥1 approved row
 *    and a SUCCESS dry run of that same version with the current connection
 *    fingerprint (critique #12), and it NEVER runs anything: this module does not
 *    import the run engine — only the pure planner, for next_run_at.
 *  - activated_at is stamped only on a real transition into ACTIVE (vm
 *    re-stamped it on every save and could swallow a due slot).
 *
 * DEF-362 (Stage 1b, spec §2b) adds two row kinds:
 *  - Context rows need no catalogue: approving one checks that its layout is
 *    one the context writer can execute (and is one of its kind per layout).
 *  - The FILTER row. integration.approved_filter is written HERE ONLY — by the
 *    approval transitions of this module, never by PUT (closed whitelist) or by
 *    the proposer (vm §9 "approval is the only write permission"):
 *      · approving the filter row writes it, in the same transaction, while the
 *        integration has never been turned on (that draft IS what will run);
 *      · withdrawing (rejecting) an approved filter row clears it, likewise;
 *      · turning a version on writes that version's approved filter (or none).
 *    An integration that is already ACTIVE / PAUSED keeps running its approved
 *    version, so a filter approved on a newer DRAFT must not change what the
 *    running version reads until that draft is itself turned on (after its own
 *    dry run) — "a scheduled run never writes a field no dry run has seen".
 *  - The activation fingerprint is the store's currentFingerprint, which for an
 *    api integration covers api_config + secret_set_at.
 *
 * Tenant rule: `cn` is the first parameter and is in every `where`.
 */
import { Prisma } from '@prisma/client';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { nextScheduledRun } from '../engine/planner';
import { validateRecordFilter } from '../engine/recordFilter';
import { readContextTransform } from '../engine/contextWriter';
import {
  currentFingerprint,
  getIntegration,
  scheduleOf,
  scheduleProblems,
} from './integrationStore';
import {
  ActivationRefusedError,
  IntegrationInputError,
  IntegrationNotFoundError,
  KPI_DIRECTIONS,
  KPI_GRAINS,
  KPI_KEY_RE,
  type FieldCoverage,
  type IntegrationDTO,
  type KpiDefinitionDTO,
  type KpiDefinitionInput,
  type KpiDirection,
  type KpiGrain,
  type MappingStoreModule,
  type RecordFilter,
  type MappingVersionDTO,
  type SuggestionDecisionResult,
  type SuggestionDTO,
  type SuggestionStatus,
  type TargetKind,
  type VersionStatus,
} from '../types';

const log = createLogger('integrations-mapping-store');

/** What the helpers below need, satisfied by both `prisma` and the `tx` of an
 *  interactive transaction (the tenant-extended client's tx type is not
 *  Prisma.TransactionClient, so the model delegates are picked instead). */
type Tx = Pick<typeof prisma, 'integrationSync' | 'integrationMappingVersion' | 'integrationSuggestion'>;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

// ── KPI keys ──────────────────────────────────────────────────────────────

/** A KPI key must satisfy BOTH the DB CHECK (KPI_KEY_RE: starts with a letter)
 *  and the brief's 2–80 length — a one-letter key is too cryptic for the admin
 *  and for Brain's fetch_kpis to name. Returns the problem, or null. */
export function kpiKeyProblem(key: unknown): string | null {
  if (typeof key !== 'string' || key.length < 2 || key.length > 80 || !KPI_KEY_RE.test(key)) {
    return 'A KPI key is 2–80 lowercase letters, digits or underscores, starting with a letter.';
  }
  return null;
}

/** `kpi:<key>` / `kpi:new:<key>` ⇒ its parts; anything else ⇒ null. */
export function parseKpiTarget(targetKey: string): { kpiKey: string; isNew: boolean } | null {
  if (targetKey.startsWith('kpi:new:')) return { kpiKey: targetKey.slice('kpi:new:'.length), isNew: true };
  if (targetKey.startsWith('kpi:')) return { kpiKey: targetKey.slice('kpi:'.length), isNew: false };
  return null;
}

// ── DTOs ──────────────────────────────────────────────────────────────────

type VersionRow = NonNullable<Awaited<ReturnType<typeof prisma.integrationMappingVersion.findFirst>>>;
type SuggestionRow = NonNullable<Awaited<ReturnType<typeof prisma.integrationSuggestion.findFirst>>>;
type KpiRow = NonNullable<Awaited<ReturnType<typeof prisma.kpiDefinition.findFirst>>>;

function versionDTO(v: VersionRow): MappingVersionDTO {
  return {
    id: v.id,
    version: v.version,
    status: v.status as VersionStatus,
    aiSummary: v.aiSummary ?? null,
    adminPrompt: v.adminPrompt ?? null,
    spec: (v.spec ?? {}) as Record<string, unknown>,
    approvedBy: v.approvedBy ?? null,
    approvedAt: iso(v.approvedAt),
    createdAt: v.createdAt.toISOString(),
  };
}

function suggestionDTO(s: SuggestionRow): SuggestionDTO {
  return {
    id: s.id,
    mappingVersionId: s.mappingVersionId,
    targetKind: s.targetKind as TargetKind,
    sourceField: s.sourceField,
    targetKey: s.targetKey,
    transform: (s.transform as SuggestionDTO['transform']) ?? null,
    coverage: (s.coverage as FieldCoverage | null) ?? null,
    samples: Array.isArray(s.samples) ? (s.samples as unknown[]).map(String) : [],
    newKpi: (s.newKpi as SuggestionDTO['newKpi']) ?? null,
    status: s.status as SuggestionStatus,
    reason: s.reason ?? null,
    followed: s.followed ?? null,
    carriedFromId: s.carriedFromId ?? null,
    decidedBy: s.decidedBy ?? null,
    decidedAt: iso(s.decidedAt),
  };
}

function kpiDTO(k: KpiRow): KpiDefinitionDTO {
  return {
    id: k.id,
    kpiKey: k.kpiKey,
    label: k.label,
    unit: k.unit ?? null,
    direction: k.direction as KpiDirection,
    grain: k.grain as KpiGrain,
    sourceIntegrationId: k.sourceIntegrationId ?? null,
    isActive: k.isActive,
    createdAt: k.createdAt.toISOString(),
  };
}

/** Why a Context row cannot be approved, or null. No catalogue is involved
 *  (spec §2b); the layout must be one the context writer executes, and its
 *  target key must name that same layout. */
export function contextRowProblem(row: { targetKey: string; transform: unknown }): string | null {
  const t = readContextTransform(row.transform);
  if (!t) return 'This Context row has no usable layout. Ask for a new proposal.';
  if (row.targetKey !== `context:${t.mode}`) return `"${row.targetKey}" does not match its layout (${t.mode}).`;
  return null;
}

/** approved_filter as Prisma writes it: the filter, or SQL NULL. */
function filterColumn(f: RecordFilter | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return f ? (JSON.parse(JSON.stringify(f)) as Prisma.InputJsonValue) : Prisma.DbNull;
}

async function assertIntegration(db: Tx, cn: string, id: string): Promise<void> {
  const row = await db.integrationSync.findFirst({ where: { id, clientNumber: cn }, select: { id: true } });
  if (!row) throw new IntegrationNotFoundError(id);
}

// ── Suggestions ───────────────────────────────────────────────────────────

export const listSuggestions: MappingStoreModule['listSuggestions'] = async (cn, integrationId, versionId) => {
  await assertIntegration(prisma, cn, integrationId);
  const version = versionId
    ? await prisma.integrationMappingVersion.findFirst({ where: { id: versionId, integrationId, clientNumber: cn } })
    : await prisma.integrationMappingVersion.findFirst({
      where: { integrationId, clientNumber: cn },
      orderBy: { version: 'desc' },
    });
  if (!version) {
    if (versionId) throw new IntegrationInputError('That mapping version does not belong to this integration.', 'versionId');
    return { version: null, suggestions: [] };
  }
  const rows = await prisma.integrationSuggestion.findMany({
    where: { clientNumber: cn, integrationId, mappingVersionId: version.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return { version: versionDTO(version), suggestions: rows.map(suggestionDTO) };
};

/** The version the decision is about: it must belong to this integration and
 *  tenant, and be a DRAFT (see header — the running mapping is frozen). */
async function decisionVersion(tx: Tx, cn: string, integrationId: string, versionId: string): Promise<VersionRow> {
  await assertIntegration(tx, cn, integrationId);
  const v = await tx.integrationMappingVersion.findFirst({ where: { id: versionId, integrationId, clientNumber: cn } });
  if (!v) throw new IntegrationInputError('That mapping version does not belong to this integration.', 'versionId');
  if (v.status !== 'DRAFT') {
    throw new IntegrationInputError(
      v.status === 'APPROVED'
        ? 'This mapping is the one running. Ask for a new proposal to change it — approved fields are carried over.'
        : 'This mapping version was replaced by a newer one. Review the latest version instead.',
      'versionId',
    );
  }
  return v;
}

/** Rows of the decision: explicit ids (missing ones refused) or 'all' PENDING. */
async function decisionRows(
  tx: Tx, cn: string, integrationId: string, versionId: string, ids: string[] | 'all',
  refused: SuggestionDecisionResult['refused'],
): Promise<SuggestionRow[]> {
  if (ids !== 'all' && ids.length === 0) return [];
  const rows = await tx.integrationSuggestion.findMany({
    where: {
      clientNumber: cn, integrationId, mappingVersionId: versionId,
      ...(ids === 'all' ? { status: 'PENDING' } : { id: { in: ids } }),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (ids !== 'all') {
    const found = new Set(rows.map((r) => r.id));
    for (const id of new Set(ids)) if (!found.has(id)) refused.push({ id, reason: 'Not a field of this mapping version.' });
  }
  return rows;
}

export const approveSuggestions: MappingStoreModule['approveSuggestions'] = async (cn, integrationId, versionId, ids, actorId) => {
  const result: SuggestionDecisionResult = { updated: 0, createdKpis: [], refused: [] };
  await prisma.$transaction(async (tx) => {
    await decisionVersion(tx, cn, integrationId, versionId);
    const rows = await decisionRows(tx, cn, integrationId, versionId, ids, result.refused);

    // KPIs this version already feeds (approved earlier): two fields feeding one
    // KPI would write the same reading twice in one run — one field, one owner
    // holds inside a mapping too.
    const fedBy = new Map<string, string>();
    const approvedNow = await tx.integrationSuggestion.findMany({
      where: { clientNumber: cn, integrationId, mappingVersionId: versionId, status: 'APPROVED' },
      select: { targetKey: true, sourceField: true, targetKind: true },
    });
    // DEF-362: at most ONE approved filter per version — two would leave the
    // run to guess which records count.
    let filterApproved = approvedNow.some((a) => a.targetKind === 'filter');
    for (const a of approvedNow) {
      const t = parseKpiTarget(a.targetKey);
      if (t) fedBy.set(t.kpiKey, a.sourceField);
    }
    // approved_filter follows this draft only while nothing is turned on (see
    // header); an ACTIVE / PAUSED integration keeps its running version's filter.
    const integRow = await tx.integrationSync.findFirst({
      where: { id: integrationId, clientNumber: cn }, select: { approvedVersionId: true },
    });
    const draftIsWhatRuns = !integRow?.approvedVersionId;

    const ownerNames = new Map<string, string>();
    const ownerName = async (ownerId: string): Promise<string> => {
      if (!ownerNames.has(ownerId)) {
        const o = await tx.integrationSync.findFirst({ where: { id: ownerId, clientNumber: cn }, select: { name: true } });
        ownerNames.set(ownerId, o?.name ?? 'another integration');
      }
      return ownerNames.get(ownerId)!;
    };

    for (const row of rows) {
      if (row.status !== 'PENDING') {
        // vm §9: only a pending decision can be approved — a SET_ASIDE row carries
        // a risk finding the admin has not resolved, a REJECTED one is settled.
        result.refused.push({ id: row.id, reason: `Already ${row.status.toLowerCase().replace('_', ' ')}.` });
        continue;
      }
      const kind = row.targetKind ?? 'kpi';
      if (kind === 'context') {
        const problem = contextRowProblem(row);
        if (problem) {
          result.refused.push({ id: row.id, reason: problem });
          continue;
        }
        const upd = await tx.integrationSuggestion.updateMany({
          where: { id: row.id, clientNumber: cn, integrationId, mappingVersionId: versionId, status: 'PENDING' },
          data: { status: 'APPROVED', decidedBy: actorId, decidedAt: new Date() },
        });
        if (upd.count === 0) {
          result.refused.push({ id: row.id, reason: 'Someone else decided this field meanwhile.' });
          continue;
        }
        result.updated += 1;
        continue;
      }
      if (kind === 'filter') {
        let filter: RecordFilter;
        try {
          // Re-validated at approval: the stored JSON is what will run.
          filter = validateRecordFilter(row.transform);
        } catch (err) {
          result.refused.push({ id: row.id, reason: err instanceof Error ? err.message : 'This filter cannot be used.' });
          continue;
        }
        if (filterApproved) {
          result.refused.push({ id: row.id, reason: 'Another filter is already approved in this mapping. Withdraw it first.' });
          continue;
        }
        const upd = await tx.integrationSuggestion.updateMany({
          where: { id: row.id, clientNumber: cn, integrationId, mappingVersionId: versionId, status: 'PENDING' },
          data: { status: 'APPROVED', decidedBy: actorId, decidedAt: new Date() },
        });
        if (upd.count === 0) {
          result.refused.push({ id: row.id, reason: 'Someone else decided this field meanwhile.' });
          continue;
        }
        if (draftIsWhatRuns) {
          // The ONLY writer of approved_filter besides turn-on — same transaction
          // as the approval, so the two can never disagree.
          await tx.integrationSync.updateMany({
            where: { id: integrationId, clientNumber: cn },
            data: { approvedFilter: filterColumn(filter) },
          });
        }
        filterApproved = true;
        result.updated += 1;
        continue;
      }
      if (kind !== 'kpi') {
        result.refused.push({ id: row.id, reason: `Unknown row kind "${kind}".` });
        continue;
      }
      const target = parseKpiTarget(row.targetKey);
      if (!target) {
        result.refused.push({ id: row.id, reason: `"${row.targetKey}" is not a KPI target.` });
        continue;
      }
      const keyProblem = kpiKeyProblem(target.kpiKey);
      if (keyProblem) {
        result.refused.push({ id: row.id, reason: keyProblem });
        continue;
      }
      const kpiKey = target.kpiKey;
      if (fedBy.has(kpiKey)) {
        result.refused.push({ id: row.id, reason: `KPI "${kpiKey}" is already fed by the field "${fedBy.get(kpiKey)}" in this mapping.` });
        continue;
      }

      let def = await tx.kpiDefinition.findFirst({ where: { clientNumber: cn, kpiKey } });
      let created = false;
      if (!def && target.isNew) {
        // Spec §2.3: approving a proposed new KPI creates its definition, owned by
        // this integration, in the same transaction as the approval.
        // skipDuplicates (ON CONFLICT DO NOTHING) so a concurrent create of the
        // same key does not abort the transaction; the re-read decides ownership.
        const nk = (row.newKpi ?? {}) as { kpiKey?: unknown; label?: unknown; unit?: unknown };
        const label = typeof nk.label === 'string' && nk.label.trim() ? nk.label.trim().slice(0, 200) : kpiKey;
        const unit = typeof nk.unit === 'string' && nk.unit.trim() ? nk.unit.trim().slice(0, 20) : null;
        const ins = await tx.kpiDefinition.createMany({
          data: [{ clientNumber: cn, kpiKey, label, unit, sourceIntegrationId: integrationId, createdBy: actorId }],
          skipDuplicates: true,
        });
        created = ins.count === 1;
        def = await tx.kpiDefinition.findFirst({ where: { clientNumber: cn, kpiKey } });
      }
      if (!def) {
        // vm §9 "unconfigured target": the engine would fail the run; refuse now.
        result.refused.push({ id: row.id, reason: `KPI "${kpiKey}" is not in the catalogue. Add it first.` });
        continue;
      }
      if (!def.isActive) {
        result.refused.push({ id: row.id, reason: `KPI "${kpiKey}" is switched off.` });
        continue;
      }
      if (def.sourceIntegrationId && def.sourceIntegrationId !== integrationId) {
        // vm §9 "one field, one owner" — name the owner so the admin knows where to look.
        result.refused.push({
          id: row.id,
          reason: `KPI "${kpiKey}" is already fed by the integration "${await ownerName(def.sourceIntegrationId)}".`,
        });
        continue;
      }
      if (!def.sourceIntegrationId) {
        // Claim an unowned KPI. The WHERE makes the claim atomic: if another
        // integration claimed it first, count is 0 and this row is refused.
        const claim = await tx.kpiDefinition.updateMany({
          where: { id: def.id, clientNumber: cn, sourceIntegrationId: null },
          data: { sourceIntegrationId: integrationId },
        });
        if (claim.count === 0) {
          const now = await tx.kpiDefinition.findFirst({ where: { id: def.id, clientNumber: cn } });
          if (now?.sourceIntegrationId !== integrationId) {
            result.refused.push({
              id: row.id,
              reason: `KPI "${kpiKey}" is already fed by the integration "${now?.sourceIntegrationId ? await ownerName(now.sourceIntegrationId) : 'another integration'}".`,
            });
            continue;
          }
        }
      }

      const upd = await tx.integrationSuggestion.updateMany({
        where: { id: row.id, clientNumber: cn, integrationId, mappingVersionId: versionId, status: 'PENDING' },
        // `kpi:new:<key>` becomes `kpi:<key>`: from here on it is a catalogue KPI
        // (ApprovedKpiRow.targetKey is always `kpi:<key>`).
        data: { status: 'APPROVED', targetKey: `kpi:${kpiKey}`, decidedBy: actorId, decidedAt: new Date() },
      });
      if (upd.count === 0) {
        result.refused.push({ id: row.id, reason: 'Someone else decided this field meanwhile.' });
        continue;
      }
      if (created) result.createdKpis.push(kpiKey);
      fedBy.set(kpiKey, row.sourceField);
      result.updated += 1;
    }
  });
  log.info('suggestions approved', { cn, integrationId, versionId, updated: result.updated, refused: result.refused.length, createdKpis: result.createdKpis });
  return result;
};

/** Reject: 'all' settles every PENDING row; explicit ids may also withdraw an
 *  approval (or settle a set-aside / blank row) while the version is a DRAFT. */
const REJECTABLE = new Set(['PENDING', 'SET_ASIDE', 'BLANK', 'APPROVED']);

export const rejectSuggestions: MappingStoreModule['rejectSuggestions'] = async (cn, integrationId, versionId, ids, actorId) => {
  const result: SuggestionDecisionResult = { updated: 0, createdKpis: [], refused: [] };
  await prisma.$transaction(async (tx) => {
    await decisionVersion(tx, cn, integrationId, versionId);
    const rows = await decisionRows(tx, cn, integrationId, versionId, ids, result.refused);
    const integRow = await tx.integrationSync.findFirst({
      where: { id: integrationId, clientNumber: cn }, select: { approvedVersionId: true },
    });
    for (const row of rows) {
      if (!REJECTABLE.has(row.status)) {
        result.refused.push({ id: row.id, reason: 'Already rejected.' });
        continue;
      }
      const wasApprovedFilter = row.targetKind === 'filter' && row.status === 'APPROVED';
      const upd = await tx.integrationSuggestion.updateMany({
        where: { id: row.id, clientNumber: cn, integrationId, mappingVersionId: versionId, status: row.status },
        data: { status: 'REJECTED', decidedBy: actorId, decidedAt: new Date() },
      });
      if (upd.count === 0) {
        result.refused.push({ id: row.id, reason: 'Someone else decided this field meanwhile.' });
        continue;
      }
      if (wasApprovedFilter && !integRow?.approvedVersionId) {
        // DEF-362: withdrawing the approved filter of the draft that will run
        // stops the filtering, in the same transaction (see header).
        await tx.integrationSync.updateMany({
          where: { id: integrationId, clientNumber: cn },
          data: { approvedFilter: filterColumn(null) },
        });
      }
      result.updated += 1;
    }
  });
  log.info('suggestions rejected', { cn, integrationId, versionId, updated: result.updated });
  return result;
};

// ── KPI catalogue ─────────────────────────────────────────────────────────

export const listKpiDefinitions: MappingStoreModule['listKpiDefinitions'] = async (cn) => {
  const rows = await prisma.kpiDefinition.findMany({ where: { clientNumber: cn }, orderBy: { kpiKey: 'asc' } });
  return rows.map(kpiDTO);
};

export const createKpiDefinition: MappingStoreModule['createKpiDefinition'] = async (cn, input: KpiDefinitionInput, actorId) => {
  const keyProblem = kpiKeyProblem(input?.kpiKey);
  if (keyProblem) throw new IntegrationInputError(keyProblem, 'kpiKey');
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || label.length > 200) throw new IntegrationInputError('Give the KPI a label (200 characters at most).', 'label');
  const unit = input.unit == null ? null : String(input.unit).trim();
  if (unit !== null && unit.length > 20) throw new IntegrationInputError('The unit is too long (20 characters at most).', 'unit');
  const direction = input.direction ?? 'up';
  if (!(KPI_DIRECTIONS as readonly string[]).includes(direction)) {
    throw new IntegrationInputError('Direction must be "up" or "down".', 'direction');
  }
  const grain = input.grain ?? 'month';
  if (!(KPI_GRAINS as readonly string[]).includes(grain)) {
    throw new IntegrationInputError('Grain must be day, week or month.', 'grain');
  }
  try {
    // source_integration_id stays null: the first integration whose approved
    // row names this KPI becomes its one owner (approveSuggestions).
    const row = await prisma.kpiDefinition.create({
      data: {
        clientNumber: cn, kpiKey: input.kpiKey, label, unit: unit || null, direction, grain,
        createdBy: actorId ?? null,
      },
    });
    log.info('kpi definition created', { cn, kpiKey: row.kpiKey, actorId });
    return kpiDTO(row);
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw new IntegrationInputError(`A KPI with the key "${input.kpiKey}" already exists.`, 'kpiKey');
    }
    throw err;
  }
};

// ── Turn on / pause (spec §2.5) ───────────────────────────────────────────


/** DEF-362 review: a PARTIAL dry run whose read was complete and whose only
 *  shortfall was the Context page cap (runEngine EngineResultWithContext). */
function isCapOnlyPartial(result: unknown): boolean {
  const r = (result && typeof result === 'object' ? result : {}) as { readComplete?: unknown; context?: { truncated?: unknown } };
  return r.readComplete === true && r.context?.truncated === true;
}

/** Why a PARTIAL dry run did not count, in admin words (its first note). */
function partialWhy(result: unknown): string {
  const a = (result && typeof result === 'object' ? (result as { anomalies?: unknown }).anomalies : null);
  const first = Array.isArray(a) ? a.find((x) => typeof x === 'string' && x.trim()) : null;
  return typeof first === 'string' ? first.trim().replace(/[.\s]+$/, '').slice(0, 300) : 'only part of it was read';
}

export const activate: MappingStoreModule['activate'] = async (cn, id, versionId, actorId) => {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Row lock: two concurrent turn-ons serialise here instead of racing the
    // supersede/approve pair below. Raw SQL ⇒ client_number explicit.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM integration_syncs WHERE id = ${id} AND client_number = ${cn} FOR UPDATE`;
    if (locked.length === 0) throw new IntegrationNotFoundError(id);
    const row = await tx.integrationSync.findFirst({ where: { id, clientNumber: cn } });
    if (!row) throw new IntegrationNotFoundError(id);

    const reasons: string[] = [];
    const version = await tx.integrationMappingVersion.findFirst({ where: { id: versionId, integrationId: id, clientNumber: cn } });
    if (!version) {
      throw new ActivationRefusedError(['That mapping version does not belong to this integration.']);
    }
    if (version.status === 'SUPERSEDED') reasons.push('This mapping version was replaced by a newer one.');

    // DEF-362: a filter alone writes nothing — at least one KPI or Context row.
    const approvedRows = await tx.integrationSuggestion.count({
      where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, status: 'APPROVED', targetKind: { in: ['kpi', 'context'] } },
    });
    if (approvedRows === 0) reasons.push('Approve at least one field of this mapping.');

    // The version's approved filter becomes approved_filter at turn-on (header).
    const filterRow = await tx.integrationSuggestion.findFirst({
      where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, status: 'APPROVED', targetKind: 'filter' },
      select: { transform: true },
    });
    let filter: RecordFilter | null = null;
    if (filterRow) {
      try {
        filter = validateRecordFilter(filterRow.transform);
      } catch (err) {
        reasons.push(`The approved filter cannot be used: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // "The tested connection is the one runs use" (spec §3): the stored test
    // must be for the CURRENT connection, and so must the dry run below. For
    // an api integration that is api_config + secret_set_at (a new credential
    // is a new connection).
    const isApi = row.sourceKind === 'api';
    const fp = currentFingerprint(row);
    if (!fp) reasons.push(isApi ? 'Set up the API connection first.' : row.sourceKind === 'file' ? 'Upload the spreadsheet first.' : 'Connect a Google Sheet first.');
    else if (!row.connectionTestedAt || row.connectionFingerprint !== fp) {
      reasons.push(isApi
        ? 'The API connection or its credential changed since its connection test. Test the connection again.'
        : row.sourceKind === 'file'
          ? 'The file or its tab changed since its connection test. Test the connection again.'
          : 'The sheet changed since its connection test. Test the connection again.');
    }

    if (fp) {
      // Spec §2.5 + critique #12: a SUCCESS dry run of THIS version that read THIS
      // connection, started after the last decision on the version — a dry run
      // that predates an approval did not see the field that approval enables.
      const lastDecision = await tx.integrationSuggestion.findFirst({
        where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, decidedAt: { not: null } },
        orderBy: { decidedAt: 'desc' },
        select: { decidedAt: true },
      });
      // DEF-362 review: a PARTIAL dry run also counts when the read was complete
      // and its only shortfall was the Context page cap (max_context_pages) —
      // every live run applies the same cap, so what it previewed is what runs.
      // A read that fell short (row/page limit, fewer than the declared total)
      // still does not count, exactly as in Stage 1, and the refusal says why.
      const dryRuns = await tx.integrationRun.findMany({
        where: {
          clientNumber: cn, integrationId: id, mappingVersionId: versionId,
          dryRun: true, status: { in: ['SUCCESS', 'PARTIAL'] }, connectionFingerprint: fp,
          ...(lastDecision?.decidedAt ? { startedAt: { gte: lastDecision.decidedAt } } : {}),
        },
        orderBy: { startedAt: 'desc' },
        select: { id: true, status: true, result: true },
        take: 20,
      });
      const dry = dryRuns.find((r) => r.status === 'SUCCESS' || isCapOnlyPartial(r.result));
      if (!dry) {
        reasons.push(dryRuns.length
          ? `The latest test (dry run) did not read the whole ${isApi ? 'API' : 'sheet'} (${partialWhy(dryRuns[0].result)}), so it cannot be turned on from it. Narrow the filter or fix the source, then test again.`
          : `Run a successful test (dry run) of this mapping on the current ${isApi ? 'API connection' : 'sheet'} first.`);
      }
    }

    const schedule = scheduleOf(row);
    reasons.push(...scheduleProblems(schedule, row.timezone));

    if (reasons.length) throw new ActivationRefusedError(reasons);

    // Only one APPROVED version per integration (partial unique index): retire
    // the previous one first.
    await tx.integrationMappingVersion.updateMany({
      where: { clientNumber: cn, integrationId: id, status: 'APPROVED', id: { not: versionId } },
      data: { status: 'SUPERSEDED' },
    });
    if (version.status !== 'APPROVED') {
      await tx.integrationMappingVersion.updateMany({
        where: { id: versionId, integrationId: id, clientNumber: cn },
        data: { status: 'APPROVED', approvedBy: actorId, approvedAt: now },
      });
    }
    // activated_at only on a real transition: a re-activate of an ACTIVE row
    // keeps it (vm re-stamped it and swallowed a due slot); a resume from PAUSED
    // re-stamps it, so slots that passed while paused are not owed.
    const wasActive = row.status === 'ACTIVE';
    const activatedAt = wasActive && row.activatedAt ? row.activatedAt : now;
    await tx.integrationSync.updateMany({
      where: { id, clientNumber: cn },
      data: {
        status: 'ACTIVE',
        approvedVersionId: versionId,
        activatedAt,
        nextRunAt: nextScheduledRun(schedule, now, row.timezone),
        approvedFilter: filterColumn(filter),
      },
    });
    // Nothing else: turning on NEVER starts a run (vm §9 "enabling never triggers
    // a run"). The dispatcher picks up the first slot after activated_at.
  });
  log.info('integration turned on', { cn, id, versionId, actorId });
  const dto = await getIntegration(cn, id);
  if (!dto) throw new IntegrationNotFoundError(id);
  return dto;
};

export const pause: MappingStoreModule['pause'] = async (cn, id): Promise<IntegrationDTO> => {
  // approved_version_id stays: resuming goes back through activate, which
  // re-checks everything and re-stamps activated_at.
  const res = await prisma.integrationSync.updateMany({
    where: { id, clientNumber: cn, status: 'ACTIVE' },
    data: { status: 'PAUSED', nextRunAt: null },
  });
  const dto = await getIntegration(cn, id);
  if (!dto) throw new IntegrationNotFoundError(id);
  if (res.count === 0 && dto.status === 'DRAFT') {
    throw new IntegrationInputError('This integration is not turned on.', 'status');
  }
  if (res.count > 0) log.info('integration paused', { cn, id });
  return dto;
};

/** Module conformance check — a signature drift from types.ts fails tsc here. */
export const mappingStore = {
  listSuggestions, approveSuggestions, rejectSuggestions, listKpiDefinitions, createKpiDefinition, activate, pause,
} satisfies MappingStoreModule;
