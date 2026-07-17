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
  return `WhatsApp accepted the message to ${recipientName} (${recipientPhone}) from the Nexeo number, but did not return a receipt ID. I won't retry automatically because that could send a duplicate.`;
}
