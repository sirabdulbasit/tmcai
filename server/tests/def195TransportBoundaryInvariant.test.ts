/**
 * DEF-195 — the transport budget is enforced at the PROVIDER BOUNDARY, and the
 * guard is an invariant over the tree rather than a list of files I remembered.
 *
 * Codex's iteration-2 review, and both findings were fair:
 *
 *   HIGH #1 — my "ALL FOUR truncators" claim inventoried four filenames. He
 *   found four more live wire paths that never heard of the policy:
 *   `WhatsAppManager` → `WebjsProvider.sendMessage` / `MetaProvider.sendMessage`,
 *   and the owner's own session via `UserWebjsProvider.sendReply` (which the
 *   approved Day Brief draft uses). A list of known implementations is not
 *   enforcement — a fifth path passes it silently.
 *
 *   HIGH #2 — `parseBlocks` stopped at the first blank line after the first
 *   list, so a Day Brief's Calendar / Email / Open Items sections were not all
 *   protected: later lists were opaque tail, and fitting either deleted
 *   Calendar items merely for coming first or fell back to character trimming.
 *
 * So this file asserts two things that cannot be satisfied by a filename:
 *   1. every raw WhatsApp text send in the WHOLE tree is fitted at the site;
 *   2. multi-section bodies keep their block guarantee.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fitToTransport, WA_TRANSPORT_MAX_CHARS } from '../src/services/knowledge/transportBudget';

const SRC = path.join(__dirname, '..', 'src');
const MAX = WA_TRANSPORT_MAX_CHARS;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const FILES = walk(SRC);
const rel = (p: string) => path.relative(SRC, p);

/**
 * Sites that send something OTHER than owner/counterpart prose, with the reason
 * recorded. Anything not listed here must be fitted at the call.
 */
const NON_PROSE_SENDS: Array<{ file: string; argStartsWith: string; why: string }> = [
  { file: 'services/whatsapp/WebjsProvider.ts', argStartsWith: 'buildProbeMarker', why: 'internal self-probe nonce, never read by a human' },
  { file: 'services/whatsapp/WebjsProvider.ts', argStartsWith: 'media', why: 'media payload, not text' },
];

describe('DEF-195 — every WhatsApp text send in the tree is fitted at the boundary', () => {
  it('finds the send primitive by scanning src/, not by naming files', () => {
    // If this ever finds zero, the scan has broken and every assertion below
    // would pass vacuously.
    const hits = FILES.filter((f) => /\.sendMessage\(/.test(fs.readFileSync(f, 'utf8')));
    expect(hits.length, 'the scan located no send sites at all').toBeGreaterThan(0);
  });

  it('no raw client.sendMessage passes unfitted text', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, 'utf8');
      // `client.sendMessage(target, ARG` — capture the second argument.
      const re = /\bclient\.sendMessage\(\s*[^,]+,\s*([^,)]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const arg = m[1].trim();
        if (arg.includes('fitToTransport')) continue;
        const excused = NON_PROSE_SENDS.some((x) => rel(file) === x.file && arg.startsWith(x.argStartsWith));
        if (!excused) offenders.push(`${rel(file)} → sendMessage(…, ${arg})`);
      }
    }
    expect(offenders, 'unfitted WhatsApp text send').toEqual([]);
  });

  it('no Meta text body is assembled from unfitted text', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /text:\s*\{\s*body:\s*([^}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const arg = m[1].trim();
        if (arg.includes('fitToTransport') || arg.includes('wireBody')) continue;
        offenders.push(`${rel(file)} → text: { body: ${arg} }`);
      }
    }
    expect(offenders, 'unfitted Meta text body').toEqual([]);
  });

  it('no send argument is itself a character slice', () => {
    // Argument-level, because file-level was the wrong instrument: it flagged
    // `UserWebjsProvider` for truncating INBOUND `message.body` to 4000 before
    // storage, which is a different concern entirely. What matters is that the
    // text handed to the wire was not produced by cutting characters.
    const offenders: string[] = [];
    const SEND_ARG = [
      /\bclient\.sendMessage\(\s*[^,]+,\s*([^,)]+)/g,
      /text:\s*\{\s*body:\s*([^}]+)\}/g,
    ];
    for (const file of FILES) {
      const text = fs.readFileSync(file, 'utf8');
      for (const re of SEND_ARG) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const arg = m[1].trim();
          if (/\.(?:slice|substring)\(/.test(arg)) offenders.push(`${rel(file)} → ${arg}`);
        }
      }
    }
    expect(offenders, 'a wire send was fed a character slice').toEqual([]);
  });
});

describe('DEF-195 — multi-section bodies keep the block guarantee (Codex HIGH #2)', () => {
  /** The real Day Brief shape: several bulleted sections separated by blanks. */
  function dayBrief(perSection: number): string {
    const section = (title: string, n: number, tag: string) => [
      `*${title}:*`,
      ...Array.from({ length: n }, (_, i) => `• ${tag} ${i + 1} — ${'detail '.repeat(6).trim()}`),
    ].join('\n');
    return [
      'Good morning. Here is your brief for Monday.',
      '',
      section('Calendar', perSection, 'CAL'),
      '',
      section('Email', perSection, 'MAIL'),
      '',
      section('WhatsApp', perSection, 'WA'),
      '',
      section('Open Items', perSection, 'ITEM'),
      '',
      'Nothing else needs you today.',
    ].join('\n');
  }

  it('every section is parsed — later lists are droppable, not opaque tail', () => {
    const body = dayBrief(60);
    expect(body.length).toBeGreaterThan(MAX);

    const fit = fitToTransport(body);
    expect(fit.body.length).toBeLessThanOrEqual(MAX);
    expect(fit.truncated).toBe(true);
    // The FIRST section's items are not sacrificed merely for coming first.
    expect(fit.body, 'Calendar was deleted for being first').toContain('CAL 1');
    // Removal is positional: the last section is the one that gives way.
    expect(fit.body).not.toContain('ITEM 60');
  });

  it('no line is ever severed, in any section', () => {
    const body = dayBrief(60);
    const original = new Set(body.split('\n'));
    for (const l of fitToTransport(body).body.split('\n')) {
      if (l.trim() === '…' || l.trim() === '') continue;
      expect(original.has(l), `severed line: ${JSON.stringify(l)}`).toBe(true);
    }
  });

  it('a heading is not left announcing a section with nothing in it', () => {
    const fit = fitToTransport(dayBrief(60));
    const lines = fit.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^\*[A-Za-z ]+:\*$/.test(lines[i].trim())) continue;
      const rest = lines.slice(i + 1);
      const nextHeadingAt = rest.findIndex((l) => /^\*[A-Za-z ]+:\*$/.test(l.trim()));
      const window = nextHeadingAt < 0 ? rest : rest.slice(0, nextHeadingAt);
      expect(window.some((l) => /^\s*•/.test(l)), `empty section under ${lines[i]}`).toBe(true);
    }
  });

  it('the closing prose still arrives — prose is never what gets dropped', () => {
    const fit = fitToTransport(dayBrief(60));
    expect(fit.body).toContain('Good morning. Here is your brief for Monday.');
    expect(fit.body).toContain('Nothing else needs you today.');
  });

  it('the omitted count is arithmetically true across all sections', () => {
    const body = dayBrief(60);
    const fit = fitToTransport(body);
    const totalItems = body.split('\n').filter((l) => /^\s*•/.test(l)).length;
    const kept = fit.body.split('\n').filter((l) => /^\s*•/.test(l)).length;
    expect(kept + fit.omittedItems).toBe(totalItems);
  });

  it('still adds no words — the mark is a glyph', () => {
    const fit = fitToTransport(dayBrief(60));
    const original = new Set(dayBrief(60).split('\n'));
    for (const l of fit.body.split('\n')) {
      if (original.has(l) || l.trim() === '') continue;
      expect(l.trim(), `this layer invented text: ${JSON.stringify(l)}`).toBe('…');
    }
    expect(fit.body).not.toMatch(/\bmore\b|not shown|omitted|truncated/i);
  });

  it('a body under the budget is returned byte-identical', () => {
    const body = dayBrief(2);
    expect(body.length).toBeLessThan(MAX);
    const fit = fitToTransport(body);
    expect(fit.body).toBe(body);
    expect(fit.truncated).toBe(false);
    expect(fit.omittedItems).toBe(0);
  });
});
