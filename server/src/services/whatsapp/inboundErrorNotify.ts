// ═════════════════════════════════════════════════════════════════════════════
// inboundErrorNotify — user-visible failure signal for the WA inbound path.
//
// A7 (2026-07-08): a caught exception used to clear the ⏳ reaction with no
// reply — the user saw read+cleared and read it as Brain disobeying them.
// On error we send a bracketed SYSTEM marker (honest machine status, never
// prose pretending to be Brain) before clearing the reaction.
//
// Registered senders only: handleInboundMessage sets _resolvedUserId after
// identity resolution. If it's absent the sender may be unregistered, and
// unregistered traffic is dropped silently by policy (no reply confirms
// this is an automated business number).
// ═════════════════════════════════════════════════════════════════════════════

import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:error-notify');

export const INBOUND_ERROR_REPLY = `[couldn't process that — please retry]`;

export async function maybeNotifyInboundError(
  message: any,
  resolvedUserId: number | undefined,
): Promise<boolean> {
  if (!resolvedUserId) return false; // unregistered → stay silent by policy
  try {
    const { sendInboundTextReply } = await import('./inboundReplyTransport');
    await sendInboundTextReply(message, INBOUND_ERROR_REPLY);
    return true;
  } catch (err: any) {
    log.warn('error notify failed', { err: err?.message });
    return false;
  }
}
