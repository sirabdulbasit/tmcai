/**
 * DEF-362 — Integrations Stage 1b: the Context writer (spec
 * INTEGRATIONS_DESIGN.md §2b "Context writer").
 *
 * Records a mapping marks as Context become tenant-wide Brain knowledge:
 * `org_doc` wiki pages with scope 'tenant', written through the ONE shared
 * helper (knowledge/tenantOrgDoc.upsertTenantOrgDoc) that the FACL folder
 * scribe also uses — never a second knowledge writer.
 *
 *  - per_record: one page per record, titled "<integration name> · <record
 *    title>", capped at integrations.max_context_pages (cap ⇒ run note +
 *    PARTIAL). table: one page holding the chosen columns for the whole set.
 *  - Identity is the RECORD, not the title: metadata.recordKey =
 *    `<integrationId>:<id>` (apiConfig.idField; without one, the title value).
 *    A renamed record keeps its page.
 *  - Unchanged content (sha256 of the body) is skipped, never rewritten.
 *  - A blank never overwrites a section (vm §9): a body field that is blank
 *    this run keeps the value the page last held (metadata.fields).
 *  - Records that disappear are marked 'stale', never deleted — and only when
 *    the read was complete: a record missing from a truncated, capped or empty
 *    read is not known to be gone. The stale FACT lives in
 *    metadata.integrationStale (DEF-362 review): the hourly wiki linter
 *    rewrites wiki_pages.status ('orphan' for every page with no links), so a
 *    status-only mark was undone within the hour and re-staled on every run —
 *    a fresh rewrite each time, until the change cap aborted every scheduled
 *    run. The body also says so, because Brain's retrieval does not filter
 *    by status.
 *  - Page identity never depends on row ORDER (DEF-362 review): one
 *    per_record row owns the bare key — the one recorded as owner on the
 *    stored pages (metadata.keyOwner), else the first by content — and the
 *    others are suffixed with their title field. Rows of a version share
 *    created_at, so position was not stable from run to run.
 *
 * Engine rule: no AI provider is imported here. Re-embedding a changed page is
 * queued by the helper (dynamic import, best effort), not called from here.
 *
 * Why pages are not in the KPI transaction: wiki pages are written through the
 * shared helper on the global client (and queue an embedding), so they cannot
 * join the KPI SQL transaction. Each page's change row is recorded right after
 * that page's successful write instead (AGENTS §2.6 "no mutation without its
 * ledger" — per page), and a page that fails to write gets no change row.
 */
import crypto from 'crypto';
import createLogger from '../../../utils/logger';
import prisma from '../../../db/prisma';
import { getBehaviorValue } from '../../behaviorConfig';
import { upsertTenantOrgDoc } from '../../knowledge/tenantOrgDoc';
import type {
  ApprovedContextRow,
  ContextPagePlan,
  ContextTargetKey,
  ContextTransform,
  ContextWriteOptions,
  ContextWriteResult,
  ContextWriterModule,
} from '../types';

const log = createLogger('integrations-context');

/** wiki_pages.last_updated_by for every page this writer touches. */
export const CONTEXT_WRITER_ACTOR = 'integration';
/** wiki_pages.title is VARCHAR(300). */
const TITLE_MAX = 300;
/** Change rows carry a readable excerpt of the page, not the whole body. */
const CHANGE_VALUE_MAX = 4000;
const PREVIEW_EXAMPLES = 3;
const CHANGE_CHUNK = 1000;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** A planned page, with what the writer needs to apply "blank never overwrites". */
export interface PlannedContextPage extends ContextPagePlan {
  targetKey: ContextTargetKey;
  suggestionId: string;
  /** per_record: the body fields in order, '' where blank this run. null for table. */
  fields: Array<[string, string]> | null;
  /** Display parts, so the body can be rebuilt after a merge. */
  integrationName: string;
  recordTitle: string;
  /** Title with the record id appended — used when another stored page of
   *  this integration already holds `title` (wiki titles are unique). */
  altTitle: string;
  /** per_record: the row's title field, and whether that row owns the bare key. */
  titleField: string | null;
  keyOwner: boolean;
}

export interface ContextPlanResult {
  pages: PlannedContextPage[];
  skipped: number;
  truncated: boolean;
  anomalies: string[];
  /** Every record key the read contained, INCLUDING records that produced no
   *  page (blank body): a record that is still in the source is never stale. */
  presentKeys: Set<string>;
}

/** A stored transform, or null when it is not one this writer can execute. */
export function readContextTransform(raw: unknown): ContextTransform | null {
  const t = (raw ?? {}) as Record<string, unknown>;
  const strList = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every((c) => typeof c === 'string' && c);
  if (t.mode === 'per_record' && typeof t.titleField === 'string' && t.titleField && strList(t.bodyFields)) {
    return { mode: 'per_record', titleField: t.titleField, bodyFields: t.bodyFields };
  }
  if (t.mode === 'table' && strList(t.columns)) return { mode: 'table', columns: t.columns };
  return null;
}

/** Every source field a context transform reads (the run's header check). */
export function contextFieldsRead(t: ContextTransform): string[] {
  return t.mode === 'per_record' ? [t.titleField, ...t.bodyFields] : [...t.columns];
}

/** Deterministic body (no timestamps): the same record always hashes the same. */
export function renderRecordBody(integrationName: string, recordTitle: string, fields: Array<[string, string]>): string {
  const lines = [
    `# ${integrationName} · ${recordTitle}`,
    '',
    `**Source:** Integration "${integrationName}"`,
    '',
  ];
  for (const [k, v] of fields) if (v !== '') lines.push(`${k}: ${v}`);
  return lines.join('\n');
}

function cell(v: string): string {
  return v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderTableBody(integrationName: string, columns: string[], records: Record<string, string>[]): string {
  const lines = [
    `# ${integrationName}`,
    '',
    `**Source:** Integration "${integrationName}" — ${records.length} record(s)`,
    '',
    `| ${columns.map(cell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const r of records) lines.push(`| ${columns.map((c) => cell(String(r[c] ?? '').trim())).join(' | ')} |`);
  return lines.join('\n');
}

/**
 * PURE: approved context rows × records ⇒ pages. per_record pages stop at
 * `maxPages` (truncated); table rows give one page each.
 */
export function planContextPages(
  integ: { id: string; name: string },
  records: Record<string, string>[],
  rows: ApprovedContextRow[],
  idField: string | null,
  maxPages: number,
  /** The title field of the per_record row that owns the bare key on the
   *  stored pages (bareKeyOwner(stored)); null/absent on a first run. */
  bareKeyTitleField: string | null = null,
): ContextPlanResult {
  const pages: PlannedContextPage[] = [];
  const anomalies: string[] = [];
  const presentKeys = new Set<string>();
  let skipped = 0;
  let truncated = false;
  let notPlanned = 0;
  const titles = new Set<string>();
  // By content, never by load order (rows of a version share created_at).
  const sig = (r: ApprovedContextRow): string => (r.transform.mode === 'per_record'
    ? `${r.transform.titleField}\u0000${r.transform.bodyFields.join('\u0000')}`
    : r.transform.columns.join('\u0000'));
  const byContent = (a: ApprovedContextRow, b: ApprovedContextRow) => {
    const x = sig(a); const y = sig(b);
    return x < y ? -1 : x > y ? 1 : a.suggestionId < b.suggestionId ? -1 : a.suggestionId > b.suggestionId ? 1 : 0;
  };
  const perRecordRows = rows.filter((r) => r.transform.mode === 'per_record').sort(byContent);
  const tableRows = rows.filter((r) => r.transform.mode === 'table').sort(byContent);
  const ownerIdx = Math.max(0, perRecordRows.findIndex((r) =>
    (r.transform as Extract<ContextTransform, { mode: 'per_record' }>).titleField === bareKeyTitleField));
  const suffixesUsed = new Set<string>();
  let noTitle = 0;
  let noId = 0;
  let dupId = 0;
  let allBlank = 0;

  perRecordRows.forEach((row, ri) => {
    const t = row.transform as Extract<ContextTransform, { mode: 'per_record' }>;
    // Two per_record rows over the same records must not share page identity:
    // the owner keeps the bare key, the others carry their title field (and,
    // for two rows on the same title field, a hash of their body fields).
    const keyOwner = ri === ownerIdx;
    let suffix = keyOwner ? '' : `#${t.titleField}`;
    if (!keyOwner && suffixesUsed.has(suffix)) suffix = `${suffix}~${sha256(t.bodyFields.join('\u0000')).slice(0, 8)}`;
    suffixesUsed.add(suffix);
    const seenKeys = new Set<string>();
    records.forEach((rec, i) => {
      const title = String(rec[t.titleField] ?? '').trim();
      const idVal = idField ? String(rec[idField] ?? '').trim() : title;
      if (!idVal) { skipped += 1; if (idField) noId += 1; else noTitle += 1; return; }
      const recordKey = `${integ.id}:${idVal}${suffix}`;
      if (seenKeys.has(recordKey)) { skipped += 1; dupId += 1; return; }
      seenKeys.add(recordKey);
      presentKeys.add(recordKey);
      if (!title) { skipped += 1; noTitle += 1; return; }
      const fields: Array<[string, string]> = t.bodyFields.map((f) => [f, String(rec[f] ?? '').trim()]);
      if (fields.every(([, v]) => v === '')) { skipped += 1; allBlank += 1; return; }
      if (pages.length >= maxPages) { truncated = true; notPlanned += 1; return; }
      let display = clip(`${integ.name} · ${title}`, TITLE_MAX);
      const altTitle = clip(`${integ.name} · ${title} (${idVal})`, TITLE_MAX);
      // wiki_pages is unique on (tenant, user, type, title): two records with
      // the same title get the id appended rather than colliding.
      if (titles.has(display)) display = altTitle;
      titles.add(display);
      const body = renderRecordBody(integ.name, title, fields);
      pages.push({
        recordKey, title: display, body, contentHash: sha256(body),
        sourceKey: clip(`record ${i + 1} › ${idField ?? t.titleField}=${idVal}`, 255),
        targetKey: 'context:per_record', suggestionId: row.suggestionId, fields,
        integrationName: integ.name, recordTitle: title, altTitle, titleField: t.titleField, keyOwner,
      });
    });
  });

  tableRows.forEach((row, ri) => {
    const t = row.transform as Extract<ContextTransform, { mode: 'table' }>;
    const recordKey = `${integ.id}:table${ri === 0 ? '' : `#${ri + 1}`}`;
    presentKeys.add(recordKey);
    // An empty read never overwrites a filled table (blank never overwrites).
    if (records.length === 0) { skipped += 1; return; }
    const title = clip(`${integ.name} · All records${ri === 0 ? '' : ` (${ri + 1})`}`, TITLE_MAX);
    titles.add(title);
    const body = renderTableBody(integ.name, t.columns, records);
    pages.push({
      recordKey, title, body, contentHash: sha256(body),
      sourceKey: clip(`${records.length} record(s) › ${t.columns.join(', ')}`, 255),
      targetKey: 'context:table', suggestionId: row.suggestionId, fields: null,
      integrationName: integ.name, recordTitle: 'All records',
      altTitle: clip(`${integ.name} · All records (${ri + 1})`, TITLE_MAX), titleField: null, keyOwner: false,
    });
  });

  if (noId) anomalies.push(`${noId} record(s) have no "${idField}" value, so they cannot become knowledge pages.`);
  if (noTitle) anomalies.push(`${noTitle} record(s) have a blank title field and produced no knowledge page.`);
  if (dupId) anomalies.push(`${dupId} record(s) repeat an id already seen in this read; only the first became a page.`);
  if (allBlank) anomalies.push(`${allBlank} record(s) had every chosen field blank; their pages were left as they were.`);
  if (truncated) {
    anomalies.push(`Only the first ${maxPages} knowledge pages were written; ${notPlanned} more record(s) were not `
      + '(limit integrations.max_context_pages). Narrow the filter or use a table page.');
  }
  return { pages, skipped, truncated, anomalies, presentKeys };
}

// ── Diff against what is stored ─────────────────────────────────────────────

export interface StoredContextPage {
  id: string;
  title: string;
  status: string | null;
  metadata: unknown;
  bodyMarkdown: string | null;
}

export type ContextOp =
  | { op: 'create'; page: PlannedContextPage }
  | { op: 'update'; page: PlannedContextPage; existing: StoredContextPage }
  | { op: 'stale'; existing: StoredContextPage; recordKey: string };

export interface ContextDiff {
  ops: ContextOp[];
  unchanged: number;
  /** Pages this integration already has (any status) — the change cap's base. */
  owned: number;
  anomalies: string[];
}

function metaOf(p: StoredContextPage): Record<string, unknown> {
  return (p.metadata && typeof p.metadata === 'object' ? p.metadata : {}) as Record<string, unknown>;
}

/** Marked stale by THIS writer — the metadata flag, never wiki_pages.status
 *  (the hourly linter rewrites that; see header). */
export function isIntegrationStale(p: StoredContextPage): boolean {
  return metaOf(p).integrationStale === true;
}

/** The title field of the per_record row that owns the bare page key, as
 *  recorded on the stored pages; null when none is recorded. */
export function bareKeyOwner(stored: StoredContextPage[]): string | null {
  for (const s of stored) {
    const m = metaOf(s);
    if (m.keyOwner === true && typeof m.titleField === 'string') return m.titleField;
  }
  return null;
}

/** The line a stale page's body ends with, so Brain reading it knows. */
export const STALE_NOTE = '> This record is no longer in the source (marked stale by the integration).';

/** The pages this integration wrote before (tenant-scoped; keyed by metadata). */
export async function loadStoredContextPages(cn: string, integrationId: string): Promise<StoredContextPage[]> {
  return prisma.wikiPage.findMany({
    where: { clientNumber: cn, pageType: 'org_doc', metadata: { path: ['integrationId'], equals: integrationId } } as any,
    select: { id: true, title: true, status: true, metadata: true, bodyMarkdown: true },
  }) as unknown as Promise<StoredContextPage[]>;
}

/**
 * Applies "blank never overwrites" (a blank field keeps the page's last value)
 * and classifies every page as create / update / unchanged / stale.
 * `sourceComplete` = the read was not truncated; stale marking needs it.
 */
export function diffContextPages(plan: ContextPlanResult, stored: StoredContextPage[], recordsInRead: number, sourceComplete: boolean): ContextDiff {
  const byKey = new Map<string, StoredContextPage>();
  for (const s of stored) {
    const k = metaOf(s).recordKey;
    if (typeof k === 'string' && !byKey.has(k)) byKey.set(k, s);
  }
  // Titles the stored pages hold, by record key: a planned title another
  // record's page still holds (a stale page included) would fail the write on
  // the unique title — every run (DEF-362 review) — so it takes the id form.
  const titleHeldBy = new Map<string, string>();
  for (const s of stored) {
    const k = metaOf(s).recordKey;
    if (typeof k === 'string' && !titleHeldBy.has(s.title)) titleHeldBy.set(s.title, k);
  }
  const ops: ContextOp[] = [];
  const anomalies: string[] = [];
  let unchanged = 0;
  for (const planned0 of plan.pages) {
    const ex = byKey.get(planned0.recordKey);
    const holder = titleHeldBy.get(planned0.title);
    const planned = holder !== undefined && holder !== planned0.recordKey ? { ...planned0, title: planned0.altTitle } : planned0;
    let page = planned;
    if (ex && planned.fields) {
      const prev = metaOf(ex).fields as Record<string, unknown> | undefined;
      if (prev && typeof prev === 'object') {
        const merged: Array<[string, string]> = planned.fields.map(([k, v]) =>
          [k, v !== '' ? v : (typeof prev[k] === 'string' ? prev[k] as string : '')]);
        const body = renderRecordBody(planned.integrationName, planned.recordTitle, merged);
        page = { ...planned, fields: merged, body, contentHash: sha256(body) };
      }
    }
    if (!ex) ops.push({ op: 'create', page });
    else if (metaOf(ex).contentHash === page.contentHash && !isIntegrationStale(ex)) unchanged += 1;
    else ops.push({ op: 'update', page, existing: ex });
  }
  const live = stored.filter((s) => !isIntegrationStale(s) && typeof metaOf(s).recordKey === 'string'
    && !plan.presentKeys.has(metaOf(s).recordKey as string));
  if (live.length) {
    if (!sourceComplete || plan.truncated) {
      anomalies.push(`${live.length} knowledge page(s) were not seen in this read; it was incomplete, so none was marked stale.`);
    } else if (recordsInRead === 0) {
      // An empty read is far more often a broken source than every record
      // leaving at once — blank never overwrites, so nothing goes stale.
      anomalies.push(`The read returned no records, so the ${live.length} existing knowledge page(s) were left as they were.`);
    } else {
      for (const s of live) ops.push({ op: 'stale', existing: s, recordKey: metaOf(s).recordKey as string });
    }
  }
  return { ops, unchanged, owned: stored.length, anomalies };
}

/** Rewrites of what the integration already holds (updates + stale marks) —
 *  the change cap's numerator, exactly like a KPI reading rewrite. */
export function contextRewrites(diff: ContextDiff): number {
  return diff.ops.filter((o) => o.op !== 'create').length;
}

export function previewNote(diff: ContextDiff): string | null {
  const by = (op: ContextOp['op']) => diff.ops.filter((o) => o.op === op);
  const parts: string[] = [];
  for (const [op, verb] of [['create', 'create'], ['update', 'update'], ['stale', 'mark stale']] as const) {
    const list = by(op);
    if (!list.length) continue;
    const ex = list.slice(0, PREVIEW_EXAMPLES).map((o) => `"${o.op === 'stale' ? o.existing.title : o.page.title}"`);
    parts.push(`${verb} ${list.length} (e.g. ${ex.join(', ')})`);
  }
  if (!parts.length) return diff.unchanged ? `Knowledge pages: all ${diff.unchanged} unchanged.` : null;
  return `Knowledge pages: would ${parts.join('; ')}${diff.unchanged ? `; ${diff.unchanged} unchanged` : ''}.`;
}

function changeRow(cn: string, integrationId: string, runId: string, o: ContextOp) {
  if (o.op === 'stale') {
    return {
      clientNumber: cn, integrationId, runId, targetKind: 'context', op: 'stale',
      subjectKey: clip(o.recordKey, 255), subjectLabel: clip(o.existing.title, 255),
      targetKey: typeof metaOf(o.existing).targetKey === 'string' ? metaOf(o.existing).targetKey as string : 'context:per_record',
      sourceKey: 'no longer in the source',
      beforeValue: o.existing.bodyMarkdown ? clip(o.existing.bodyMarkdown, CHANGE_VALUE_MAX) : null,
      afterValue: null,
    };
  }
  return {
    clientNumber: cn, integrationId, runId, targetKind: 'context', op: o.op,
    subjectKey: clip(o.page.recordKey, 255), subjectLabel: clip(o.page.title, 255),
    targetKey: o.page.targetKey, sourceKey: o.page.sourceKey,
    beforeValue: o.op === 'update' && o.existing.bodyMarkdown ? clip(o.existing.bodyMarkdown, CHANGE_VALUE_MAX) : null,
    afterValue: clip(o.page.body, CHANGE_VALUE_MAX),
  };
}

export interface ApplyContextResult {
  created: number;
  updated: number;
  stale: number;
  unchangedRace: number;
  failed: number;
  anomalies: string[];
}

/**
 * Dry run: the preview change rows only — no wiki page is touched.
 * Live: each page through upsertTenantOrgDoc, then ITS change row; each stale
 * mark, then its change row. One page failing is counted and reported; the
 * others still land (pages cannot share one SQL transaction — see header).
 */
export async function applyContextDiff(
  cn: string,
  integ: { id: string; name: string },
  diff: ContextDiff,
  opts: ContextWriteOptions,
): Promise<ApplyContextResult> {
  const out: ApplyContextResult = { created: 0, updated: 0, stale: 0, unchangedRace: 0, failed: 0, anomalies: [] };
  if (opts.dryRun) {
    const rows = diff.ops.map((o) => changeRow(cn, integ.id, opts.runId, o));
    for (let i = 0; i < rows.length; i += CHANGE_CHUNK) {
      await prisma.integrationRunChange.createMany({ data: rows.slice(i, i + CHANGE_CHUNK) });
    }
    for (const o of diff.ops) out[o.op === 'create' ? 'created' : o.op === 'update' ? 'updated' : 'stale'] += 1;
    return out;
  }
  const failures: string[] = [];
  for (const o of diff.ops) {
    try {
      if (o.op === 'stale') {
        const now = new Date();
        const body = o.existing.bodyMarkdown ?? '';
        const r = await prisma.wikiPage.updateMany({
          where: { id: o.existing.id, clientNumber: cn } as any,
          data: {
            status: 'stale',
            metadata: { ...metaOf(o.existing), integrationStale: true, staleAt: now.toISOString(), lastRunId: opts.runId } as any,
            ...(body.includes(STALE_NOTE) ? {} : { bodyMarkdown: `${body}${body ? '\n\n' : ''}${STALE_NOTE}` }),
            lastUpdatedBy: CONTEXT_WRITER_ACTOR, lastUpdatedAt: now,
          },
        });
        if (r.count === 0) { out.unchangedRace += 1; continue; }
        await prisma.integrationRunChange.create({ data: changeRow(cn, integ.id, opts.runId, o) });
        out.stale += 1;
        continue;
      }
      const p = o.page;
      const metadata: Record<string, unknown> = {
        integrationId: integ.id,
        recordKey: p.recordKey,
        targetKey: p.targetKey,
        contentHash: p.contentHash,
        scope: 'tenant', // readable by every user in the tenant
        source: 'integration',
        lastRunId: opts.runId,
        // Page-identity owner (see header); integrationStale is deliberately
        // absent, so a record that comes back is live again.
        ...(p.titleField ? { titleField: p.titleField, keyOwner: p.keyOwner } : {}),
        ...(p.fields ? { fields: Object.fromEntries(p.fields.filter(([, v]) => v !== '')) } : {}),
      };
      const r = await upsertTenantOrgDoc(cn, {
        userId: opts.userId, title: p.title, body: p.body, metadata, contentHash: p.contentHash,
        lastUpdatedBy: CONTEXT_WRITER_ACTOR,
        existing: o.op === 'update' ? o.existing : null,
      });
      if (!r.changed) { out.unchangedRace += 1; continue; }
      await prisma.integrationRunChange.create({ data: changeRow(cn, integ.id, opts.runId, o) });
      if (o.op === 'create') out.created += 1; else out.updated += 1;
    } catch (err) {
      out.failed += 1;
      const code = (err as { code?: string } | null)?.code;
      const label = o.op === 'stale' ? o.existing.title : o.page.title;
      if (failures.length < PREVIEW_EXAMPLES) {
        failures.push(code === 'P2002' ? `"${label}" (a knowledge page with that title already exists)` : `"${label}"`);
      }
      log.warn('context page write failed', { clientNumber: cn, integrationId: integ.id, runId: opts.runId, op: o.op, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (out.failed) out.anomalies.push(`${out.failed} knowledge page(s) could not be saved: ${failures.join(', ')}${out.failed > failures.length ? ', …' : ''}.`);
  return out;
}

/** behavior integrations.max_context_pages (default 500). */
export async function maxContextPages(cn: string): Promise<number> {
  return getBehaviorValue('integrations.max_context_pages', { clientNumber: cn }).catch(() => 500);
}

/** The whole contract call: plan, diff, write (or preview). `sourceComplete`
 *  (default true) must be false when the read was truncated. */
export const writeContextPages = async (
  cn: string,
  integ: { id: string; name: string },
  records: Record<string, string>[],
  rows: ApprovedContextRow[],
  opts: ContextWriteOptions & { sourceComplete?: boolean; maxPages?: number },
): Promise<ContextWriteResult> => {
  const stored = await loadStoredContextPages(cn, integ.id);
  const plan = planContextPages(integ, records, rows, opts.idField, opts.maxPages ?? await maxContextPages(cn), bareKeyOwner(stored));
  const diff = diffContextPages(plan, stored, records.length, opts.sourceComplete ?? true);
  const applied = await applyContextDiff(cn, integ, diff, opts);
  return {
    created: applied.created,
    updated: applied.updated,
    unchanged: diff.unchanged + applied.unchangedRace,
    stale: applied.stale,
    skipped: plan.skipped,
    truncated: plan.truncated,
    anomalies: [...plan.anomalies, ...diff.anomalies, ...applied.anomalies],
  };
};

export const contextWriter: ContextWriterModule = { planContextPages, writeContextPages };
