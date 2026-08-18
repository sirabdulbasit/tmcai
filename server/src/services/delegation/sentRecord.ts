/**
 * DEF-225 — what Brain actually sent, recorded from the message rather than
 * asserted about it.
 *
 * THE OBSTACLE, IN THE SCORER'S OWN WORDS. `state/capability_scorecard.json`
 * gives the reason Accurate Communication sits at 87 and has not moved through
 * six iterations of composer work:
 *
 *   > "Pack: 0 provider receipts; **worker send bodies not stored** —
 *   >  wording/delivery quality unconfirmed on chase path."
 *
 * The same sentence appears against Self Follow-Up (*"provider receipts 0,
 * bodies not stored… Capability fires; quality unmeasured"*) and Authorized
 * Action. Nothing composed can raise a score for prose nobody kept.
 *
 * And it is the OWNER'S class, not a scoring artefact. `fabricated-status` (6
 * occurrences) is his *"i am unable to see ur email in my sent items"* and
 * *"no email is being sent"*, and the falsifier the analysis sets for it is
 * literally *"Provider receipts, Sent-folder evidence or confirmed database
 * transitions prove the disputed outcomes occurred exactly as claimed."* **The
 * evidence that class needs in order to be settled is evidence this system does
 * not keep.**
 *
 * `delegationFollowUpJob` stores the subject, the recipient and the Gmail
 * `messageId` — and not one word of what it wrote in the owner's name.
 *
 * WORSE, AND THIS IS THE PART THAT IS A DEFECT RATHER THAN A GAP: the audit row
 * asserts `disclosureFooter: true` as a **hardcoded literal**. That is the class
 * pointing at itself — a record claiming a property of a message without
 * reading the message. If `composeChaseEmail` ever returns a body without the
 * footer, the audit says it had one, and the footer is the whole structural
 * mitigation for *"Brain never speaks as the user"*.
 *
 * So every field below is DERIVED from the body that was actually sent. Nothing
 * here is asserted.
 *
 * ON STORING THE BODY: it is the owner's own outbound mail, already in his Gmail
 * Sent folder, kept in his own tenant's `agent_actions.output` beside the
 * subject and recipient that are stored there today — the same class of data,
 * not a new exposure. It is bounded rather than unbounded: an excerpt plus the
 * true length plus a digest, so the full text stays verifiable without the audit
 * table growing without limit.
 */

import { createHash } from 'crypto';

/**
 * The invariant substring of the disclosure footer.
 *
 * Exported so the builder and the check share ONE definition. A check that
 * re-typed the sentence would drift from the footer the moment either changed,
 * and would then report a footer that is not there — which is the defect this
 * module exists to remove, reintroduced one layer down.
 */
export const DISCLOSURE_MARK = 'Sent by Nexeo,';

/** How much of the body the audit keeps verbatim. Chase emails are short; this
 *  is a bound against a pathological compose, not a redaction. */
export const SENT_BODY_EXCERPT_CHARS = 2000;

export interface SentRecord {
  /** The opening of the message as sent, bounded. */
  bodyExcerpt: string;
  /** True length, so a truncated excerpt can never read as the whole message. */
  bodyChars: number;
  /** Digest of the FULL body — proves the excerpt belongs to the real message. */
  bodySha256: string;
  /** Whether the disclosure footer was actually present. Read, never assumed. */
  disclosureFooter: boolean;
  /** True when the excerpt is shorter than the message it came from. */
  excerptTruncated: boolean;
}

/**
 * The record of one sent body. Total, and derived only from its argument.
 *
 * A missing or empty body is not an error here — the caller decides what to do
 * about that. What this must never do is describe an absent message as if it
 * were present, so an empty body yields `disclosureFooter: false` and a zero
 * length rather than a throw or a default of `true`.
 */
export function sentRecord(body: string | null | undefined): SentRecord {
  const text = typeof body === 'string' ? body : '';
  return {
    bodyExcerpt: text.slice(0, SENT_BODY_EXCERPT_CHARS),
    bodyChars: text.length,
    bodySha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    disclosureFooter: text.includes(DISCLOSURE_MARK),
    excerptTruncated: text.length > SENT_BODY_EXCERPT_CHARS,
  };
}
