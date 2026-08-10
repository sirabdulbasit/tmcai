/**
 * DEF-109 — an item Brain owns must stop asking the owner about itself.
 *
 * The owner has asked for this three times, and it has failed a different way
 * each time:
 *
 *   08-08 16:23  "First and 3rd is for the brain for self improvement so the
 *                 brain should take care and when done the brain itself mark it
 *                 done"
 *                -> Brain asked for confirmation instead, then cancelled.
 *
 *   08-08 16:28  "delegate this item at capability related to brain. So brain
 *                 should take care of it and when the brain has built its
 *                 capability, so this open item should be marked as done"
 *                -> Brain wrote the instruction into the EXIM item as a blocker
 *                   and, later, invented a delegatee called "Watcher" that had
 *                   "declined to study brain conversations". A fabricated third
 *                   party, escalated to him twice.
 *
 *   08-10 16:40  "this actionable item is for you delegated to brain"
 *                -> Brain replied "Understood, Sir. I've updated the item" and
 *                   stored NOTHING: delegatee_name and delegatee_email both
 *                   stayed null. Worse, the item moved DRAFT -> NEW/high, which
 *                   is the state that generates MORE prompts. The instruction
 *                   to stop nagging made the nagging more likely.
 *
 * The cause is the same in all three: there is no way to say "Brain owns this".
 * `delegatee_name` holds a person, so an instruction naming Brain has nowhere
 * to land, and the model improvises — a confirmation, a fabricated colleague,
 * or a silent drop.
 *
 * The owner also stated the behaviour he wants, twice, in plain terms:
 *
 *   "you don't have to tell me about it repeatedly. When it's done, then you
 *    have to tell me that we have done it."
 *   "we will not talk about the brain one again either, you have to take care
 *    of the brain yourself, when it is complete, then tell me."
 *
 * So ownership is only half of it. The other half is that a Brain-owned item is
 * excluded from the chase-and-remind path entirely. It surfaces when it is
 * done, or when it is genuinely blocked — never as a recurring question.
 *
 * One definition, deliberately: the alias list, the canonical name and the
 * predicate all live here. Two copies of "is this Brain's?" would diverge, and
 * the divergence would show up as an item that is owned in one place and nagged
 * from another.
 */

/** What gets STORED. A real, readable name — the owner sees this in his list,
 *  and "Nexeo" is the product name he chose. Never a sentinel like `__brain__`:
 *  a value the UI has to translate is a value some surface will show raw. */
export const BRAIN_OWNER_NAME = 'Nexeo';

/**
 * What the owner might SAY. Matched case-insensitively against a delegatee
 * name. "you" and "yourself" are included because that is how he actually
 * phrases it — "this actionable item is for you" — and excluding them is what
 * made the 08-10 instruction vanish.
 */
const BRAIN_OWNER_ALIASES = new Set([
  'nexeo', 'brain', 'the brain', 'you', 'yourself', 'itself', 'self',
  'nexeo brain', 'brain itself',
]);

function norm(s: string | null | undefined): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when a delegatee name refers to Brain rather than to a person. */
export function isBrainOwnerName(name: string | null | undefined): boolean {
  const n = norm(name);
  return n.length > 0 && BRAIN_OWNER_ALIASES.has(n);
}

/**
 * Map whatever the owner said onto the stored form.
 *
 * Returns the canonical name for Brain, the original (trimmed) name for a real
 * person, and null for nothing. Callers store the result directly, so an
 * instruction naming Brain persists instead of being dropped.
 */
export function canonicaliseDelegateeName(name: string | null | undefined): string | null {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  return isBrainOwnerName(raw) ? BRAIN_OWNER_NAME : raw;
}

/** True when this item belongs to Brain and must not generate owner prompts. */
export function isBrainOwned(item: { delegateeName?: string | null; delegateeEmail?: string | null }): boolean {
  // Email is checked too: a Brain-owned item has no human address, and an item
  // that somehow acquired one is a person's item whatever the name says.
  if (item.delegateeEmail && String(item.delegateeEmail).trim()) return false;
  return isBrainOwnerName(item.delegateeName);
}

/**
 * Why a Brain-owned item is skipped, for the log line at the skip site.
 * Kept here so the reason and the rule cannot drift apart.
 */
export const BRAIN_OWNED_SKIP_REASON =
  'brain-owned item — owner is told when it is done or blocked, never chased (DEF-109)';
