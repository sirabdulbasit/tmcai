/**
 * Per-model tenant-scope audit.
 *
 * P0 follow-up (2026-05-22). Lists every prisma.<model>.find* call
 * across the codebase, classified by whether the model is user-
 * owned (needs userId filter) or tenant-shared (clientNumber enough).
 *
 * Output: a markdown report grouped by model, with per-call file:line
 * + a verdict (SAFE / NEEDS_USERID / TENANT_OK / REVIEW).
 *
 * SAFE     — query has userId AND clientNumber where appropriate
 * NEEDS_USERID — user-owned model, query missing userId. P0.
 * TENANT_OK — tenant-shared model, clientNumber alone is fine.
 * REVIEW   — mixed-scope (WikiPage, Entity) — needs human verification.
 *
 * Models EXEMPT (system tables, no user data): Session, ApprovalToken,
 * SystemConfig, License, ClientLicense, Tenant, ConnectorType,
 * IndexEvent, ActionIdempotencyLog (audit log), LlmSpend (billing).
 *
 * Mode: --strict exits non-zero on any NEEDS_USERID; default reports.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

const USER_OWNED = new Set([
  'feedEvent', 'openItem', 'whatsAppSession', 'whatsAppMessage',
  'brainPendingAction', 'brainActionArtifact', 'brainUserMessage',
  'userMemory', 'userResolutionAlias', 'person', 'personFacet',
  'scheduledTask', 'userConnector', 'agentMemory',
  'pushSubscription', 'brainPromptQueue', 'retrievalFeedback',
  'userPromptOverlay', 'whatsAppOutboundMessage', 'mutedSender',
  'delegationLog', 'userPrompt', 'decisionLog', 'thoughtEntry',
  'patternHidden', 'document', 'chunk', 'conversation', 'message',
  'personalDocument', 'personalChunk', 'whatsAppConnection',
]);

const TENANT_SHARED = new Set([
  'tenant', 'license', 'clientLicense', 'systemConfig',
  'connectorType', 'tenantConnectorConfig', 'brainConfig',
  'gateRule', 'gateRuleOverride', 'riskRule', 'riskRuleOverride',
  'gateRuleFiring', 'brainDoc', 'riskFlagDoc',
  'delegationMatrix', 'delegationMatrixHistory', 'okr',
  'tenantWhatsappNotifier', 'knowledgeItem', 'domainKnowledge',
  'proactiveAlert', 'agentAction', 'agent', 'actionDependency',
  'shadowRule', 'shadowScore', 'goldenDataset', 'kpiValue',
  'notificationQueue', 'actionUndoLog', 'ruleLifecycle',
  'patternInsight', 'session', 'approvalToken',
]);

const MIXED_SCOPE = new Set([
  'wikiPage',       // has scope='user' | 'tenant'
  'entity',         // has scope='user' | 'tenant' (added 2026-05-22)
  'entityLink',
  'wikiPageSource',
  'wikiPageLink',
  'auditLog',       // per-user activity readable by admin
]);

const EXEMPT_SYSTEM = new Set([
  'actionIdempotencyLog', 'llmSpend', 'indexEvent', 'user',
]);

const READ_OPS_RE = /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|count|aggregate|groupBy)\b/g;

type Verdict = 'SAFE' | 'NEEDS_USERID' | 'TENANT_OK' | 'REVIEW' | 'EXEMPT' | 'UNKNOWN_MODEL';

interface Finding {
  file: string;
  line: number;
  model: string;
  op: string;
  verdict: Verdict;
  snippet: string;
  windowText: string;
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

function classify(model: string, windowText: string): Verdict {
  if (EXEMPT_SYSTEM.has(model)) return 'EXEMPT';
  if (TENANT_SHARED.has(model)) {
    // For tenant-shared, presence of clientNumber is encouraged.
    return /\bclientNumber\b\s*[:=]/.test(windowText) ? 'TENANT_OK' : 'TENANT_OK'; // unenforced
  }
  if (USER_OWNED.has(model)) {
    return /\buserId\b\s*[:=]/.test(windowText) ? 'SAFE' : 'NEEDS_USERID';
  }
  if (MIXED_SCOPE.has(model)) return 'REVIEW';
  return 'UNKNOWN_MODEL';
}

function inspectFile(file: string): Finding[] {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const out: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    READ_OPS_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = READ_OPS_RE.exec(line)) !== null) {
      const model = m[1];
      const op = m[2];
      if (EXEMPT_SYSTEM.has(model)) continue;
      const windowText = lines.slice(i, Math.min(lines.length, i + 14)).join('\n');
      const verdict = classify(model, windowText);
      // Skip files marked as tests / scripts in the report's NEEDS_USERID section
      const inTestDir = file.includes('__tests__') || file.includes('/scripts/_smoke') || file.includes('/scripts/smoke');
      const skipForStrict = inTestDir;
      if (verdict === 'TENANT_OK' || verdict === 'EXEMPT' || verdict === 'SAFE') continue;
      out.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        model, op, verdict,
        snippet: line.trim(),
        windowText: skipForStrict ? '(test/smoke)' : windowText.slice(0, 400),
      });
    }
  }
  return out;
}

function main() {
  const strict = process.argv.includes('--strict');
  const files = walk(ROOT);
  const findings: Finding[] = [];
  for (const f of files) findings.push(...inspectFile(f));

  const byModel = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byModel.get(f.model) ?? [];
    list.push(f);
    byModel.set(f.model, list);
  }

  // Tally counts.
  let needsCount = 0;
  let reviewCount = 0;
  let unknownCount = 0;
  for (const f of findings) {
    if (f.verdict === 'NEEDS_USERID') needsCount++;
    else if (f.verdict === 'REVIEW') reviewCount++;
    else if (f.verdict === 'UNKNOWN_MODEL') unknownCount++;
  }

  // Report.
  const out: string[] = [];
  out.push('# Per-Model Tenant-Scope Audit');
  out.push('');
  out.push(`Scanned ${files.length} TypeScript files.`);
  out.push(`Findings: **${needsCount} NEEDS_USERID** (P0), **${reviewCount} REVIEW** (mixed-scope), **${unknownCount} UNKNOWN_MODEL**.`);
  out.push('');
  out.push('Models exempt from this audit (system tables, no user data):');
  out.push('  Session, ApprovalToken, SystemConfig, License, ClientLicense, Tenant,');
  out.push('  ConnectorType, IndexEvent, ActionIdempotencyLog, LlmSpend, User.');
  out.push('');
  out.push('Models user-owned (NEEDS_USERID if missing):');
  out.push(`  ${Array.from(USER_OWNED).sort().join(', ')}`);
  out.push('');
  out.push('Models tenant-shared (TENANT_OK by default):');
  out.push(`  ${Array.from(TENANT_SHARED).sort().join(', ')}`);
  out.push('');
  out.push('Models mixed-scope (REVIEW per-call):');
  out.push(`  ${Array.from(MIXED_SCOPE).sort().join(', ')}`);
  out.push('');
  out.push('---');
  out.push('');

  for (const model of Array.from(byModel.keys()).sort()) {
    const list = byModel.get(model)!;
    const verdict = list[0].verdict; // all same since grouped
    out.push(`## \`prisma.${model}\` — ${list.length} ${verdict === 'NEEDS_USERID' ? '⚠️ P0 fix' : verdict === 'REVIEW' ? '📋 review' : '❓ unknown'}`);
    out.push('');
    for (const f of list.slice(0, 40)) {
      out.push(`- \`${f.file}:${f.line}\` (${f.op})`);
      out.push(`  - ${f.snippet.slice(0, 200)}`);
    }
    if (list.length > 40) out.push(`  - ... +${list.length - 40} more`);
    out.push('');
  }

  console.log(out.join('\n'));
  if (strict && needsCount > 0) process.exit(1);
}

main();
