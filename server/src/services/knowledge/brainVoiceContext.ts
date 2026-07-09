// ═════════════════════════════════════════════════════════════════════════════
// brainVoiceContext — A0-email (2026-07-09): one context source for every
// composer that writes in the user's voice.
//
// The specialized email composers (forward cover-notes, deadline inquiries,
// delegation chases) ran their own LLM calls WITHOUT the brain's context —
// no standing instructions, no learned preferences, no governed memories.
// "Always cc finance on delegations" applied in Brain chat but not in the
// delegation email itself: the two-brains fork, email edition.
//
// This renders the SAME knowledge blocks brainComposer injects, compactly,
// for embedding into specialized compose prompts via withUserPrompts (the
// chokepoint all tone composers already call). Channel-tone separation is
// untouched — tone SAMPLES stay per-channel; this adds only what Brain
// KNOWS, not how it sounds.
// ═════════════════════════════════════════════════════════════════════════════

import createLogger from '../../utils/logger';

const log = createLogger('brain-voice-context');

const MAX_INSTRUCTIONS = 10;

export async function renderBrainVoiceContext(userId: number): Promise<string> {
  try {
    const { resolveClientNumberForUser } = await import('../tenantScope');
    const clientNumber = await resolveClientNumberForUser(userId);
    if (!clientNumber) return ''; // no tenant → no scoped knowledge; fail quiet, not wrong

    // Each block loads independently — one failing source must never blank
    // the others (a DB hiccup on instructions shouldn't drop preferences).
    const [instructionsBlock, prefsBlock, governedBlock] = await Promise.all([
      (async () => {
        const { getActiveInstructions, renderInstructionsBlock } = await import('./instructionService');
        const rows = await getActiveInstructions(clientNumber, userId, MAX_INSTRUCTIONS);
        return rows.length ? renderInstructionsBlock(rows) : '';
      })().catch(() => ''),
      (async () => {
        const { getLearnedPreferences, renderPreferencesBlock } = await import('./preferenceLearnerService');
        const prefs = await getLearnedPreferences(clientNumber, userId);
        return prefs ? renderPreferencesBlock(prefs) : '';
      })().catch(() => ''),
      (async () => {
        const { renderGovernedMemoriesBlock } = await import('../learning/governedMemoriesBlock');
        return renderGovernedMemoriesBlock(clientNumber, userId);
      })().catch(() => ''),
    ]);

    const parts = [instructionsBlock, prefsBlock, governedBlock].filter(Boolean);
    if (parts.length === 0) return '';
    return [
      '# What Brain knows about this user (apply where relevant to what you write)',
      ...parts,
    ].join('\n\n');
  } catch (err: any) {
    log.warn('brain voice context failed — composing without it', { userId, err: err?.message });
    return '';
  }
}
