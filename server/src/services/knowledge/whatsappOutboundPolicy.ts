/** Remove model-authored greeting/disclosure that the dispatcher owns. */
export function normalizeWhatsAppSubstantiveMessage(
  message: string,
  recipientName: string,
): string {
  let out = String(message ?? '').trim();
  if (!out) return out;

  // Strip a complete model-authored assistant introduction. The dispatcher
  // adds the canonical identity disclosure exactly once.
  out = out.replace(
    /^(?:hi|hello|dear)\s+[^,!.:\n]+[,!.:]?\s+(?:this is|i(?:'m| am))\s+[^.\n]{0,120}(?:ai assistant|assistant)[^.\n]*(?:\.|:)?\s*/i,
    '',
  ).trim();

  // Strip a duplicate recipient greeting ("Hi Yousaf.") because the
  // dispatcher prefix already starts with "Hi Yousaf, ...".
  const names = new Set<string>();
  const full = recipientName.trim();
  if (full) {
    const parts = full.split(/\s+/);
    names.add(full);
    names.add(parts[0]);
    names.add(parts[parts.length - 1]);
  }
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^(?:hi|hello|dear)\\s+${escaped}\\s*[,!.:—-]+\\s*`, 'i'), '').trim();
  }

  return out;
}

export function whatsappAcceptedMessage(recipientName: string, recipientPhone: string): string {
  // Owner, 2026-08-05: "why it sent 'Whatsapp accepted the message to
  // Hamna…' where it should read the tick […] when received then just update
  // me that 'Message sent to Hamna'".
  //
  // The old wording leaked three pieces of plumbing into a human
  // conversation — "accepted", "did not return a receipt ID", "I won't retry
  // automatically" — and framed a successful send as a partial failure. It
  // existed because nothing read the delivery acknowledgements, so the send
  // path genuinely did not know what had happened.
  //
  // It does now (DEF-052): `message_ack` is recorded against the message, so
  // the tick is the source of truth for delivery and this line only has to
  // report that the message went. Anything more precise ("delivered", "read")
  // is answered from the ledger when asked, not guessed at send time.
  const first = (recipientName ?? '').trim().split(/\s+/)[0] || 'them';
  return `Message sent to ${first}.`;
}
