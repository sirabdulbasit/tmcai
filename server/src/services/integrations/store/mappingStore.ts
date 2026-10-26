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
 * Tenant rule: `cn` is the first parameter and is in every `where`.
 */
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { nextScheduledRun } from '../engine/planner';
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
  type KpiTransform,
  type MappingStoreModule,
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
    transform: (s.transform as KpiTransform | null) ?? null,
    coverage: (s.coverage as FieldCoverage | null) ?? null,
    samples: Array.isArray(s.samples) ? (s.samples as unknown[]).map(String) : [],
    newKpi: (s.newKpi as SuggestionDTO['newKpi']) ?? null,
    status: s.status as SuggestionStatus,
    reason: s.reason ?? null,
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
      select: { targetKey: true, sourceField: true },
    });
    for (const a of approvedNow) {
      const t = parseKpiTarget(a.targetKey);
      if (t) fedBy.set(t.kpiKey, a.sourceField);
    }

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
    for (const row of rows) {
      if (!REJECTABLE.has(row.status)) {
        result.refused.push({ id: row.id, reason: 'Already rejected.' });
        continue;
      }
      const upd = await tx.integrationSuggestion.updateMany({
        where: { id: row.id, clientNumber: cn, integrationId, mappingVersionId: versionId, status: row.status },
        data: { status: 'REJECTED', decidedBy: actorId, decidedAt: new Date() },
      });
      if (upd.count === 0) {
        result.refused.push({ id: row.id, reason: 'Someone else decided this field meanwhile.' });
        continue;
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

    const approvedRows = await tx.integrationSuggestion.count({
      where: { clientNumber: cn, integrationId: id, mappingVersionId: versionId, status: 'APPROVED' },
    });
    if (approvedRows === 0) reasons.push('Approve at least one field of this mapping.');

    // "The tested connection is the one runs use" (spec §3): the stored test
    // must be for the CURRENT sheet, and so must the dry run below.
    const fp = currentFingerprint(row);
    if (!fp) reasons.push('Connect a Google Sheet first.');
    else if (!row.connectionTestedAt || row.connectionFingerprint !== fp) {
      reasons.push('The sheet changed since its connection test. Test the connection again.');
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
      const dry = await tx.integrationRun.findFirst({
        where: {
          clientNumber: cn, integrationId: id, mappingVersionId: versionId,
          dryRun: true, status: 'SUCCESS', connectionFingerprint: fp,
          ...(lastDecision?.decidedAt ? { startedAt: { gte: lastDecision.decidedAt } } : {}),
        },
        select: { id: true },
      });
      if (!dry) reasons.push('Run a successful test (dry run) of this mapping on the current sheet first.');
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
