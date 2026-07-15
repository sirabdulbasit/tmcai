/**
 * outboundIdentity — how the brain presents itself and signs when it
 * communicates with OTHER people (2026-07-14).
 *
 * Basit's two rules:
 *   1. "If brain is using my email to send communication then use my
 *      signature as I do (can read from sent items)."
 *      → getUserEmailSignature: the user's REAL sign-off block,
 *        learned from their recent Sent items (LLM-extracted once,
 *        cached 24h). Explicit preference override wins; fallback is
 *        a plain "Thanks,\n<first name>". The Nexeo disclosure footer
 *        stays appended AFTER the signature — content in the user's
 *        voice, identity always disclosed.
 *   2. "If brain sending whatsapp message using its own number then it
 *      should introduce with Suzi if name is given otherwise Nexeo."
 *      → getBrainDisplayName: the user's custom brain name
 *        (notificationPreferences.brainName, same field Settings and
 *        set_brain_name write) — 'Nexeo' when unset.
 */
import prisma from '../../db/prisma';
import { getOrCompute } from '../../utils/redisClient';
import createLogger from '../../utils/logger';

const log = createLogger('outbound-identity');

/** WhatsApp-intro name: custom brain name if the user set one, else
 *  Nexeo. 60s cache — same staleness as the persona cache, so a
 *  rename reaches outbound intros within a minute. */
export async function getBrainDisplayName(userId: number): Promise<string> {
  return getOrCompute(`brainname:${userId}`, 60, async () => {
    try {
      const u = await prisma.user.findFirst({
        where: { id: userId },
        select: { notificationPreferences: true } as any,
      });
      const raw = String(((u as any)?.notificationPreferences?.brainName ?? '')).trim();
      if (raw && raw.toLowerCase() !== 'brain') return raw;
    } catch { /* fall through */ }
    return 'Nexeo';
  });
}

const SIG_EXTRACT_SYSTEM = `You are given the closing lines of several emails the SAME person sent. Extract the exact sign-off block they consistently use — the closing phrase plus name/title/company lines exactly as they write them (e.g. "Thanks,\\nBasit Ahmed\\nSolution Architect | TallyMarks Consulting").

Rules:
- Return the VERBATIM recurring block, nothing else. No commentary, no quotes.
- Ignore automated footers (unsubscribe links, "Sent from my iPhone", legal disclaimers, "Sent by Nexeo…").
- If the sign-offs are inconsistent or you can't find a recurring block, return exactly: NONE`;

/** The user's real email signature. Resolution order:
 *    1. explicit preference (brain_channel.emailSignature) — a user-
 *       approved standing preference always wins;
 *    2. LLM-extracted from their recent Sent items (cached 24h);
 *    3. fallback "Thanks,\n<first name>" so emails never end abruptly.
 *  Never throws — email sending must not depend on signature niceties. */
export async function getUserEmailSignature(userId: number, _clientNumber: string): Promise<string> {
  return getOrCompute(`emailsig:${userId}`, 24 * 3600, async () => {
    let firstName = 'there';
    try {
      const u = await prisma.user.findFirst({
        where: { id: userId },
        select: { name: true, notificationPreferences: true } as any,
      });
      firstName = String((u as any)?.name ?? '').split(/\s+/)[0] || firstName;
      // 1. Explicit preference wins (set via Settings or an approved
      //    "always sign my emails with…" standing preference).
      const explicit = String(((u as any)?.notificationPreferences?.brain_channel?.emailSignature ?? '')).trim();
      if (explicit) return explicit;
    } catch { /* fall through to extraction */ }

    // 2. Learn from Sent items — how the user ACTUALLY signs.
    try {
      const { getSentSamples } = await import('../gmailService');
      const { samples } = await getSentSamples(userId, 6);
      const tails = (samples ?? [])
        .map((s) => String(s.body ?? '').trim().split('\n').slice(-6).join('\n'))
        .filter((t) => t.length > 0);
      if (tails.length >= 2) {
        const { callLLM } = await import('../llmRouter');
        const r = await callLLM(SIG_EXTRACT_SYSTEM, tails.map((t, i) => `--- email ${i + 1} closing ---\n${t}`).join('\n\n'), {
          maxTokens: 120, userId, purpose: 'email_signature_extract',
        });
        const sig = (r.text ?? '').trim();
        if (sig && sig !== 'NONE' && sig.length <= 300) {
          log.info('signature extracted from sent items', { userId, sigHead: sig.slice(0, 40) });
          return sig;
        }
      }
    } catch (e: any) {
      log.warn('signature extraction failed (fallback applies)', { userId, error: e?.message });
    }

    // 3. Never leave an email unsigned.
    return `Thanks,\n${firstName}`;
  });
}
