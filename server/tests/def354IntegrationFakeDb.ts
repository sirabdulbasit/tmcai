/**
 * DEF-354 — a small in-memory stand-in for the Prisma client, shared by the
 * Store / Activation / Dispatcher tests (not a test file itself).
 *
 * It implements just the Prisma surface the store and dispatcher use, with real
 * `where` semantics (equality, null, in, not, gte, lt, equals), so a test can
 * assert outcomes (rows changed or not) rather than call shapes. Every call is
 * recorded in `calls` so the tenant-scoping test can inspect each `where`.
 * `$transaction` snapshots the tables and restores them on a throw, like a
 * rollback. `$queryRaw` understands the two raw statements of the feature: the
 * activation row lock and the dispatcher's slot claim — and applies each guard
 * of the claim only if the SQL text still contains it, so deleting a guard from
 * the code makes the matching test fail.
 */

type Row = Record<string, any>;

// DEF-368 adds integrationSourceFile (the uploaded spreadsheet; key = integrationId).
const MODELS = ['integrationSync', 'integrationMappingVersion', 'integrationSuggestion', 'integrationRun', 'integrationRunChange', 'kpiDefinition', 'integrationSourceFile'] as const;
type ModelName = typeof MODELS[number];

export interface Call { model: string; op: string; args: any }

function eq(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a == null && b == null) return true;
  return a === b;
}
function cmp(a: any, b: any): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('equals' in cond && JSON.stringify(v ?? {}) !== JSON.stringify(cond.equals ?? {})) return false;
      if ('in' in cond && !(cond.in as unknown[]).some((x) => eq(x, v))) return false;
      if ('not' in cond && eq(v, cond.not)) return false;
      if ('gte' in cond && (v == null || cmp(v, cond.gte) < 0)) return false;
      if ('gt' in cond && (v == null || cmp(v, cond.gt) <= 0)) return false;
      if ('lt' in cond && (v == null || cmp(v, cond.lt) >= 0)) return false;
      if ('lte' in cond && (v == null || cmp(v, cond.lte) > 0)) return false;
    } else if (!eq(v, cond)) {
      return false;
    }
  }
  return true;
}

function order(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const keys: Array<[string, string]> = (Array.isArray(orderBy) ? orderBy : [orderBy])
    .flatMap((o: Row) => Object.entries(o) as Array<[string, string]>);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const c = cmp(a[k] ?? -Infinity, b[k] ?? -Infinity);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

const DEFAULTS: Record<ModelName, () => Row> = {
  integrationSync: () => ({
    purpose: null, adminBrief: null, sourceKind: 'gsheet', sourceConfig: {}, status: 'DRAFT',
    frequency: 'weekly', runTime: '02:00', dayOfWeek: null, dayOfMonth: null, timezone: 'Asia/Karachi',
    changeCapPct: 25, blankPolicy: 'abnormal', connectionTestedAt: null, connectionFingerprint: null,
    activatedAt: null, approvedVersionId: null, lastSlotAt: null, nextRunAt: null, lastRunAt: null,
    lastRunStatus: null, createdBy: 1,
  }),
  integrationMappingVersion: () => ({
    spec: {}, status: 'DRAFT', adminPrompt: null, aiSummary: null, createdBy: null, approvedBy: null, approvedAt: null,
  }),
  integrationSuggestion: () => ({
    targetKind: 'kpi', transform: null, coverage: null, samples: [], newKpi: null, status: 'PENDING',
    reason: null, carriedFromId: null, decidedBy: null, decidedAt: null,
  }),
  integrationRun: () => ({
    mappingVersionId: null, connectionFingerprint: null, dryRun: false, trigger: 'manual', triggeredBy: 'user:1',
    status: 'RUNNING', result: null, errorMessage: null, finishedAt: null,
  }),
  integrationRunChange: () => ({}),
  kpiDefinition: () => ({
    unit: null, direction: 'up', grain: 'month', sourceIntegrationId: null, isActive: true, createdBy: null,
  }),
  integrationSourceFile: () => ({
    filename: null, mime: null, sizeBytes: null, sha256: null, uploadedBy: null, uploadedAt: new Date(),
  }),
};

export function makeFakeDb() {
  const tables: Record<ModelName, Row[]> = Object.fromEntries(MODELS.map((m) => [m, []])) as any;
  const calls: Call[] = [];
  const raw: Array<{ sql: string; values: unknown[] }> = [];
  let seq = 0;

  function insert(name: ModelName, data: Row): Row {
    const now = new Date();
    const row = { id: `${name}-${++seq}`, ...DEFAULTS[name](), createdAt: now, updatedAt: now, startedAt: now, ...data };
    if (name === 'integrationSync' && tables.integrationSync.some((r) => r.clientNumber === row.clientNumber && r.name === row.name)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    if (name === 'kpiDefinition' && tables.kpiDefinition.some((r) => r.clientNumber === row.clientNumber && r.kpiKey === row.kpiKey)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    tables[name].push(row);
    return row;
  }

  function model(name: ModelName) {
    const rec = (op: string, args: any) => calls.push({ model: name, op, args });
    return {
      findFirst: async (args: any = {}) => {
        rec('findFirst', args);
        return order(tables[name].filter((r) => matches(r, args.where)), args.orderBy)[0] ?? null;
      },
      findUnique: async (args: any = {}) => {
        rec('findUnique', args);
        return tables[name].find((r) => matches(r, args.where)) ?? null;
      },
      findMany: async (args: any = {}) => {
        rec('findMany', args);
        return order(tables[name].filter((r) => matches(r, args.where)), args.orderBy);
      },
      count: async (args: any = {}) => {
        rec('count', args);
        return tables[name].filter((r) => matches(r, args.where)).length;
      },
      create: async (args: any) => {
        rec('create', args);
        return insert(name, args.data);
      },
      createMany: async (args: any) => {
        rec('createMany', args);
        let count = 0;
        for (const d of args.data) {
          try { insert(name, d); count += 1; } catch (e) { if (!args.skipDuplicates) throw e; }
        }
        return { count };
      },
      updateMany: async (args: any) => {
        rec('updateMany', args);
        const hit = tables[name].filter((r) => matches(r, args.where));
        for (const r of hit) Object.assign(r, args.data, { updatedAt: new Date() });
        return { count: hit.length };
      },
      deleteMany: async (args: any) => {
        rec('deleteMany', args);
        const keep = tables[name].filter((r) => !matches(r, args.where));
        const count = tables[name].length - keep.length;
        tables[name] = keep;
        return { count };
      },
    };
  }

  const prisma: any = Object.fromEntries(MODELS.map((m) => [m, model(m)]));

  prisma.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    raw.push({ sql, values });
    if (/^SELECT id FROM integration_syncs .*FOR UPDATE/.test(sql)) {
      const [id, cn] = values;
      return tables.integrationSync.filter((r) => r.id === id && r.clientNumber === cn).map((r) => ({ id: r.id }));
    }
    if (/^UPDATE integration_syncs SET last_slot_at/.test(sql)) {
      // values: slot, next, id, cn, …the guards' own slot parameters.
      const [slot, next, id, cn] = values as [Date, Date | null, string, string];
      const hit = tables.integrationSync.filter((r) => r.id === id && r.clientNumber === cn
        && (!sql.includes("status = 'ACTIVE'") || r.status === 'ACTIVE')
        && (!sql.includes('activated_at <=') || (r.activatedAt != null && r.activatedAt.getTime() <= slot.getTime()))
        && (!sql.includes('last_slot_at IS NULL OR last_slot_at <') || r.lastSlotAt == null || r.lastSlotAt.getTime() < slot.getTime()));
      for (const r of hit) Object.assign(r, { lastSlotAt: slot, nextRunAt: next, updatedAt: new Date() });
      return hit.map((r) => ({ id: r.id }));
    }
    throw new Error(`fake $queryRaw: unexpected SQL: ${sql}`);
  };

  prisma.$transaction = async (fn: (tx: any) => Promise<unknown>) => {
    const snapshot = structuredClone(tables);
    try {
      return await fn(prisma);
    } catch (e) {
      for (const m of MODELS) tables[m] = snapshot[m];
      throw e;
    }
  };

  return { prisma, tables, calls, raw, insert };
}
