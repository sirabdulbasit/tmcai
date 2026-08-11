/**
 * DEF-117 — Brain's own proactive messages never entered the conversation
 * history it reads on the next turn.
 *
 * Production, 2026-08-11:
 *
 *   05:18:16  brain → owner (brain_prompt): "Hi, this is a reminder from Nexeo.
 *             The 'Vision Metric's service sales package video' is now overdue."
 *   05:52     owner → brain: "did u ask this from Hamna?"
 *   05:52     brain → owner: "Sir, to clarify, what did you want me to ask
 *             Hamna about? We were just discussing the 'Stock Report' task for
 *             Ali Haider, and I haven't sent anything about that yet."
 *
 * Scored 71/100, weak on C3 (Continuity), C5 (Proportionate action) and C6
 * (Completeness). The judge read it as Brain ignoring the question and changing
 * the subject. It was neither: "this" referred to a message Brain could not see.
 *
 * The WhatsApp turn history lives in `whatsapp_sessions.conversation_history`,
 * and only `WhatsAppInbound` ever appended to it — one `{role:'user'}` and one
 * `{role:'assistant'}` per INBOUND turn. Every message Brain sends on its own
 * initiative — prompt-queue reminders, standing-due nudges, follow-ups,
 * diagnostics — went to `brain_user_messages` and out to the phone, and left no
 * trace in the thread. So the owner replies to something that, from Brain's
 * side of the glass, was never said. Brain then resolves the pronoun against
 * the last thing it CAN see, which is whatever the previous human turn was —
 * here, yesterday's Stock Report at 18:42.
 *
 * This is not the same shape as the guard defects: nothing overwrote a correct
 * answer. The input was genuinely incomplete, and the answer was as good as the
 * input allowed.
 *
 * Two rules hold this honest:
 *
 *   1. Only a message the owner actually received is appended. A `failed` or
 *      `suppressed` send must never enter history — that would leave Brain
 *      believing it said something it never said, which is the fabrication the
 *      dispatch ledger (DEF-108) exists to prevent, in a different table.
 *   2. The text stored is the body as delivered, verbatim. Brain's view of the
 *      thread must match the owner's view of the thread.
 *
 * Known limit, stated rather than hidden: `WhatsAppInbound` loads the history,
 * composes for several seconds, then writes the whole array back. A proactive
 * send landing inside that window is overwritten. Closing it means moving the
 * inbound path to an append-only write; that is a larger change and this one is
 * correct without it.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('session-history');

/** Matches the inbound path's trim (WhatsAppInbound: history.slice(-20)). */
const MAX_TURNS = 20;

/**
 * Append a message Brain sent on its own initiative to the live WhatsApp
 * session, so the next inbound turn can see it.
 *
 * Written as a single atomic statement: it never reads the array into JS, so it
 * cannot lose a concurrent append of its own. If no session is open (none
 * within the 24-hour window), nothing is written — the next inbound message
 * opens a fresh session anyway, and back-dating a dead thread would only give
 * Brain context the owner has moved on from.
 *
 * @returns true if a live session was updated.
 */
export async function appendBrainTurnToSession(
  clientNumber: string,
  userId: number,
  text: string,
): Promise<boolean> {
  const body = String(text ?? '').trim();
  if (!body) return false;

  const entry = JSON.stringify([{ role: 'assistant', content: body }]);

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_sessions
        SET conversation_history = COALESCE((
              SELECT jsonb_agg(e ORDER BY ord)
                FROM jsonb_array_elements(
                       COALESCE(conversation_history, '[]'::jsonb) || $3::jsonb
                     ) WITH ORDINALITY AS t(e, ord)
               WHERE ord > GREATEST(
                       jsonb_array_length(
                         COALESCE(conversation_history, '[]'::jsonb) || $3::jsonb
                       ) - ${MAX_TURNS}, 0)
            ), '[]'::jsonb),
            last_message_at = NOW()
      WHERE id = (
        SELECT id FROM whatsapp_sessions
         WHERE user_id = $1 AND client_number = $2 AND closed_at IS NULL
           AND last_message_at > NOW() - INTERVAL '24 hours'
         ORDER BY created_at DESC LIMIT 1
      )`,
    userId, clientNumber, entry,
  );

  if (!updated) {
    log.info('no live session — proactive message not added to thread history', {
      userId, clientNumber,
    });
  }
  return updated > 0;
}
