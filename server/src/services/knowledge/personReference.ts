/**
 * DEF-221 — how to refer to a person, supplied as DATA.
 *
 * `B11-capability-limit` asked *"Can you place a WhatsApp call to Latif for me?"*
 * and Brain answered:
 *
 *     "I can send a WhatsApp message to ask HER to call you, or I can give you
 *      HER number if you'd like."
 *
 * The judge, twice: *"It does use 'her' when the name was 'Latif' … making the
 * gender assumption an unnecessary detail"* (C5 90) and *"The gender assumption
 * for 'Latif' is a minor inaccuracy"* (C6 90). Latif is a man's name. **Nothing
 * in this system records anyone's gender** — `Person` has `displayName` and
 * `canonicalName`, `PersonFacet` carries emails and phone numbers, `Entity` a
 * name, email and phone. There is no field, so the model supplied one.
 *
 * That is the DEF-214 shape exactly, and the reason this is a mechanism rather
 * than a wording preference: *"No HOUR was supplied at all, so 'what time is it'
 * could only be answered by inventing one — and then labelling it with his
 * timezone."* Here, no reference form is supplied at all, so writing "ask ___ to
 * call you" can only be done by inventing one. **The fix is to supply the thing
 * the model would otherwise invent**, which is what DEF-214 and DEF-220 both
 * did, rather than to add a rule and hope.
 *
 * The same missing datum produced a second complaint in the same run —
 * `B07-compound-ask` C4 85: *"'Hamna Latif Bhutta' feels a little formal or
 * robotic for a casual query about 'Hamna'."* The block gave the full stored
 * name and no indication of what he actually calls the person, so the model used
 * the only string it had. One datum, two defects.
 *
 * WHAT THIS DOES NOT DO: it does not guess a short name. `asAskedFor` is used
 * ONLY when it really is part of the stored name — the owner's own word for the
 * person, not a nickname this module invented. "Muhammad Yousaf" does not become
 * "Yousaf" because I think that is what he is called; it becomes "Yousaf" only
 * if the owner typed "Yousaf".
 */

/**
 * The attributes a person record does NOT carry.
 *
 * Kept as a list, and deliberately short: each entry has to be a field the
 * schema genuinely lacks AND one the model has been observed to fill in.
 * Gender is the whole list today, and adding to it should require the same
 * evidence — an observed invention, not a suspicion.
 */
export const UNRECORDED_PERSON_ATTRIBUTES = ['gender'] as const;

/**
 * The name to use for this person in prose.
 *
 * `asAskedFor` wins only when it is a real word of the stored name, compared
 * case-insensitively. A query like "the ShireMe guy" resolves to a contact but
 * is not that contact's name, and echoing it back as the person's name would be
 * a different fabrication in the same family.
 */
export function personReferenceFor(args: {
  displayName: string;
  asAskedFor?: string | null;
}): string {
  const display = String(args.displayName ?? '').replace(/\s+/g, ' ').trim();
  const asked = String(args.asAskedFor ?? '').replace(/\s+/g, ' ').trim();
  if (!asked) return display;
  // One WORD of the stored name, matched case-insensitively and returned as
  // stored. A separate `if (/\s/.test(asked)) return display` guard was here and
  // mutation proved it EQUIVALENT — "Hamna Latif" is not a word of "Hamna Latif
  // Bhutta" either, so the membership test already rejects it. Deleted rather
  // than left as decoration that no test can defend.
  const words = display.split(' ').filter(Boolean);
  const hit = words.find((w) => w.toLowerCase() === asked.toLowerCase());
  return hit ?? display;
}

/**
 * The one sentence stating the absence, for any block that names a third party.
 *
 * It names the fabrication concretely — "Latif" and "her" — because DEF-213
 * established that a rule which cannot say the thing it forbids is a weaker
 * rule, and because the abstract version ("do not assume gender") reads as
 * style advice rather than as a fact about the record.
 */
export const PERSON_REFERENCE_RULE =
  'HOW TO REFER TO THESE PEOPLE: use the name in `refer_to` — that is what he calls them.\n'
  + 'NO GENDER IS RECORDED FOR ANYONE. There is no such field, so you do not know it and must\n'
  + 'not infer it from a name: "Latif" was called "her" and Latif is a man. Use the name again,\n'
  + 'or "they"/"them" — never he/she/his/her/hers for a contact, however the name reads to you.';

/** True when a rendered block carries the rule. Used by the guards. */
export function statesPersonReferenceRule(block: string): boolean {
  return String(block ?? '').includes('NO GENDER IS RECORDED FOR ANYONE');
}
