/**
 * displayIdentity — never show a routing key where a person's number belongs.
 *
 * Owner, 2026-09-04, pointing at the admin Recent Messages panel:
 * *"always show correct number not lid"*. Every one of his 58 inbound messages in seven days
 * rendered as **`+173555350261799`** — a 15-digit string that looks dialable and is not. It is
 * his own phone.
 *
 * WHERE IT COMES FROM, and why it is not simply deleted. WhatsApp does not reveal a phone number
 * for an `@lid` sender, so `WebjsProvider` derives `'+' + <lid>` as a LAST-RESORT ROUTING
 * IDENTITY. That synthetic is load-bearing: removing it was `@lid` recurrence #4, when every
 * `@lid` counterpart collapsed to nothing, matched no registration row, and a delegatee's reply
 * was dropped as "Unregistered number". So the value is correct as a KEY and wrong as a NUMBER —
 * one string doing two jobs, and only one of them is a lie.
 *
 * THE FIX IS A JOIN, NOT A DELETION — and the edge has existed since 2026-06-10:
 *
 *   whatsapp_connections { phone_number: '+173555350261799', user_id: 2,
 *                          display_name: 'Basit (LID alias 1799)' }
 *
 * The row says in its own display_name that it is an alias. The panel printed the key instead of
 * following it. Same shape as DEF-313 and DEF-314: the record holds the answer and the display
 * boundary never asks.
 *
 * The rule, in order of what is actually knowable:
 *   1. the alias belongs to a user whose real number we hold  -> show the REAL number
 *   2. the lid is a known contact                              -> show the NAME, no number
 *   3. neither                                                 -> say so; NEVER print the synthetic
 *
 * Step 3 is DEF-121's standing rule: a fabricated 15-digit number LOOKS ACTIONABLE, which is
 * worse than an admitted gap. This module never invents and never passes an invention through.
 */
import prisma from '../../db/prisma';

export interface DisplayIdentity {
  /** A real, dialable number when one is known — otherwise null. Never a synthetic. */
  number: string | null;
  /** What a human should read. Always populated. */
  label: string;
  /** True when the stored value was a routing key rather than a phone number. */
  wasAlias: boolean;
}

/**
 * A BACKSTOP for `@lid` synthetics nobody has identified, used only after both exact-match
 * lookups have failed.
 *
 * Grounded in this tenant's live data rather than guessed — `whatsapp_messages.from_number`
 * holds exactly two shapes: **12 digits (404 rows), every one a real number**, and
 * **15 digits (368 rows), every one an `@lid` synthetic**. Known `wa_lid`s run 13-15 digits,
 * and the 13s and 14s are all resolved by exact match above, so this only has to catch the
 * unidentified tail.
 *
 * E.164 does permit a genuine 15-digit number, so this is a HEURISTIC and is deliberately the
 * last thing consulted. It errs toward DEF-121's rule: when we cannot tell, admit the gap
 * rather than print a string that looks dialable. Being wrong here shows a real number as an
 * id; being wrong the other way is what put a fake number in front of the owner for months.
 */
const LID_DIGIT_THRESHOLD = 15;

function isLikelyLid(n: string): boolean {
  return n.replace(/\D/g, '').length >= LID_DIGIT_THRESHOLD;
}

/** The `@lid` synthetic is `'+' + <lid digits>`. Kept for callers that hold the raw id. */
export function lidToSynthetic(rawId: string): string {
  return '+' + rawId.replace(/@.*$/, '');
}

/**
 * Resolve stored WhatsApp numbers to what a person should see.
 *
 * Batched deliberately: the panel renders 50 rows and a per-row lookup would be 100 queries for
 * one screen. Two queries serve any number of rows.
 */
export async function resolveDisplayIdentities(
  clientNumber: string,
  numbers: Array<string | null | undefined>,
): Promise<Map<string, DisplayIdentity>> {
  const out = new Map<string, DisplayIdentity>();
  const wanted = [...new Set(numbers.filter((n): n is string => !!n && n.trim() !== ''))];
  if (!wanted.length) return out;

  // (1) The alias edge. `whatsapp_connections.phone_number` may be a real number OR an `@lid`
  //     synthetic auto-inserted by the heal layer; `users.contact_number` is the real one.
  const conns = await prisma.$queryRawUnsafe<any[]>(
    `SELECT wc.phone_number, wc.display_name, u.contact_number, u.name AS user_name
       FROM whatsapp_connections wc
       LEFT JOIN users u ON u.id = wc.user_id AND u.client_number = wc.client_number
      WHERE wc.client_number = $1 AND wc.phone_number = ANY($2::text[])`,
    clientNumber, wanted,
  ).catch(() => []);

  // (2) The contact edge, for a lid that belongs to someone who is not the owner. These rows
  //     carry a NAME and no phone, because WhatsApp withholds the number — 26 such rows live,
  //     every one with `phone` null. A name is the whole of what can honestly be shown.
  const lids = wanted.map((n) => n.replace(/^\+/, ''));
  const ents = await prisma.$queryRawUnsafe<any[]>(
    `SELECT wa_lid, name, phone FROM entities
      WHERE client_number = $1 AND wa_lid = ANY($2::text[])`,
    clientNumber, lids,
  ).catch(() => []);
  const byLid = new Map(ents.map((e: any) => [String(e.wa_lid), e]));

  for (const n of wanted) {
    const conn = conns.find((c: any) => c.phone_number === n);
    const ent = byLid.get(n.replace(/^\+/, ''));

    // An alias is a stored number that differs from its own user's real number. The comparison
    // is on digits: one side may carry '+' or spacing the other does not.
    const real = conn?.contact_number ? String(conn.contact_number) : null;
    const digits = (s: string) => s.replace(/\D/g, '');
    const isAlias = !!real && digits(real) !== digits(n);

    if (isAlias && real) {
      out.set(n, {
        number: real,
        label: conn.user_name ? `${conn.user_name} (${real})` : real,
        wasAlias: true,
      });
      continue;
    }
    if (ent) {
      // A known person whose number WhatsApp will not share. Name, and the gap stated.
      out.set(n, {
        number: ent.phone ? String(ent.phone) : null,
        label: ent.phone ? `${ent.name} (${ent.phone})` : `${ent.name} — number not shared by WhatsApp`,
        wasAlias: !ent.phone,
      });
      continue;
    }
    if (conn && real) {
      // Stored value IS the real number.
      out.set(n, { number: n, label: conn.user_name ? `${conn.user_name} (${n})` : n, wasAlias: false });
      continue;
    }
    // Unknown to both edges. If it has the shape of a lid, it is NOT shown as a number —
    // this is the branch that was leaking `+239487846228094` at owner-visible width.
    if (isLikelyLid(n)) {
      out.set(n, { number: null, label: unknownLidLabel(n), wasAlias: true });
      continue;
    }
    out.set(n, { number: n, label: n, wasAlias: false });
  }
  return out;
}

/** What to render for an `@lid` sender nobody has identified. Never a `+`-prefixed string: the
 *  leading plus is what makes a synthetic read as a phone number in the first place. */
export function unknownLidLabel(rawId: string): string {
  // OWNER RULING, 2026-09-04: *"for me it is useless, if u still want to show, then always show
  // with real number"*. So when there is no real number the id STOPS BEING THE VALUE. It is
  // demoted to a short reference — his own words, *"u can synthetic at your end or references"* —
  // which keeps two unknown senders distinguishable without putting a fake number in front of
  // him. The full id stays available where it belongs: the raw column, the API field, and the
  // cell's hover title.
  //
  // The leading '+' never survives: it is the single character that makes a routing key read as
  // dialable, and it is the whole of what he reported.
  const id = rawId.replace(/@.*$/, '').replace(/^\+/, '');
  return `Unknown WhatsApp sender — number not shared (ref ${id.slice(-4)})`;
}

/**
 * OWNER RULING, 2026-09-04 — the synthetic must never reach him, in any channel:
 * *"+173555350261799 this is totaly usless for me, don't show me i want to see real number only
 * anywher on UI and communication"*, and *"u can synthetic at your end or references ... if u
 * still want to show, then always show with real number"*.
 *
 * The panel was only one surface. This is the other one he named: what Brain SAYS. The `@lid`
 * class has now reached five occurrences precisely because it was closed surface by surface —
 * DEF-121, DEF-269, DEF-272, DEF-298, DEF-318 — so this is applied at the transport chokepoints
 * every outbound message already passes through, not at the places that happen to be known today.
 *
 * WHAT IT MATCHES, and why it is safe. Only `+` followed by 13 or more digits. Grounded in the
 * live table: every real number stored for this tenant is **12 digits (404 rows)** and every
 * synthetic is **15 (368 rows)**, with known `@lid`s running 13-15. A bare digit run without the
 * `+` is deliberately NOT matched — order numbers, references and amounts must survive untouched,
 * and it is the `+` that makes a string read as dialable in the first place.
 *
 * Replacement follows the same three tiers as the panel, so one rule governs both surfaces:
 * the real number when we hold it, the person's name when we hold that, and otherwise a plain
 * admission with no digits at all.
 *
 * Failure is silent and returns the ORIGINAL text: a scrubber that throws must never cost him
 * the message it was cleaning.
 */
export async function scrubSyntheticIdentities(
  text: string,
  clientNumber?: string,
): Promise<string> {
  if (!text || !/\+\d{13,}/.test(text)) return text;
  try {
    const found = [...new Set(text.match(/\+\d{13,}/g) ?? [])];
    if (!found.length) return text;
    const ids = clientNumber
      ? await resolveDisplayIdentities(clientNumber, found)
      : new Map<string, DisplayIdentity>();
    let out = text;
    for (const token of found) {
      const id = ids.get(token);
      let replacement: string;
      if (id?.number) {
        // Tier 1 — we hold the real number. This is the "always show with real number" case.
        replacement = id.number;
      } else if (id && !/^Unknown WhatsApp sender/.test(id.label)) {
        // Tier 2 — a known person whose number WhatsApp withholds: the NAME, never the id.
        replacement = id.label;
      } else {
        // Tier 3 — nothing known. No digits reach him at all; DEF-121's rule, that a
        // fabricated-looking identifier reads as actionable and is worse than an admitted gap.
        replacement = 'a WhatsApp sender whose number WhatsApp did not share';
      }
      out = out.split(token).join(replacement);
    }
    return out;
  } catch {
    return text;
  }
}
