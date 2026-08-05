/**
 * DEF-055 — "yes" dispatched a stale preview to a third party.
 *
 * 2026-08-05 18:00. Brain asked: "I can record a note on her contact profile
 * with your instruction. Would you like me to do that?" The owner said "yes".
 * A WhatsApp went to Hamna Latif Bhutta — a different person, from a
 * preview_shown pending left over from the 17:17 flow — and the note he
 * actually asked for was never written.
 *
 * MY DEF-035 guard caused it. It asked two questions:
 *    is this a bare confirmation?      yes
 *    does a stored preview exist?      yes
 * and never the one that matters: IS THAT PREVIEW WHAT BRAIN JUST ASKED ABOUT?
 *
 * A human assistant who asks "shall I add a note?" and hears "yes" does not
 * send yesterday's email. The confirmation belongs to the last question asked.
 *
 * This is the fourth defect in the confirm family (DEF-024 constraint, DEF-032
 * displacement, DEF-035 ordering, this) and the second I introduced while
 * fixing the previous one. The class does not close by patching the reported
 * instance — DEF-038 removes the confirmation step for instructed actions
 * entirely, and that is the real fix.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const GUARD = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));

describe('DEF-055 — a confirmation answers the last question, not any stored one', () => {
  it('the guard inspects what Brain last said', () => {
    expect(GUARD).toContain('lastBrainTurn');
    expect(GUARD).toMatch(/history[\s\S]{0,80}role === 'brain'/);
  });

  it('it requires the last Brain turn to have BEEN the preview', () => {
    expect(GUARD).toContain('lastBrainWasThePreview');
    expect(
      GUARD,
      'without this condition any bare "yes" dispatches any stored preview — '
      + 'which sent a WhatsApp to a third party on 2026-08-05 18:00',
    ).toMatch(/isBareConfirm\s*&&\s*\(lastBrainWasThePreview/);
  });

  it('a skipped early-confirm is logged, not silent', () => {
    expect(GUARD).toMatch(/early-confirm SKIPPED/);
  });

  it('still fires when the preview IS the last thing Brain said', () => {
    // The DEF-035 fix must survive: "send" right after a preview still
    // dispatches without re-reasoning.
    expect(GUARD).toContain('dispatchConfirmedPending(');
    expect(GUARD).toContain("outstanding.status === 'preview_shown'");
  });

  it('recognises the preview wordings the renderers actually produce', () => {
    const re = GUARD.match(/lastBrainWasThePreview = (\/[\s\S]*?\/i)/)![1];
    const rx = new RegExp(re.slice(1, -2), 'i');
    // Verbatim openings from renderPlanPreview / the whatsapp preview renderer.
    expect(rx.test('Before I send the WhatsApp, please confirm — message to Hamna')).toBe(true);
    expect(rx.test('Before I proceed, please confirm — I\'m about to do ALL of these:')).toBe(true);
    expect(rx.test('... Reply "send" to confirm, or tell me what to change.')).toBe(true);
    // The question that was hijacked must NOT read as a preview.
    expect(rx.test('I can, however, record a note on her contact profile with your instruction. Would you like me to do that?')).toBe(false);
  });
});
