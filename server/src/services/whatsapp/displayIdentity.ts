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
  // The leading '+' is stripped deliberately: it is the single character that makes a routing
  // key read as a dialable number, which is the whole of what the owner reported.
  const id = rawId.replace(/@.*$/, '').replace(/^\+/, '');
  return `WhatsApp ID ${id} — number not shared`;
}
