/**
 * Tenant-scoping audit.
 *
 * Sprint 3 (2026-05-21). Per Basit's zero-tolerance constraint on
 * cross-tenant / cross-user data leakage: this script greps every
 * `prisma.<model>.find*` call in server/src and reports any whose
 * surrounding 6-line context doesn't include `userId` OR
 * `clientNumber`. Output is a punch list — fix or whitelist each.
 *
 * Models exempt from the check (tenant-shared by design):
 *   - Tenant
 *   - TenantConnectorConfig
 *   - WikiPage (tenant scope rows are valid cross-user)
 *   - SystemCapabilities
 *
 * Per-model whitelisted call sites can be marked with a
 * `// tenant-audit:exempt <reason>` comment on the same line.
 *
 * Usage:
 *   npx ts-node src/scripts/auditTenantScopedQueries.ts > audit-report.md
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PRISMA_CALL_RE = /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\b/;
const EXEMPT_COMMENT = /\/\/\s*tenant-audit:\s*exempt/i;

/** Models that are genuinely tenant-shared. Queries against these
 *  don't need userId/clientNumber filters by design. */
const EXEMPT_MODELS = new Set([
  'tenant',
  'tenantConnectorConfig',
  'tenantWhatsappNotifier',
  'wikiPage',          // many tenant-scoped lookups; per-call review
  'systemCapability',
  'session',           // auth sessions, server-internal
  // Add models here as we whitelist them with explicit reasoning.
]);

interface Finding {
  file: string;
  line: number;
  snippet: string;
  model: string;
  call: string;
  reason: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function inspectFile(file: string): Finding[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(PRISMA_CALL_RE);
    if (!m) continue;
    const model = m[1];
    const call = m[2];
    if (EXEMPT_MODELS.has(model)) continue;
    if (EXEMPT_COMMENT.test(line)) continue;
    // Inspect the next 12 lines (typical where-clause window) for
    // userId or clientNumber as a filter key. Cheap heuristic: a
    // bare mention is enough — false positives are easier to dismiss
    // than missed leaks. Also check trailing `// tenant-audit: exempt`.
    const window = lines.slice(i, Math.min(lines.length, i + 12)).join('\n');
    if (EXEMPT_COMMENT.test(window)) continue;
    const hasUserId = /\buserId\b\s*[:=]/.test(window);
    const hasClientNumber = /\bclientNumber\b\s*[:=]/.test(window);
    if (hasUserId || hasClientNumber) continue;
    // Suspicious. Record finding.
    findings.push({
      file: path.relative(ROOT, file),
      line: i + 1,
      snippet: line.trim(),
      model,
      call,
      reason: 'no userId or clientNumber in the next 12 lines',
    });
  }
  return findings;
}

function main() {
  const files = walk(ROOT);
  const allFindings: Finding[] = [];
  for (const f of files) {
    allFindings.push(...inspectFile(f));
  }
  // Group by model.
  const byModel = new Map<string, Finding[]>();
  for (const f of allFindings) {
    const list = byModel.get(f.model) ?? [];
    list.push(f);
    byModel.set(f.model, list);
  }
  // Markdown report.
  const lines: string[] = [];
  lines.push('# Tenant-Scoping Audit');
  lines.push('');
  lines.push(`Scanned ${files.length} TypeScript files. Found ${allFindings.length} suspicious calls.`);
  lines.push('');
  lines.push('Each entry below shows a `prisma.<model>.find*` call whose surrounding 12 lines do NOT contain `userId` or `clientNumber` as a filter key. Review each:');
  lines.push('- If the call is intentionally tenant-shared, add `// tenant-audit: exempt <reason>` on the line.');
  lines.push('- If the model itself is tenant-shared by design, add it to EXEMPT_MODELS in the audit script.');
  lines.push('- Otherwise, FIX by adding `userId` and/or `clientNumber` to the `where` clause.');
  lines.push('');
  const sortedModels = Array.from(byModel.keys()).sort();
  for (const model of sortedModels) {
    const fs2 = byModel.get(model)!;
    lines.push(`## \`prisma.${model}\` — ${fs2.length} finding${fs2.length === 1 ? '' : 's'}`);
    lines.push('');
    for (const f of fs2) {
      lines.push(`- \`${f.file}:${f.line}\` (${f.call})`);
      lines.push(`  - ${f.snippet}`);
    }
    lines.push('');
  }
  console.log(lines.join('\n'));
  // Exit non-zero if findings, so CI can gate.
  process.exit(allFindings.length > 0 ? 1 : 0);
}

main();
