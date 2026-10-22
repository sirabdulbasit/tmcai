/**
 * DEF-346 `entity-sweep-query-never-ran` — the CLASS detector (column slice),
 * promoted from DEF-345's per-query test to every raw call site.
 *
 * Twice this class shipped and ran in production for weeks before anyone
 * looked: DEF-337 (two entitySweepService queries, 18,760 log lines/day) and
 * DEF-345 (odooWikiMirror filtering on `config_key`/`config_value` — columns
 * `system_config` never had — 42703 on every execution since it shipped,
 * ~972 swallowed finding occurrences). Both were invalid SQL behind a catch
 * that no build step ever executed. Codex it-82 directive #2: "promote
 * DEF-345's schema-parsed column check into a CI step that validates EVERY
 * $queryRaw* call site's columns against schema.prisma."
 *
 * WHAT THIS VALIDATES (deterministic grammar, zero-false-positive by design):
 * single-statement, single-table, join-free raw queries whose target table is
 * a model in schema.prisma. Within those, identifiers in positions where a
 * column is grammatically REQUIRED: `WHERE/AND/OR <ident> <op>`, `SET <ident>
 * =`, `ORDER BY` / `GROUP BY` lists, `INSERT INTO t (col, …)` lists, and bare
 * single-identifier SELECT items. Everything else — joins, subqueries, CTEs,
 * views (not in the schema), interpolated table names, expressions — is
 * SKIPPED, counted, and reported in the coverage floor below. Under-coverage
 * is stated, not hidden: this closes the wrong-COLUMN class (42703); the
 * semantic class (42P10 — DEF-337's aggregate-in-ORDER-BY) still needs real
 * execution (EXPLAIN against a live schema) and stays named, not claimed.
 *
 * The detector DECIDES nothing — it executes a schema-conformance check, the
 * verification-matrix family. A hit means: this query's first production
 * execution will throw 42703 behind whatever catch wraps it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.join(__dirname, '../src');
const SCHEMA = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');

// ── schema.prisma → { table → Set<column> } ────────────────────────────────
function parseSchema(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = modelRe.exec(SCHEMA))) {
    const body = m[2];
    const mapMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = mapMatch ? mapMatch[1] : m[1];
    const cols = new Set<string>();
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
      const parts = t.split(/\s+/);
      const [field, type] = [parts[0], parts[1] ?? ''];
      if (!/^[A-Za-z_]\w*$/.test(field)) continue;
      if (t.includes('@relation')) continue;            // relation fields are not columns
      if (/^[A-Z]/.test(type)
        && !/^(String|Int|BigInt|Float|Decimal|Boolean|DateTime|Json|Bytes)\??(\[\])?$/.test(type)
        && !/^Unsupported\(/.test(type)) {              // pgvector etc. ARE columns (chunks.vector_embedding, wiki_pages.embedding)
        continue;                                       // model/enum-typed w/o scalar → relation or enum; enums DO map to columns
      }
      const mapped = t.match(/@map\("([^"]+)"\)/);
      cols.add((mapped ? mapped[1] : field).toLowerCase());
    }
    tables.set(table.toLowerCase(), cols);
  }
  return tables;
}

// ── source → raw SQL template literals with file:line ──────────────────────
interface RawSite { file: string; line: number; sql: string }

function extractRawSites(root: string): RawSite[] {
  const sites: RawSite[] = [];
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const callRe = /\$(?:query|execute)Raw(?:Unsafe)?\b/g;
    let c: RegExpExecArray | null;
    while ((c = callRe.exec(src))) {
      // skip to the first backtick within a short window (handles optional
      // generics `<...>`, the open paren, and whitespace)
      let i = c.index + c[0].length;
      const windowEnd = Math.min(src.length, i + 200);
      while (i < windowEnd && src[i] !== '`') {
        if (src[i] === ';' || src[i] === ')') { i = -1; break; }  // not a template call
        i++;
      }
      if (i === -1 || i >= windowEnd || src[i] !== '`') continue;
      // scan the template literal, replacing ${…} with a neutral literal
      let sql = '';
      let j = i + 1;
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { sql += ' '; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1; j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          sql += ' 0 ';                                  // grammatically neutral
          continue;
        }
        sql += src[j]; j++;
      }
      sites.push({ file: path.relative(root, file), line: src.slice(0, c.index).split('\n').length, sql });
    }
  }
  return sites;
}

// ── conservative single-table column validation ────────────────────────────
const CLAUSE_STOP = new Set(['where', 'order', 'group', 'limit', 'offset', 'returning', 'on', 'for', 'set', 'values', 'left', 'right', 'inner', 'outer', 'cross', 'union', 'having', 'as', 'using']);

interface Violation { file: string; line: number; table: string; column: string }
interface ScanResult { validatedQueries: number; skipped: number; violations: Violation[] }

function validateSites(sites: RawSite[], tables: Map<string, Set<string>>): ScanResult {
  const out: ScanResult = { validatedQueries: 0, skipped: 0, violations: [] };
  for (const site of sites) {
    let q = ` ${site.sql} `
      .replace(/--[^\n]*/g, ' ')                        // SQL comments
      .replace(/'(?:[^']|'')*'/g, " '' ")               // string literals
      .replace(/::[a-zA-Z_][\w[\]]*/g, ' ')             // casts
      .replace(/\s+/g, ' ')
      .toLowerCase();

    // structural scope: one statement, one table, no joins/subqueries/CTEs.
    // Statement-type-aware: an UPDATE/INSERT/DELETE containing SELECT or FROM
    // carries a subquery whose columns belong to ANOTHER table (the
    // wiki_page_links link-count subqueries were the measured misattribution),
    // so those are skipped outright; a SELECT must have exactly one of each.
    const selects = (q.match(/\bselect\b/g) ?? []).length;
    const froms = (q.match(/\bfrom\b/g) ?? []).length;
    if (/\bjoin\b|\bwith\b|\bunion\b/.test(q)) { out.skipped++; continue; }

    const target = q.match(/\b(?:from|update|insert\s+into|delete\s+from)\s+([a-z_][a-z0-9_]*)/);
    if (!target || !tables.has(target[1])) { out.skipped++; continue; }
    const isSelect = /^\s*\(?\s*select\b/.test(q.trimStart()) || (selects >= 1 && /^\s*select\b/.test(q.trim()));
    if (isSelect) {
      if (selects !== 1 || froms !== 1) { out.skipped++; continue; }
    } else {
      // UPDATE / INSERT / DELETE: any embedded SELECT or FROM = subquery → skip
      if (selects > 0 || (froms > 0 && !/^\s*delete\b/.test(q.trim()))) { out.skipped++; continue; }
      if (/^\s*delete\b/.test(q.trim()) && froms !== 1) { out.skipped++; continue; }
    }
    const table = target[1];
    const cols = tables.get(table)!;

    // table alias (`FROM open_items oi`) — tolerated as a dotted prefix
    const aliasMatch = q.match(new RegExp(`\\b(?:from|update)\\s+${table}\\s+(?:as\\s+)?([a-z_][a-z0-9_]*)`));
    const alias = aliasMatch && !CLAUSE_STOP.has(aliasMatch[1]) ? aliasMatch[1] : null;
    const SELECT_ALIASES = new Set<string>();
    for (const am of q.matchAll(/\bas\s+([a-z_][a-z0-9_]*)/g)) SELECT_ALIASES.add(am[1]);

    const candidates: string[] = [];
    // WHERE/AND/OR <ident> <op>
    for (const w of q.matchAll(/\b(?:where|and|or)\s+(?:not\s+)?([a-z_][a-z0-9_.]*)\s*(?:=|<>|!=|<=|>=|<|>|\bis\b|\bin\b|\blike\b|\bilike\b|\bbetween\b)/g)) {
      candidates.push(w[1]);
    }
    // SET <ident> = … (first assignment; comma-chained ones between SET and WHERE)
    const setSpan = q.match(/\bset\s+(.*?)(?:\bwhere\b|\breturning\b|$)/);
    if (setSpan) {
      for (const sm of setSpan[1].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/g)) candidates.push(sm[1]);
    }
    // ORDER BY / GROUP BY lists
    for (const ob of q.matchAll(/\b(?:order|group)\s+by\s+([^()]*?)(?=\blimit\b|\boffset\b|\bhaving\b|\bfor\b|$)/g)) {
      for (const item of ob[1].split(',')) {
        const bare = item.trim().replace(/\s+(?:asc|desc)(?:\s+nulls\s+(?:first|last))?$/, '').trim();
        if (/^[a-z_][a-z0-9_.]*$/.test(bare)) candidates.push(bare);
      }
    }
    // INSERT INTO t (col, …)
    const ins = q.match(new RegExp(`\\binsert\\s+into\\s+${table}\\s*\\(([^)]*)\\)`));
    if (ins) for (const item of ins[1].split(',')) {
      const bare = item.trim();
      if (/^[a-z_][a-z0-9_]*$/.test(bare)) candidates.push(bare);
    }
    // bare single-identifier SELECT items (no parens/expressions)
    const sel = q.match(/\bselect\s+(?:distinct\s+)?(.*?)\bfrom\b/);
    if (sel && !sel[1].includes('(')) {
      for (const item of sel[1].split(',')) {
        const bare = item.trim().replace(/\s+as\s+[a-z_][a-z0-9_]*$/, '').trim();
        if (/^[a-z_][a-z0-9_.]*$/.test(bare) && bare !== '*') candidates.push(bare);
      }
    }

    let validatedAny = false;
    const flaggedHere = new Set<string>();
    for (const raw of candidates) {
      let col = raw;
      if (col.includes('.')) {
        const [prefix, suffix] = col.split('.', 2);
        if (prefix === table || (alias && prefix === alias) || prefix === 'excluded') col = suffix;
        else continue;                                   // unknown qualifier — out of scope
      }
      if (SELECT_ALIASES.has(col)) continue;             // `AS n` aliases reused in ORDER BY
      validatedAny = true;
      if (!cols.has(col) && !flaggedHere.has(col)) {
        flaggedHere.add(col);
        out.violations.push({ file: site.file, line: site.line, table, column: col });
      }
    }
    if (validatedAny) out.validatedQueries++; else out.skipped++;
  }
  return out;
}

const tables = parseSchema();

describe('DEF-346 — every validatable raw query references only columns its table actually has', () => {
  it('parses the schema into a usable table map (sanity pins on known models)', () => {
    expect(tables.get('system_config')).toBeDefined();
    expect(tables.get('system_config')!.has('key')).toBe(true);
    expect(tables.get('system_config')!.has('value')).toBe(true);
    expect(tables.get('system_config')!.has('client_number')).toBe(true);
    expect(tables.get('system_config')!.has('config_key')).toBe(false);
    expect(tables.get('brain_health_findings')!.has('subject_id')).toBe(true);
  });

  it('MUTATION CHECK: the detector catches the exact bug DEF-345 fixed (and DEF-337 would have needed execution, said plainly)', () => {
    const oldBug: RawSite = {
      file: 'services/crm/odooWikiMirror.ts', line: 176,
      sql: `SELECT DISTINCT client_number FROM system_config WHERE config_key = 'odoo_url' AND config_value IS NOT NULL AND config_value <> ''`,
    };
    const r = validateSites([oldBug], tables);
    const flagged = r.violations.map((v) => v.column).sort();
    expect(flagged).toEqual(['config_key', 'config_value']);
    // a corrected query on the same table passes
    const fixed = { ...oldBug, sql: `SELECT DISTINCT client_number FROM system_config WHERE key = 'odoo_url' AND value IS NOT NULL AND value <> ''` };
    expect(validateSites([fixed], tables).violations).toEqual([]);
    // wrong ORDER BY column is caught too
    const orderBug = { ...oldBug, sql: `SELECT client_number FROM system_config ORDER BY created_atx DESC` };
    expect(validateSites([orderBug], tables).violations.map((v) => v.column)).toEqual(['created_atx']);
  });

  it('CORPUS: no NEW wrong-column raw queries in server/src — a two-way ratchet over the DB-classified baseline', () => {
    // On the detector's first corpus run (2026-10-22) every violation was
    // classified against the LIVE database's information_schema. Two baselines,
    // both exact — a NEW violation fails, and so does a STALE entry (fixing a
    // query or backfilling the schema must shrink the matching list):
    //
    // (1) PRISMA-DRIFT, DB-VERIFIED: the live DB HAS these columns (added by
    //     hand-written migrations); schema.prisma's models were never updated.
    //     The queries work in production — the defect is the stale schema, and
    //     the prisma backfill is owed (named in DEF-346's row, not built here).
    const PRISMA_DRIFT_DB_VERIFIED = [
      'wa_sender_policy.display_name', 'wa_sender_policy.inbound_count',
      'wa_sender_policy.raw_sender_id', 'wa_sender_policy.resolved_phone',
      'wa_sender_policy.resolved_phone_at',
      'whatsapp_connections.client_number', 'whatsapp_connections.display_name',
      'whatsapp_connections.opt_in', 'whatsapp_connections.opt_in_at',
      'whatsapp_messages.approved_at', 'whatsapp_messages.approved_by',
      'whatsapp_messages.client_number', 'whatsapp_messages.error_message',
      'whatsapp_messages.from_number', 'whatsapp_messages.message_type',
      'whatsapp_messages.requires_approval', 'whatsapp_messages.to_number',
      'whatsapp_messages.updated_at', 'whatsapp_messages.wa_message_id',
      'whatsapp_sessions.client_number',
    ];
    // (2) LATENT 42703s — DEF-347: the live DB does NOT have these columns
    //     (information_schema verified ABSENT, 2026-10-22). These queries have
    //     never executed successfully and will throw on first use — the exact
    //     DEF-337/DEF-345 class, caught in-tree this time. Tracked OPEN as
    //     DEF-347; fixing them must REMOVE entries from this list.
    const KNOWN_LATENT_DEF347 = [
      'agents.display_name', 'agents.gender', 'agents.notify_recipients',
      'agents.notify_whatsapp_numbers', 'agents.personality',
      'brain_prompt_queue.body', 'brain_prompt_queue.created_at',
      'brain_prompt_queue.status', 'brain_prompt_queue.updated_at',
      'users.gender', 'users.preferred_title',
    ];

    const sites = extractRawSites(SRC_ROOT);
    expect(sites.length).toBeGreaterThan(300); // extractor sanity — it actually found the corpus
    const r = validateSites(sites, tables);

    const observed = [...new Set(r.violations.map((v) => `${v.table}.${v.column}`))].sort();
    const baseline = [...new Set([...PRISMA_DRIFT_DB_VERIFIED, ...KNOWN_LATENT_DEF347])].sort();
    const fresh = observed.filter((k) => !baseline.includes(k));
    const stale = baseline.filter((k) => !observed.includes(k));

    const detail = r.violations
      .filter((v) => fresh.includes(`${v.table}.${v.column}`))
      .map((v) => `${v.file}:${v.line} — ${v.table} has no column "${v.column}"`).join('\n');
    expect(fresh, `NEW wrong-column raw queries (would 42703 on first execution):\n${detail}`).toEqual([]);
    expect(stale, 'baseline entries no longer observed — remove them (the ratchet only tightens)').toEqual([]);

    // Coverage floor: if the extractor or validator silently degrades to
    // validating almost nothing, this fails loudly instead of going green.
    expect(r.validatedQueries).toBeGreaterThan(80);
  });
});
