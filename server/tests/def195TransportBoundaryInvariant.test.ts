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
 * Read a file as CODE. These files document the raw sends they replaced, and a
 * guard that reads prose about the code instead of the code reports its own
 * explanation as a violation — which is exactly what the first run of the
 * broadened scan did.
 */
const code = (f: string) => fs.readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Sites that send something OTHER than owner/counterpart prose, with the reason
 * recorded. Anything not listed here must be fitted at the call.
 */
const NON_PROSE_SENDS: Array<{ file: string; argStartsWith: string; why: string }> = [
  { file: 'services/whatsapp/WebjsProvider.ts', argStartsWith: 'buildProbeMarker', why: 'internal self-probe nonce, never read by a human' },
];

/**
 * DEF-196 (Codex iteration-2 MEDIUM) — the guard is RECEIVER-AGNOSTIC.
 *
 * My DEF-195 version matched the literal `client.sendMessage(a, b)` and the
 * Meta body shape. It therefore could not see `message.reply(text)` or
 * `chat.sendMessage(text)` in `inboundReplyTransport.ts` — a real wire path
 * that was passing a raw body to the library while this suite stayed green.
 * A guard that depends on the receiver variable being named `client` is a
 * guard that a rename defeats.
 *
 * So the scan now finds `.reply(` and `.sendMessage(` on ANY receiver,
 * distinguishes a text send from a structured provider call by whether the
 * first argument is an object literal, and requires the text argument to be
 * fitted or explicitly excused with a reason.
 */
function textSendOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of FILES) {
    const text = code(file);
    const re = /\.(reply|sendMessage)\(([^\n]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const method = m[1];
      const argsRaw = m[2].trim();
      // `provider.sendMessage({ … })` / `sendMessage({` — a structured payload,
      // fitted inside the provider, not a raw text send.
      if (argsRaw.startsWith('{')) continue;
      // Interface/type declarations and re-exports carry no argument.
      if (argsRaw.startsWith(')') || argsRaw === '') continue;

      const args = argsRaw.replace(/\);?\s*$/, '');
      const parts = args.split(',');
      // A MessageMedia payload is not prose, in either the
      // `client.sendMessage(chatId, media, opts)` or the
      // `chat.sendMessage(media, opts)` shape. Recognised by ARGUMENT rather
      // than by position, because the positional guess read the options object
      // of the second form as the message text.
      if (parts.some((a) => a.trim() === 'media')) continue;
      // Two-arg form is (target, text); one-arg form is (text).
      const textArg = (parts.length >= 2 ? parts[1] : parts[0]).trim();
      if (!textArg) continue;
      if (textArg.includes('fitToTransport') || /wireBody|wireMessage/.test(textArg)) continue;
      const excused = NON_PROSE_SENDS.some(
        (x) => rel(file) === x.file && textArg.startsWith(x.argStartsWith),
      );
      if (!excused) offenders.push(`${rel(file)} → .${method}(…, ${textArg})`);
    }
  }
  return offenders;
}

describe('DEF-195/196 — every WhatsApp text send in the tree is fitted at the boundary', () => {
  it('finds the send primitives by scanning src/, not by naming files', () => {
    const hits = FILES.filter((f) => /\.(?:reply|sendMessage)\(/.test(code(f)));
    expect(hits.length, 'the scan located no send sites at all').toBeGreaterThan(0);
  });

  it('no text send on ANY receiver passes an unfitted body', () => {
    expect(textSendOffenders(), 'unfitted WhatsApp text send').toEqual([]);
  });

  it('the guard would CATCH a raw send — proven against a fixture, not asserted', () => {
    // The guard's own falsifier: the same predicate applied to a raw
    // `message.reply(text)` must report it. Without this, a regex that matches
    // nothing would pass every assertion above.
    const raw = 'const sent = await message.reply(text);';
    const re = /\.(reply|sendMessage)\(([^\n]*)/g;
    const m = re.exec(raw)!;
    const textArg = m[2].replace(/\);?\s*$/, '').split(',')[0].trim();
    expect(textArg).toBe('text');
    expect(textArg.includes('fitToTransport')).toBe(false);
  });

  it('no Meta text body is assembled from unfitted text', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = code(file);
      const re = /text:\s*\{\s*body:\s*([^}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const arg = m[1].trim();
        if (arg.includes('fitToTransport') || /wireBody|wireMessage/.test(arg)) continue;
        offenders.push(`${rel(file)} → text: { body: ${arg} }`);
      }
    }
    expect(offenders, 'unfitted Meta text body').toEqual([]);
  });

  it('no send argument is itself a character slice', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = code(file);
      const re = /\.(?:reply|sendMessage)\(([^\n]*)|text:\s*\{\s*body:\s*([^}]+)\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const arg = (m[1] ?? m[2] ?? '').trim();
        if (/\.(?:slice|substring)\(\s*0\s*,\s*(?:3900|4000|4096)/.test(arg)) {
          offenders.push(`${rel(file)} → ${arg}`);
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
