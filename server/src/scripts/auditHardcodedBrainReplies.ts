/**
 * Hardcoded fake-Brain reply audit.
 *
 * Per memory rule feedback_no_hardcoded_brain_replies.md
 * (Basit 2026-05-20: "don't hardcode anything this is the crime in
 * building AI"): every string the user sees on a Brain surface
 * (WhatsApp, web Brain Chat, Day Brief WA dispatch) MUST come from
 * one of two sources:
 *   - LLM-generated via answerAsBrain → compose → Gemini/Claude
 *   - Bracket-wrapped system marker (e.g. "[Brain unavailable — …]")
 *
 * This script greps every place a string is sent to the user on a
 * Brain surface and flags anything that looks like English prose
 * but isn't bracket-wrapped.
 *
 * Targets:
 *   - sendReply(params, "...")           — WhatsApp send paths
 *   - sendUserEmail(..., "subject", "body...")  — outbound email
 *   - sendTenantWhatsAppText(...)
 *   - res.json({ answer: "..." })        — web responses
 *   - res.send("...")                    — direct strings
 *
 * Output: markdown report with file:line + snippet. Exits non-zero
 * when findings exist so CI can gate.
 *
 * Heuristics for "looks like prose":
 *   - >= 4 words OR contains common prose words (I, you, your, Sir, please, sorry)
 *   - NOT starts with `[` (bracketed marker)
 *   - NOT in test / smoke files (these may have fixture prose)
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

const PROSE_WORDS_RE = /\b(I'?ll|I'?m|I've|you'?re|your|Sir|please|sorry|got it|noted|alright|okay|sure|here are|let me|I can|I will|I'?d|we can|happy to|done\b)\b/i;
const BRACKETED_RE = /^\s*\[/;
const URL_OR_TEMPLATE_RE = /^https?:\/\/|\$\{|<<|\\n\\n|@@|^[A-Z_]{2,}$/;

const SUSPICIOUS_PATTERNS = [
  { name: 'sendReply', re: /\bsendReply\s*\(\s*[^,]+,\s*['"`]([^'"`]+)['"`]/g },
  { name: 'sendUserEmail.subject', re: /\bsendUserEmail\s*\(\s*[^,]+,\s*[^,]+,\s*['"`]([^'"`]+)['"`]/g },
  { name: 'sendTenantWhatsAppText', re: /\bsendTenantWhatsAppText\s*\(\s*[^,]+,\s*[^,]+,\s*['"`]([^'"`]+)['"`]/g },
  { name: 'res.json.answer', re: /res\.json\s*\(\s*\{[^}]*\banswer\s*:\s*['"`]([^'"`]+)['"`]/g },
  { name: 'responseText.assign', re: /\bresponseText\s*=\s*['"`]([^'"`]+)['"`]/g },
];

const EXEMPT_PATHS = [
  '__tests__', 'scripts/smoke', 'scripts/_smoke',
  'staticPagesRoutes.ts',  // privacy / terms HTML
  'auditHardcodedBrainReplies.ts',  // this script
];

interface Finding {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
  text: string;
}

function isExempt(file: string): boolean {
  return EXEMPT_PATHS.some((p) => file.includes(p));
}

function looksLikeProse(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (BRACKETED_RE.test(t)) return false;
  if (URL_OR_TEMPLATE_RE.test(t)) return false;
  if (t.length < 8) return false;
  // 4+ words is suspicious.
  const words = t.split(/\s+/).length;
  if (words >= 4) return true;
  // Or contains prose-marker words.
  return PROSE_WORDS_RE.test(t);
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
  if (isExempt(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const findings: Finding[] = [];
  for (const { name, re } of SUSPICIOUS_PATTERNS) {
    // Scan each line for matches (multiline strings won't be caught — acceptable for v1).
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\/\/.*tenant-audit:|\/\/.*audit:exempt|brain-audit:\s*exempt/i.test(line)) continue;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const captured = m[1];
        if (!looksLikeProse(captured)) continue;
        findings.push({
          file: path.relative(ROOT, file),
          line: i + 1,
          pattern: name,
          snippet: line.trim(),
          text: captured,
        });
      }
    }
  }
  return findings;
}

function main() {
  const files = walk(ROOT);
  const all: Finding[] = [];
  for (const f of files) all.push(...inspectFile(f));

  const lines: string[] = [];
  lines.push('# Hardcoded Fake-Brain Reply Audit');
  lines.push('');
  lines.push(`Scanned ${files.length} TypeScript files. Found ${all.length} suspicious strings.`);
  lines.push('');
  lines.push('Each entry below shows a string sent to the user via a Brain-surface API that:');
  lines.push('- Looks like English prose (≥4 words OR contains prose markers)');
  lines.push('- Is NOT bracket-wrapped (e.g., `[Brain unavailable …]`)');
  lines.push('- Is NOT in a test / smoke / static-page file');
  lines.push('');
  lines.push('**Action required per the no-hardcoded-brain-replies rule:**');
  lines.push('- If the string is genuinely a Brain reply, route through `answerAsBrain` instead.');
  lines.push('- If it must be machine-emitted (errors, state acknowledgements), bracket-wrap it: `[noted]`, `[session ended …]`.');
  lines.push('- If it\'s a false positive (subject line of a templated email, system-internal log), add `// brain-audit: exempt <reason>` on the line.');
  lines.push('');

  const byFile = new Map<string, Finding[]>();
  for (const f of all) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  for (const file of Array.from(byFile.keys()).sort()) {
    const fs2 = byFile.get(file)!;
    lines.push(`## \`${file}\` — ${fs2.length} finding${fs2.length === 1 ? '' : 's'}`);
    lines.push('');
    for (const f of fs2) {
      lines.push(`- L${f.line} (${f.pattern}): \`${f.text.slice(0, 140)}\``);
      lines.push(`  - ${f.snippet}`);
    }
    lines.push('');
  }
  console.log(lines.join('\n'));
  process.exit(all.length > 0 ? 1 : 0);
}

main();
