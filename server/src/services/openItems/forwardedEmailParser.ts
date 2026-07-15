/**
 * MyOS — Forwarded Email Parser.
 *
 * Detect whether an inbound email is a forward, and if so, extract:
 *   - the FORWARDER'S note (text above the forwarded block — usually the real
 *     ask: "FYI", "please handle this", "what do you think?")
 *   - the ORIGINAL sender (from the inner "From:" line)
 *   - the ORIGINAL subject (from inner "Subject:")
 *   - the inner body
 *
 * Why this matters for open items: when someone forwards an email TO the
 * user, the actionable signal is in the forwarder's note, not the original
 * subject. If the user's COO forwards a vendor email saying "please review",
 * the open item should be:
 *
 *   title:        "Review: <original subject>"
 *   delegatee:    none (user is the assignee — the forwarder asked them)
 *   description:  forwarder's note + original sender + original subject
 *
 * Without this parsing, today the open item just gets the raw forwarded
 * subject (often "Fwd: [Vendor] Q3 invoice") and the original sender as
 * "from" — losing the "please review" signal entirely.
 *
 * Heuristics are intentionally conservative: we only flag as forwarded when
 * BOTH the subject prefix AND a forwarded-block delimiter are present.
 * False positives here would mis-attribute the sender of a normal email.
 */

const SUBJECT_FWD_PREFIXES = [
  /^fwd?:\s*/i,
  /^fw:\s*/i,
  /^\[fwd?\]\s*/i,
];

// Common forwarded-block delimiters across mail clients.
const FORWARD_DELIMITERS = [
  /\n[-—]+\s*Forwarded message\s*[-—]+\n/i,            // Gmail
  /\nBegin forwarded message:\s*\n/i,                  // Apple Mail
  /\n[-—]+\s*Original Message\s*[-—]+\n/i,             // Outlook
  /\nFrom:\s+.+?\nSent:\s+.+?\nTo:\s+/i,               // Outlook fallback
  /\nFrom:\s+.+?\nDate:\s+.+?\nTo:\s+/i,               // Apple/Gmail fallback
];

const FROM_LINE_RE = /^\s*From:\s*(?:"?(?<name>[^"<\n]+?)"?\s*)?<?(?<email>[^\s>]+@[^\s>]+)>?/im;
const SUBJECT_LINE_RE = /^\s*Subject:\s*(?<subject>.+)$/im;

export interface ParsedForwardedEmail {
  isForwarded: boolean;
  /** The note the forwarder wrote ABOVE the forwarded block. Often the real ask. */
  forwarderNote: string | null;
  /** Sender of the ORIGINAL email (pre-forward). */
  originalSenderEmail: string | null;
  originalSenderName: string | null;
  /** Subject of the original email, with any Fwd: prefix stripped. */
  originalSubject: string | null;
  /** Body of the inner / original message, after the delimiter. */
  innerBody: string | null;
}

export function parseForwardedEmail(subject: string | null, body: string | null): ParsedForwardedEmail {
  const result: ParsedForwardedEmail = {
    isForwarded: false,
    forwarderNote: null,
    originalSenderEmail: null,
    originalSenderName: null,
    originalSubject: null,
    innerBody: null,
  };

  const subj = (subject ?? '').trim();
  const bod = body ?? '';
  if (!bod || bod.length < 30) return result;

  const subjectIsForward = SUBJECT_FWD_PREFIXES.some((re) => re.test(subj));
  const delimMatch = findFirstMatch(bod, FORWARD_DELIMITERS);
  if (!delimMatch) return result;
  const delimIdx = delimMatch.index ?? -1;
  if (delimIdx < 0) return result;

  // Require BOTH signals when the subject doesn't match — body alone (e.g.
  // someone quoting an old thread) shouldn't be misclassified as a forward.
  // If the subject DOES match Fwd:, the body delimiter alone is enough to
  // confirm the forwarded block exists.
  if (!subjectIsForward && delimIdx < 5) return result;

  result.isForwarded = true;
  result.forwarderNote = bod.slice(0, delimIdx).trim() || null;
  const inner = bod.slice(delimIdx + delimMatch[0].length);

  const fromMatch = inner.match(FROM_LINE_RE);
  if (fromMatch?.groups) {
    result.originalSenderEmail = fromMatch.groups.email ?? null;
    result.originalSenderName = fromMatch.groups.name?.trim() || null;
  }
  const subjMatch = inner.match(SUBJECT_LINE_RE);
  if (subjMatch?.groups) {
    result.originalSubject = stripFwdPrefix(subjMatch.groups.subject.trim());
  } else if (subjectIsForward) {
    result.originalSubject = stripFwdPrefix(subj);
  }

  // innerBody = everything after the From/Date/Subject header block. Take a
  // simple approach: skip lines that look like header lines, then keep the rest.
  const innerLines = inner.split('\n');
  let bodyStart = 0;
  for (let i = 0; i < innerLines.length; i++) {
    if (/^(From|To|Cc|Sent|Date|Subject|Reply-To):/i.test(innerLines[i])) continue;
    if (innerLines[i].trim() === '' && bodyStart === 0) { bodyStart = i + 1; break; }
  }
  result.innerBody = innerLines.slice(bodyStart).join('\n').trim() || null;

  return result;
}

function findFirstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  let earliest: RegExpMatchArray | null = null;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && typeof m.index === 'number') {
      if (!earliest || m.index < (earliest.index ?? Infinity)) earliest = m;
    }
  }
  return earliest;
}

function stripFwdPrefix(s: string): string {
  let out = s;
  for (const re of SUBJECT_FWD_PREFIXES) {
    out = out.replace(re, '');
  }
  return out.trim();
}

/**
 * Convenience: produce the open-item title + description fragments to use
 * when an item is created from a forwarded email.
 *
 *   - Title leads with an action verb when the forwarder's note implies one
 *     (e.g. "please review" → "Review: <orig subject>")
 *   - Description carries the forwarder's note prominently so the user sees
 *     who asked them to do something and what they actually said.
 */
export function buildOpenItemFromForward(
  parsed: ParsedForwardedEmail,
  forwarderEmail: string | null,
  forwarderName: string | null,
  fallbackSubject: string,
): { title: string; description: string } {
  if (!parsed.isForwarded) {
    return { title: fallbackSubject, description: '' };
  }
  const verb = inferActionVerb(parsed.forwarderNote ?? '');
  const orig = parsed.originalSubject ?? fallbackSubject;
  const title = verb ? `${capitalise(verb)}: ${orig}` : `Forwarded: ${orig}`;
  const lines: string[] = [];
  if (forwarderName || forwarderEmail) {
    lines.push(`Forwarded to you by: ${forwarderName ?? forwarderEmail}${forwarderName && forwarderEmail ? ` <${forwarderEmail}>` : ''}`);
  }
  if (parsed.forwarderNote) {
    lines.push(`Their note: "${parsed.forwarderNote.slice(0, 400)}"`);
  }
  if (parsed.originalSenderEmail || parsed.originalSenderName) {
    lines.push(`Original from: ${parsed.originalSenderName ?? ''}${parsed.originalSenderEmail ? ` <${parsed.originalSenderEmail}>` : ''}`.trim());
  }
  if (parsed.originalSubject) {
    lines.push(`Original subject: ${parsed.originalSubject}`);
  }
  return { title, description: lines.join('\n') };
}

function inferActionVerb(note: string): string | null {
  const n = note.toLowerCase();
  if (/please\s+(review|check)/.test(n) || /can you\s+(review|check)/.test(n)) return 'review';
  if (/please\s+(approve|sign)/.test(n)) return 'approve';
  if (/please\s+(reply|respond)/.test(n) || /need.*your.*reply/.test(n)) return 'reply';
  if (/please\s+(handle|action|address)/.test(n) || /your\s+action/.test(n)) return 'handle';
  if (/please\s+decide/.test(n) || /need.*your.*decision/.test(n)) return 'decide';
  if (/your thoughts|what do you think|fyi/.test(n)) return null; // pure FYI — let gate decide
  return null;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
