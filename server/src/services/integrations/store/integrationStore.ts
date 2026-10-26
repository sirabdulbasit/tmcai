/**
 * DEF-354 — Integrations Stage 1: the integration row itself (CRUD, connection
 * test record, derived wizard stage).
 *
 * Spec INTEGRATIONS_DESIGN.md §2.1, §2.2, §2.6. Ported from vm
 * integrationSyncService (create/update/list) and integrationSyncPlanner
 * deriveWizardStage, with the vm defects the port notes list closed here:
 *
 *  - The client can only send the CLOSED whitelist IntegrationInput (vm §9
 *    "permissions are never accepted from the client"). Unknown keys are
 *    REJECTED, not ignored, so `{status:'ACTIVE'}` or `{approvedVersionId}` in a
 *    PUT is a 400 instead of a silent no-op that looks like it worked. vm's PUT
 *    re-stamped activated_at on every save of an ACTIVE row and could swallow a
 *    due slot — status/activation only change through mappingStore.activate/pause.
 *  - The sheet arrives as a link and is parsed here (parseSheetLink); sheetId and
 *    gid are never taken raw. Changing the route (sheet, tab, kind) clears the
 *    connection test, and is refused on an ACTIVE integration: "the tested
 *    connection is the one runs use" (spec §3) — a scheduled run must never read
 *    a sheet nobody tested.
 *  - The wizard stage is DERIVED from facts on every read, never a stored pointer
 *    (vm P:313). Approvals count only on the version that would run (the
 *    approved one, else the latest): approvals on an older version say nothing
 *    about what the next run writes.
 *
 * Tenant rule: `cn` is the first parameter and is in every `where`, even though
 * the Prisma tenant extension would add it — the dispatcher and boot paths run
 * outside a tenant scope, where the extension does nothing.
 */
import { createHash } from 'crypto';
import { z } from 'zod';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { isValidTimezone, resolveUserTimezone } from '../../userTimezoneService';
import { parseSheetLink } from '../sources/sheetLink';
import { nextScheduledRun } from '../engine/planner';
import {
  BLANK_POLICIES,
  FREQUENCIES,
  INTEGRATION_INPUT_KEYS,
  IntegrationInputError,
  IntegrationNotFoundError,
  SOURCE_KINDS,
  type BlankPolicy,
  type Frequency,
  type GsheetSourceConfig,
  type IntegrationDTO,
  type IntegrationInput,
  type IntegrationStatus,
  type IntegrationStoreModule,
  type RunStatus,
  type ScheduleConfig,
  type SourceKind,
  type StageFacts,
  type WizardStage,
} from '../types';

const log = createLogger('integrations-store');

const RUN_TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

// ── Input validation (closed whitelist) ───────────────────────────────────

/** `.strict()` is the second line of defence; the explicit key check below runs
 *  first so the message names the offending key in plain words. */
const inputSchema = z.object({
  name: z.string().trim().min(1, 'Give the integration a name.').max(200, 'The name is too long (200 characters at most).'),
  purpose: z.string().max(5000, 'The purpose is too long.').nullable(),
  adminBrief: z.string().max(10000, 'The brief is too long.').nullable(),
  sourceKind: z.enum(SOURCE_KINDS),
  link: z.string().max(2048, 'That link is too long to be a Google Sheet link.'),
  tabLabel: z.string().trim().max(200, 'The tab name is too long.').nullable(),
  frequency: z.enum(FREQUENCIES),
  runTime: z.string().regex(RUN_TIME_RE, 'Run time must be HH:MM (24-hour).'),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  dayOfMonth: z.number().int().refine((d) => d === -1 || (d >= 1 && d <= 31), 'Day of month must be 1–31, or "last day".').nullable(),
  timezone: z.string().max(64),
  changeCapPct: z.number().int().min(1, 'The change limit must be 1–100%.').max(100, 'The change limit must be 1–100%.'),
  blankPolicy: z.enum(BLANK_POLICIES),
}).partial().strict();

/**
 * Validate a client payload against the closed whitelist. Throws
 * IntegrationInputError naming the field. Exported for the route and tests.
 */
export function validateIntegrationInput(raw: unknown): IntegrationInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IntegrationInputError('Send the integration settings as an object.');
  }
  const allowed = new Set<string>(INTEGRATION_INPUT_KEYS as readonly string[]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      // vm §9: status, approval, activation, timestamps and the fingerprint are
      // set by the server's own transitions only — never by a client payload.
      throw new IntegrationInputError(`"${key}" cannot be set here.`, key);
    }
  }
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.[0] != null ? String(issue.path[0]) : undefined;
    throw new IntegrationInputError(issue?.message || 'Invalid integration settings.', field);
  }
  if (parsed.data.timezone !== undefined && !isValidTimezone(parsed.data.timezone)) {
    throw new IntegrationInputError(`"${parsed.data.timezone}" is not a known time zone.`, 'timezone');
  }
  return parsed.data as IntegrationInput;
}

/**
 * Plain-language reasons a schedule cannot run (empty = valid). Used by
 * activation (spec §2.5 "schedule valid") and by edits of an ACTIVE row.
 */
export function scheduleProblems(s: ScheduleConfig, tz: string): string[] {
  const out: string[] = [];
  if (!(FREQUENCIES as readonly string[]).includes(s.frequency)) out.push(`Unknown frequency "${s.frequency}".`);
  if (!RUN_TIME_RE.test(s.runTime)) out.push('Run time must be HH:MM (24-hour).');
  if (s.frequency === 'weekly' && (s.dayOfWeek == null || s.dayOfWeek < 0 || s.dayOfWeek > 6)) {
    out.push('A weekly schedule needs a day of the week.');
  }
  if (s.frequency === 'monthly'
      && (s.dayOfMonth == null || !(s.dayOfMonth === -1 || (s.dayOfMonth >= 1 && s.dayOfMonth <= 31)))) {
    out.push('A monthly schedule needs a day of the month.');
  }
  if (!isValidTimezone(tz)) out.push(`"${tz}" is not a known time zone.`);
  return out;
}

// ── Fingerprint and source config ─────────────────────────────────────────

/** The ONE definition of "which connection" (types.ts). tabLabel and link text
 *  are display only and deliberately excluded: the route is kind + sheet + tab id. */
export const connectionFingerprint: IntegrationStoreModule['connectionFingerprint'] = (sourceKind, cfg) =>
  createHash('sha256').update(`${sourceKind}\n${cfg.sheetId}\n${cfg.gid}`).digest('hex');

/** The stored source_config, or null when no sheet has been set yet. */
export function readSourceConfig(raw: unknown): GsheetSourceConfig | null {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (typeof c.sheetId !== 'string' || !c.sheetId || typeof c.gid !== 'string') return null;
  return {
    sheetId: c.sheetId,
    gid: c.gid,
    link: typeof c.link === 'string' ? c.link : '',
    ...(typeof c.tabLabel === 'string' && c.tabLabel ? { tabLabel: c.tabLabel } : {}),
  };
}

/** Fingerprint of a row's CURRENT config, or null when it has no sheet. */
export function currentFingerprint(row: { sourceKind: string; sourceConfig: unknown }): string | null {
  const cfg = readSourceConfig(row.sourceConfig);
  return cfg ? connectionFingerprint(row.sourceKind as SourceKind, cfg) : null;
}

/** Tested AND the tested fingerprint is the current config's. */
export function isConnectionOk(row: {
  sourceKind: string; sourceConfig: unknown; connectionTestedAt: Date | null; connectionFingerprint: string | null;
}): boolean {
  const fp = currentFingerprint(row);
  return !!(row.connectionTestedAt && fp && row.connectionFingerprint === fp);
}

export function scheduleOf(row: {
  frequency: string; runTime: string; dayOfWeek: number | null; dayOfMonth: number | null;
}): ScheduleConfig {
  return {
    frequency: row.frequency as Frequency,
    runTime: row.runTime,
    dayOfWeek: row.dayOfWeek ?? null,
    dayOfMonth: row.dayOfMonth ?? null,
  };
}

// ── Wizard stage (derived, vm P:313) ──────────────────────────────────────

export const deriveWizardStage: IntegrationStoreModule['deriveWizardStage'] = (f: StageFacts): WizardStage => {
  if (f.status === 'ACTIVE') return { step: 5, label: 'Working', done: true };
  if (f.status === 'PAUSED') return { step: 5, label: 'Paused', done: false };
  if (f.hasSuccessfulDryRun) return { step: 5, label: 'Tested — not turned on', done: false };
  if (f.hasApproval) return { step: 4, label: 'Mapping approved — set a schedule', done: false };
  if (f.hasMapping) return { step: 3, label: 'Review the mapping', done: false };
  if (f.connectionTested) return { step: 3, label: 'Connected — needs a mapping', done: false };
  if (f.hasSource) return { step: 2, label: 'Test the connection', done: false };
  return { step: 1, label: 'Not connected yet', done: false };
};

type SyncRow = Awaited<ReturnType<typeof prisma.integrationSync.findFirst>> & {};

/**
 * Load the stage facts for a batch of integrations of ONE tenant in three
 * queries (not three per row — the list screen polls).
 */
async function loadStageFacts(cn: string, rows: SyncRow[]): Promise<Map<string, StageFacts>> {
  const out = new Map<string, StageFacts>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);

  const versions = await prisma.integrationMappingVersion.findMany({
    where: { clientNumber: cn, integrationId: { in: ids } },
    select: { id: true, integrationId: true, version: true },
    orderBy: { version: 'desc' },
  });
  const latest = new Map<string, string>();
  for (const v of versions) if (!latest.has(v.integrationId)) latest.set(v.integrationId, v.id);

  // The version that would run: the approved one, else the latest proposal.
  const stageVersion = new Map<string, string>();
  for (const r of rows) {
    const v = r.approvedVersionId ?? latest.get(r.id);
    if (v) stageVersion.set(r.id, v);
  }
  const versionIds = [...new Set(stageVersion.values())];

  const approved = versionIds.length === 0 ? [] : await prisma.integrationSuggestion.findMany({
    where: { clientNumber: cn, integrationId: { in: ids }, mappingVersionId: { in: versionIds }, status: 'APPROVED' },
    select: { mappingVersionId: true },
    distinct: ['mappingVersionId'],
  });
  const approvedVersions = new Set(approved.map((a) => a.mappingVersionId));

  const dryRuns = versionIds.length === 0 ? [] : await prisma.integrationRun.findMany({
    where: {
      clientNumber: cn, integrationId: { in: ids }, mappingVersionId: { in: versionIds },
      dryRun: true, status: 'SUCCESS',
    },
    select: { integrationId: true, mappingVersionId: true, connectionFingerprint: true },
    distinct: ['integrationId', 'mappingVersionId', 'connectionFingerprint'],
  });

  for (const r of rows) {
    const v = stageVersion.get(r.id) ?? null;
    const fp = currentFingerprint(r);
    out.set(r.id, {
      status: r.status as IntegrationStatus,
      hasSource: readSourceConfig(r.sourceConfig) !== null,
      connectionTested: isConnectionOk(r),
      hasMapping: latest.has(r.id),
      hasApproval: v !== null && approvedVersions.has(v),
      // Bound to the same version AND the current connection — the same pair
      // activation checks, so the badge cannot say "tested" when turn-on refuses.
      hasSuccessfulDryRun: v !== null && fp !== null && dryRuns.some(
        (d) => d.integrationId === r.id && d.mappingVersionId === v && d.connectionFingerprint === fp),
    });
  }
  return out;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function toDTO(r: SyncRow, facts: StageFacts): IntegrationDTO {
  return {
    id: r.id,
    name: r.name,
    purpose: r.purpose ?? null,
    adminBrief: r.adminBrief ?? null,
    sourceKind: r.sourceKind as SourceKind,
    sourceConfig: readSourceConfig(r.sourceConfig),
    status: r.status as IntegrationStatus,
    frequency: r.frequency as Frequency,
    runTime: r.runTime,
    dayOfWeek: r.dayOfWeek ?? null,
    dayOfMonth: r.dayOfMonth ?? null,
    timezone: r.timezone,
    changeCapPct: r.changeCapPct,
    blankPolicy: r.blankPolicy as BlankPolicy,
    connectionTestedAt: iso(r.connectionTestedAt),
    connectionOk: facts.connectionTested,
    activatedAt: iso(r.activatedAt),
    approvedVersionId: r.approvedVersionId ?? null,
    nextRunAt: iso(r.nextRunAt),
    lastRunAt: iso(r.lastRunAt),
    lastRunStatus: (r.lastRunStatus as RunStatus | null) ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    stage: deriveWizardStage(facts),
  };
}

async function findRow(cn: string, id: string): Promise<SyncRow | null> {
  return prisma.integrationSync.findFirst({ where: { id, clientNumber: cn } });
}

async function rowToDTO(cn: string, row: SyncRow): Promise<IntegrationDTO> {
  const facts = await loadStageFacts(cn, [row]);
  return toDTO(row, facts.get(row.id)!);
}

/** P2002 on integration_syncs_tenant_name_key ⇒ a 400 naming the field. */
function rethrowNameClash(err: unknown): never {
  if ((err as { code?: string })?.code === 'P2002') {
    throw new IntegrationInputError('An integration with that name already exists.', 'name');
  }
  throw err;
}

// ── Module functions ──────────────────────────────────────────────────────

export const listIntegrations: IntegrationStoreModule['listIntegrations'] = async (cn) => {
  const rows = await prisma.integrationSync.findMany({
    where: { clientNumber: cn },
    orderBy: { createdAt: 'desc' },
  });
  const facts = await loadStageFacts(cn, rows);
  return rows.map((r) => toDTO(r, facts.get(r.id)!));
};

export const getIntegration: IntegrationStoreModule['getIntegration'] = async (cn, id) => {
  const row = await findRow(cn, id);
  return row ? rowToDTO(cn, row) : null;
};

export const createIntegration: IntegrationStoreModule['createIntegration'] = async (cn, rawInput, actorId) => {
  const input = validateIntegrationInput(rawInput);
  if (!input.name) throw new IntegrationInputError('Give the integration a name.', 'name');

  let sourceConfig: GsheetSourceConfig | Record<string, never> = {};
  if (input.link) {
    sourceConfig = { ...parseSheetLink(input.link), ...(input.tabLabel ? { tabLabel: input.tabLabel } : {}) };
  }
  // Spec §2.1: the schedule's zone is the creator's, validated — never the
  // server's. resolveUserTimezone already skips invalid values; the check here
  // guards the column against a future change to that fallback chain.
  let timezone = input.timezone;
  if (!timezone) {
    const tz = await resolveUserTimezone(actorId);
    timezone = isValidTimezone(tz) ? tz : 'UTC';
  }

  const row = await prisma.integrationSync.create({
    data: {
      clientNumber: cn,
      name: input.name,
      purpose: input.purpose ?? null,
      adminBrief: input.adminBrief ?? null,
      sourceKind: input.sourceKind ?? 'gsheet',
      sourceConfig: sourceConfig as object,
      status: 'DRAFT', // forced: turning on is mappingStore.activate's job alone
      ...(input.frequency !== undefined ? { frequency: input.frequency } : {}),
      ...(input.runTime !== undefined ? { runTime: input.runTime } : {}),
      dayOfWeek: input.dayOfWeek ?? null,
      dayOfMonth: input.dayOfMonth ?? null,
      timezone,
      ...(input.changeCapPct !== undefined ? { changeCapPct: input.changeCapPct } : {}),
      ...(input.blankPolicy !== undefined ? { blankPolicy: input.blankPolicy } : {}),
      createdBy: actorId,
    },
  }).catch(rethrowNameClash);
  log.info('integration created', { cn, id: row.id, actorId });
  return rowToDTO(cn, row);
};

export const updateIntegration: IntegrationStoreModule['updateIntegration'] = async (cn, id, rawPatch) => {
  const patch = validateIntegrationInput(rawPatch);
  const row = await findRow(cn, id);
  if (!row) throw new IntegrationNotFoundError(id);

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.purpose !== undefined) data.purpose = patch.purpose;
  if (patch.adminBrief !== undefined) data.adminBrief = patch.adminBrief;
  if (patch.frequency !== undefined) data.frequency = patch.frequency;
  if (patch.runTime !== undefined) data.runTime = patch.runTime;
  if (patch.dayOfWeek !== undefined) data.dayOfWeek = patch.dayOfWeek;
  if (patch.dayOfMonth !== undefined) data.dayOfMonth = patch.dayOfMonth;
  if (patch.timezone !== undefined) data.timezone = patch.timezone;
  if (patch.changeCapPct !== undefined) data.changeCapPct = patch.changeCapPct;
  if (patch.blankPolicy !== undefined) data.blankPolicy = patch.blankPolicy;

  // ── Source: the route may only change with the test cleared ──
  const oldCfg = readSourceConfig(row.sourceConfig);
  const kind = (patch.sourceKind ?? row.sourceKind) as SourceKind;
  let newCfg = oldCfg;
  if (patch.link !== undefined) {
    newCfg = patch.link.trim() === '' ? null : parseSheetLink(patch.link);
    const label = patch.tabLabel !== undefined ? patch.tabLabel : oldCfg?.tabLabel;
    if (newCfg && label) newCfg.tabLabel = label;
  } else if (patch.tabLabel !== undefined && oldCfg) {
    newCfg = { ...oldCfg };
    if (patch.tabLabel) newCfg.tabLabel = patch.tabLabel; else delete newCfg.tabLabel;
  }
  const oldFp = oldCfg ? connectionFingerprint(row.sourceKind as SourceKind, oldCfg) : null;
  const newFp = newCfg ? connectionFingerprint(kind, newCfg) : null;
  const routeChanged = oldFp !== newFp;
  if (patch.sourceKind !== undefined) data.sourceKind = patch.sourceKind;
  if (newCfg !== oldCfg) data.sourceConfig = (newCfg ?? {}) as object;
  if (routeChanged || (patch.link !== undefined && patch.link.trim() !== (oldCfg?.link ?? ''))) {
    if (row.status === 'ACTIVE') {
      // Spec §3 "the tested connection is the one runs use": an ACTIVE row would
      // read the new, untested sheet at its next slot. Pause, edit, re-test, turn on.
      throw new IntegrationInputError('Pause this integration before changing its sheet.', 'link');
    }
    data.connectionTestedAt = null;
    data.connectionFingerprint = null;
  }

  // ── Schedule of a running integration: keep it valid and next_run_at honest ──
  const scheduleTouched = ['frequency', 'runTime', 'dayOfWeek', 'dayOfMonth', 'timezone'].some((k) => k in data);
  if (scheduleTouched && row.status === 'ACTIVE') {
    const schedule = scheduleOf({ ...row, ...(data as object) } as typeof row);
    const tz = (data.timezone as string | undefined) ?? row.timezone;
    const problems = scheduleProblems(schedule, tz);
    if (problems.length) throw new IntegrationInputError(problems[0], 'frequency');
    // activated_at is deliberately NOT touched (vm re-stamped it on every save).
    // But slots of the NEW schedule that already passed are not owed: without
    // this, moving a daily 23:00 run to 09:00 at 15:00 made today's 09:00 slot
    // due on the next tick — an unattended write at a time nobody chose.
    const now = new Date();
    data.lastSlotAt = now;
    data.nextRunAt = nextScheduledRun(schedule, now, tz);
  }

  if (Object.keys(data).length === 0) return rowToDTO(cn, row);

  const res = await prisma.integrationSync.updateMany({ where: { id, clientNumber: cn }, data }).catch(rethrowNameClash);
  if (res.count === 0) throw new IntegrationNotFoundError(id);
  const fresh = await findRow(cn, id);
  if (!fresh) throw new IntegrationNotFoundError(id);
  if (routeChanged) log.info('integration source changed; connection test cleared', { cn, id });
  return rowToDTO(cn, fresh);
};

export const deleteIntegration: IntegrationStoreModule['deleteIntegration'] = async (cn, id) => {
  // FK cascade removes versions, suggestions, runs and run changes; KPI
  // definitions it owned are freed (SET NULL); kpi_readings carry no FK and
  // stay (spec §5 q3).
  const res = await prisma.integrationSync.deleteMany({ where: { id, clientNumber: cn } });
  if (res.count === 0) throw new IntegrationNotFoundError(id);
  log.info('integration deleted', { cn, id });
};

export const recordConnectionTest: IntegrationStoreModule['recordConnectionTest'] = async (cn, id, result) => {
  const row = await findRow(cn, id);
  if (!row) throw new IntegrationNotFoundError(id);
  const fp = currentFingerprint(row);
  const ok = result.ok && fp !== null;
  // The WHERE re-checks the source_config read above, so a link edited between
  // the read and this write cannot inherit a pass that was earned by the old one.
  const res = await prisma.integrationSync.updateMany({
    where: { id, clientNumber: cn, sourceConfig: { equals: (row.sourceConfig ?? {}) as object } },
    data: ok
      ? { connectionTestedAt: new Date(), connectionFingerprint: fp }
      : { connectionTestedAt: null, connectionFingerprint: null },
  });
  if (res.count === 0) {
    throw new IntegrationInputError('The sheet link changed while it was being tested. Test it again.', 'link');
  }
  const fresh = await findRow(cn, id);
  if (!fresh) throw new IntegrationNotFoundError(id);
  return rowToDTO(cn, fresh);
};

/** Module conformance check — a signature drift from types.ts fails tsc here. */
export const integrationStore = {
  listIntegrations, getIntegration, createIntegration, updateIntegration, deleteIntegration,
  deriveWizardStage, recordConnectionTest, connectionFingerprint,
} satisfies IntegrationStoreModule;
