/**
 * DEF-039 — the DEF-035 early-confirm guard dispatched WITHOUT the guards.
 *
 * Found by an external code audit on 2026-08-05, hours after DEF-035 shipped to
 * production. The new guard called `dispatchPendingDirect` raw, so it bypassed
 * both protections the legacy confirm branch had carried for months:
 *
 *   1. IDEMPOTENCY — a double-tapped "send", or a retried WhatsApp webhook,
 *      dispatched the same external action twice. Real duplicate emails and
 *      WhatsApp messages to real counterparts. DEF-035 is what made this
 *      reachable at all: before it, "send" never dispatched, so nothing could
 *      be duplicated. The fix for one defect created a worse one.
 *
 *   2. THE ARTIFACT LEDGER — previewed → confirmed → dispatching → succeeded.
 *      Skipping it leaves an early-confirmed dispatch reading `previewed`
 *      forever. Brain answers "did you do it?" from that ledger, so it would
 *      report nothing happened right after acting — DEF-034's exact family.
 *
 * THE LESSON THESE TESTS ENCODE: both guards lived INSIDE the branch they
 * protected. Bypassing the branch bypassed them silently, and no test noticed
 * because every existing test exercised the branch that still had them.
 * Protection that lives inside one caller is not protection.
 *
 * Containment is therefore structural, the same shape used for the `@lid` class
 * (`waIdentity.ts` as sole owner): `dispatchPendingDirect` has exactly ONE
 * external caller — `dispatchConfirmedPending` — and this file goes red if a
 * second one appears.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');

// Strip comments BEFORE asserting. Explanatory prose has matched its own
// assertion four separate times in this repo — including prose in this very
// file, which names `dispatchPendingDirect` repeatedly.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Body of a top-level `async function <name>(` up to the next top-level `}`. */
function bodyOf(name: string): string {
  const start = CODE.indexOf(`async function ${name}(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  const end = CODE.indexOf('\n}', start);
  return CODE.slice(start, end === -1 ? CODE.length : end);
}

describe('DEF-039 — one chokepoint for confirmed dispatch', () => {
  it('dispatchPendingDirect is invoked from exactly two places: the chokepoint and its own plan-step recursion', () => {
    // Invocations only — exclude the declaration itself.
    const calls = [...CODE.matchAll(/dispatchPendingDirect\(/g)]
      .filter((m) => !CODE.slice(Math.max(0, m.index! - 40), m.index!).includes('export async function'));

    expect(
      calls.length,
      'A new caller of dispatchPendingDirect appeared. Route it through '
      + 'dispatchConfirmedPending instead — calling it raw is exactly how DEF-039 '
      + 'shipped duplicate sends to real people.',
    ).toBe(2);
  });

  it('the chokepoint wraps the dispatch in the idempotency helper', () => {
    const body = bodyOf('dispatchConfirmedPending');
    expect(body).toContain('wrapDispatchIdem');
    expect(body).toContain('dispatchPendingDirect(');
    // The pending id is the idempotency key: unique per (user, channel, preview),
    // so a second "send" on the same preview replays instead of re-dispatching.
    expect(body).toContain('pending.id');
  });

  it('the chokepoint drives the artifact ledger through every transition', () => {
    const body = bodyOf('dispatchConfirmedPending');
    for (const status of ['confirmed', 'dispatching', 'succeeded', 'failed']) {
      expect(body, `artifact status '${status}' must be written`).toContain(`'${status}'`);
    }
    expect(body).toContain('updateArtifactStatus');
  });

  it('a throwing dispatch still records failure on both the pending row and the artifact', () => {
    const body = bodyOf('dispatchConfirmedPending');
    expect(body).toContain('dispatch_threw');
    expect(body).toMatch(/catch[\s\S]*markFailed/);
    // Rethrown, so the caller still renders its own error answer.
    expect(body).toMatch(/throw e/);
  });

  it('BOTH confirm paths go through the chokepoint — the early guard and the reducer', () => {
    const earlyGuard = CODE.slice(
      CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    const reducer = CODE.slice(
      CODE.indexOf("turnRelation.type === 'confirm_preview'"),
      CODE.indexOf("turnRelation.type === 'confirm_preview'") + 2000);

    expect(earlyGuard).toContain('dispatchConfirmedPending(');
    expect(reducer).toContain('dispatchConfirmedPending(');
    // Neither may reach past the chokepoint to the raw dispatcher.
    expect(earlyGuard).not.toContain('dispatchPendingDirect(');
    expect(reducer).not.toContain('dispatchPendingDirect(');
  });

  it('artifact tracking never blocks a dispatch the user already approved', () => {
    const body = bodyOf('dispatchConfirmedPending');
    // Every artifact write is inside a try/catch — a tracking failure must not
    // cost the user their action.
    const artifactWrites = (body.match(/updateArtifactStatus/g) ?? []).length;
    const catches = (body.match(/catch/g) ?? []).length;
    expect(artifactWrites).toBeGreaterThanOrEqual(3);
    expect(catches).toBeGreaterThanOrEqual(3);
  });
});
