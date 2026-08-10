/**
 * MEM-002 — pruning duplicate identities, safely and without the owner in the loop.
 *
 * Owner, 2026-08-10: *"I want you to prune smartly (where i don't want to
 * intervene) u should learn how to do on basis of email, name contact etc"*.
 *
 * ── WHAT THE REAL DATA LOOKS LIKE ───────────────────────────────────────────
 * Measured on production, and it is four different problems wearing one name:
 *
 *   1. MACHINE REPLY-ADDRESSES — "anthropic" existed 49 times, each row a
 *      unique `no-reply-<random>@mail.anthropic.com`. One organisation, 49
 *      per-message envelope addresses.
 *   2. ONE ORG, MANY SUBDOMAINS — sap@mailsap.com, sap@mail.sap.com,
 *      __company__@surveys.sap.com. Same company, different sending systems.
 *   3. BLANK NAMES — seven rows sharing an empty name whose emails belong to
 *      Linworld, SAP, Hitachi and TMC. **Merging on name would fuse four
 *      unrelated companies into one.** This is why the naive sweep is dangerous
 *      rather than merely imperfect.
 *   4. ONE HUMAN, SEVERAL RECORDS — "laiba zahid" three times: one phone-only,
 *      one @tmcltd.com, one @tmcltd.ai. This is the DEF-046 class and the only
 *      one that actually degrades Brain's answers.
 *
 * ── THE RULE THAT FALLS OUT ─────────────────────────────────────────────────
 * Evidence, not similarity. Two records merge when something IDENTIFYING is
 * shared — an address, a number, a domain plus a real name — never because two
 * strings look alike. A wrong merge silently fuses two people's history and is
 * effectively unrecoverable in the user's mind even when reversible in the
 * database, so the asymmetry is deliberate: we would rather leave ten duplicates
 * than create one false identity.
 *
 * Genuine ambiguity is not resolved by a cleverer regex. It is left alone and
 * reported — consistent with the standing ruling that judgement is
 * LLM-with-context or a human's, never a pattern.
 */

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('identity-resolution');

/**
 * Every column across the schema that points at `entities`.
 *
 * Only `entity_links` has an actual foreign key. The other five carry an
 * entity id with NO database-level protection, so a merge that forgot one would
 * silently orphan rows and nothing would complain. This list is the safety
 * property of the whole file: a merge repoints all of it or none of it.
 */
const ENTITY_REFERENCES: Array<{ table: string; column: string }> = [
  { table: 'entity_links', column: 'entity_id' },
  { table: 'entity_links', column: 'linked_entity_id' },
  { table: 'open_items', column: 'entity_id' },
  { table: 'delegation_threads', column: 'counterpart_entity_id' },
  { table: 'delegation_logs', column: 'entity_id' },
  { table: 'okrs', column: 'entity_id' },
  { table: 'decision_logs', column: 'entity_id' },
];

export type MergeConfidence = 'certain' | 'high' | 'ambiguous';

export interface MergeProposal {
  survivorId: string;
  duplicateIds: string[];
  confidence: MergeConfidence;
  /** Why, in words a human can check. Recorded with the merge. */
  reason: string;
  displayName: string;
}

interface EntityRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  entity_type: string | null;
  linked_person_id: string | null;
  relationship_strength: number | null;
  last_interaction: Date | null;
  created_at: Date;
}

// ── Normalisation ───────────────────────────────────────────────────────────

const normEmail = (e: string | null): string => (e ?? '').trim().toLowerCase();
const normPhone = (p: string | null): string => (p ?? '').replace(/[^\d]/g, '');
const normName = (n: string | null): string => (n ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The registrable part of a mail domain: `mail.sap.com` and `surveys.sap.com`
 * both reduce to `sap.com`, which is what makes class 2 tractable.
 *
 * Deliberately simple — last two labels — with an allowance for the common
 * two-part public suffixes. A full public-suffix list would be more correct and
 * is not worth the dependency here: getting `co.uk` wrong merges two companies
 * that share nothing but a country, so those are handled explicitly.
 */
const TWO_PART_TLDS = new Set(['co.uk', 'com.pk', 'co.in', 'com.au', 'co.za', 'com.sg', 'co.jp', 'com.br']);
function registrableDomain(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0) return '';
  const host = email.slice(at + 1);
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

/**
 * Is this a machine envelope address rather than a person's mailbox?
 *
 * `no-reply-nh3wknaevojfawuhyi5bka@mail.anthropic.com` identifies a MESSAGE,
 * not a correspondent. Treating each as a separate contact is what produced 49
 * "Anthropic" entities. The random-looking local part is the tell, alongside
 * the usual no-reply prefixes.
 */
function isMachineAddress(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf('@')).toLowerCase();
  if (!local) return false;
  if (/^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce|postmaster|automated)/.test(local)) return true;
  if (local === '__company__') return true;
  // A long high-entropy local part with no vowels-to-consonants rhythm is an
  // opaque token, not a name someone chose.
  if (local.length >= 20 && /[a-z0-9_-]{20,}/.test(local) && !/\./.test(local)) {
    const digitsAndDashes = (local.match(/[\d_-]/g) ?? []).length;
    if (digitsAndDashes >= 3) return true;
  }
  return false;
}

/** A person's name we can actually reason about — not blank, not a placeholder. */
function isRealPersonName(name: string | null): boolean {
  const n = normName(name);
  if (n.length < 3) return false;
  if (n === 'unknown' || n === 'no name' || n === '__company__') return false;
  // Needs at least two parts to be a person rather than a brand ("sap", "google").
  return n.split(' ').length >= 2;
}

// ── Proposal ────────────────────────────────────────────────────────────────

/**
 * Propose merges for one tenant. Reads only — nothing is changed here.
 *
 * Grouping happens by EVIDENCE in descending strength, and a record joins the
 * first group it qualifies for so it can never land in two.
 */
export async function proposeEntityMerges(clientNumber: string): Promise<MergeProposal[]> {
  const rows = await prisma.$queryRawUnsafe<EntityRow[]>(
    `SELECT id, name, email, phone, company, entity_type, linked_person_id,
            relationship_strength, last_interaction, created_at
       FROM entities WHERE client_number = $1`,
    clientNumber,
  ).catch(() => [] as EntityRow[]);

  const proposals: MergeProposal[] = [];
  const claimed = new Set<string>();

  const group = (
    members: EntityRow[],
    confidence: MergeConfidence,
    reason: string,
  ) => {
    const free = members.filter((m) => !claimed.has(m.id));
    if (free.length < 2) return;
    const survivor = pickSurvivor(free);
    for (const m of free) claimed.add(m.id);
    proposals.push({
      survivorId: survivor.id,
      duplicateIds: free.filter((m) => m.id !== survivor.id).map((m) => m.id),
      confidence,
      reason,
      displayName: survivor.name?.trim() || survivor.email || survivor.id,
    });
  };

  // ── 1. Identical email. The strongest evidence there is: an address is a
  // delivery guarantee, so two rows holding the same one are the same
  // correspondent by definition.
  const byEmail = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const e = normEmail(r.email);
    if (!e || !e.includes('@')) continue;
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(r);
  }
  for (const [email, members] of byEmail) {
    group(members, 'certain', `identical email address ${email}`);
  }

  // ── 2. Identical phone. Same reasoning, one step weaker: numbers get reused
  // across years in a way addresses rarely are.
  const byPhone = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const p = normPhone(r.phone);
    if (p.length < 9) continue; // too short to identify anyone
    (byPhone.get(p) ?? byPhone.set(p, []).get(p)!).push(r);
  }
  for (const [phone, members] of byPhone) {
    group(members, 'certain', `identical phone number ending ${phone.slice(-4)}`);
  }

  // ── 3. Machine addresses at one organisation. The 49-Anthropic case: every
  // row is an envelope address for the same sender. Requires a real
  // organisation name so blank-named rows can never be swept in.
  const byOrgMachine = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const e = normEmail(r.email);
    const n = normName(r.name);
    if (!e.includes('@') || !n || n === '__company__') continue;
    if (!isMachineAddress(e)) continue;
    const key = `${n}::${registrableDomain(e)}`;
    (byOrgMachine.get(key) ?? byOrgMachine.set(key, []).get(key)!).push(r);
  }
  for (const [key, members] of byOrgMachine) {
    const [name, domain] = key.split('::');
    group(members, 'high', `${members.length} machine reply-addresses for "${name}" at ${domain} — one sender, not ${members.length} contacts`);
  }

  // ── 4. Same name at the same organisation. "laiba zahid" on tmcltd.com and
  // tmcltd.ai: one human, two records. Both a real person name AND a shared
  // registrable domain are required — either alone is not identifying.
  const byNameDomain = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const e = normEmail(r.email);
    if (!e.includes('@')) continue;
    if (!isRealPersonName(r.name)) continue;
    const key = `${normName(r.name)}::${registrableDomain(e)}`;
    (byNameDomain.get(key) ?? byNameDomain.set(key, []).get(key)!).push(r);
  }
  for (const [key, members] of byNameDomain) {
    const [name, domain] = key.split('::');
    group(members, 'high', `same person "${name}" at ${domain} across ${members.length} records`);
  }

  // ── 4b. Same person at SIBLING TLDs of one company.
  //
  // "laiba zahid" exists on tmcltd.com and tmcltd.ai. Those are different
  // registrable domains, so rule 4 does not fire — yet a company owning several
  // TLDs of one brand is completely ordinary, and the two addresses are plainly
  // the same person at the same employer.
  //
  // The evidence required is deliberately narrow: an identical REAL person name
  // AND an identical domain label before the TLD. "laiba zahid @ tmcltd.*" is
  // one person; a shared brand alone would not be enough, and a shared name
  // alone certainly is not.
  const domainLabel = (email: string) => registrableDomain(email).split('.')[0] ?? '';
  const bySiblingTld = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const e = normEmail(r.email);
    if (!e.includes('@') || !isRealPersonName(r.name)) continue;
    const label = domainLabel(e);
    // Public mailbox providers share a label across the entire world — two
    // people at gmail.com are not colleagues.
    if (!label || ['gmail', 'outlook', 'hotmail', 'yahoo', 'icloud', 'proton', 'protonmail', 'live', 'aol'].includes(label)) continue;
    const key = `${normName(r.name)}::${label}`;
    (bySiblingTld.get(key) ?? bySiblingTld.set(key, []).get(key)!).push(r);
  }
  for (const [key, members] of bySiblingTld) {
    const [name, label] = key.split('::');
    const tlds = [...new Set(members.map((m) => registrableDomain(normEmail(m.email))))].join(', ');
    group(members, 'high', `same person "${name}" at sibling domains of ${label} (${tlds}) — one employer, several TLDs`);
  }

  // ── 5. Same person name, one record carrying only a phone. The remaining
  // half of the laiba case. Left AMBIGUOUS on purpose: a shared name without a
  // shared address or domain is a coincidence waiting to happen, and two
  // different people with the same name is not a rare event.
  const byPersonName = new Map<string, EntityRow[]>();
  for (const r of rows) {
    if (!isRealPersonName(r.name)) continue;
    const key = normName(r.name);
    (byPersonName.get(key) ?? byPersonName.set(key, []).get(key)!).push(r);
  }
  for (const [name, members] of byPersonName) {
    group(members, 'ambiguous', `same name "${name}" but no shared address, number or domain — needs a human or a stronger signal`);
  }

  return proposals;
}

/**
 * Which record survives a merge.
 *
 * The one carrying the most identity, then the most history — because the
 * survivor's id is what every other table will point at, and the richest record
 * is the one a human would recognise.
 */
function pickSurvivor(members: EntityRow[]): EntityRow {
  const score = (r: EntityRow) =>
    (r.linked_person_id ? 8 : 0) +
    (normEmail(r.email).includes('@') && !isMachineAddress(normEmail(r.email)) ? 4 : 0) +
    (normPhone(r.phone).length >= 9 ? 3 : 0) +
    (isRealPersonName(r.name) ? 2 : 0) +
    (r.company ? 1 : 0) +
    Math.min(2, (r.relationship_strength ?? 0));
  return [...members].sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    // Tie-break on real history, then age: the oldest record is the one other
    // systems have had longest to reference.
    const la = a.last_interaction?.getTime() ?? 0;
    const lb = b.last_interaction?.getTime() ?? 0;
    if (lb !== la) return lb - la;
    return a.created_at.getTime() - b.created_at.getTime();
  })[0];
}

// ── Merge ───────────────────────────────────────────────────────────────────

export interface MergeOutcome {
  survivorId: string;
  mergedIds: string[];
  repointed: Record<string, number>;
  rollback: unknown;
}

/**
 * Merge duplicates into a survivor, inside ONE transaction.
 *
 * Two properties matter more than the saving:
 *
 *  1. ALL-OR-NOTHING. Five of the seven referencing columns have no foreign
 *     key, so a partial merge would leave rows pointing at a deleted entity and
 *     the database would not object. A transaction is what makes "repoint
 *     everything or change nothing" true rather than aspirational.
 *
 *  2. REVERSIBLE. The pre-merge state of every deleted row, and every id that
 *     was repointed, is captured BEFORE the change and returned. A merge that
 *     cannot be undone is a deletion wearing a nicer word.
 *
 * The survivor also absorbs any identifying field it was missing — a
 * phone-only record merging into an email-only one should leave BOTH known,
 * otherwise the merge has destroyed information while claiming to consolidate it.
 */
export async function mergeEntities(
  clientNumber: string,
  survivorId: string,
  duplicateIds: string[],
  reason: string,
): Promise<MergeOutcome | null> {
  if (duplicateIds.length === 0) return null;

  try {
    return await prisma.$transaction(async (tx) => {
      // Snapshot first — this IS the rollback record.
      const doomed = await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM entities WHERE client_number = $1 AND id = ANY($2::text[])`,
        clientNumber, duplicateIds,
      );
      const survivor = (await tx.$queryRawUnsafe<any[]>(
        `SELECT * FROM entities WHERE client_number = $1 AND id = $2`,
        clientNumber, survivorId,
      ))[0];
      if (!survivor || doomed.length === 0) return null;

      const repointed: Record<string, number> = {};
      const movedRows: Array<{ table: string; column: string; ids: any[] }> = [];

      for (const ref of ENTITY_REFERENCES) {
        // Capture WHICH rows move, so the rollback can put back exactly those
        // and not every row that happens to point at the survivor today.
        const moving = await tx.$queryRawUnsafe<any[]>(
          `SELECT id, ${ref.column} AS old_value FROM ${ref.table} WHERE ${ref.column} = ANY($1::text[])`,
          duplicateIds,
        ).catch(() => []);
        if (moving.length === 0) continue;
        movedRows.push({ table: ref.table, column: ref.column, ids: moving });
        const n = await tx.$executeRawUnsafe(
          `UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = ANY($2::text[])`,
          survivorId, duplicateIds,
        ).catch(() => 0);
        repointed[`${ref.table}.${ref.column}`] = Number(n);
      }

      // Absorb identity the survivor lacks. Consolidation must not lose a
      // phone number just because the winning row happened to have an email.
      const best = (field: 'email' | 'phone' | 'company' | 'role') => {
        if (survivor[field]) return survivor[field];
        for (const d of doomed) if (d[field]) return d[field];
        return null;
      };
      await tx.$executeRawUnsafe(
        `UPDATE entities
            SET email = COALESCE(email, $2), phone = COALESCE(phone, $3),
                company = COALESCE(company, $4), role = COALESCE(role, $5),
                relationship_strength = GREATEST(COALESCE(relationship_strength,0), $6),
                last_interaction = GREATEST(COALESCE(last_interaction, to_timestamp(0)), $7),
                updated_at = NOW()
          WHERE id = $1`,
        survivorId, best('email'), best('phone'), best('company'), best('role'),
        Math.max(survivor.relationship_strength ?? 0, ...doomed.map((d) => d.relationship_strength ?? 0)),
        [survivor.last_interaction, ...doomed.map((d) => d.last_interaction)]
          .filter(Boolean).sort().pop() ?? survivor.last_interaction,
      ).catch(() => 0);

      await tx.$executeRawUnsafe(
        `DELETE FROM entities WHERE client_number = $1 AND id = ANY($2::text[])`,
        clientNumber, duplicateIds,
      );

      return {
        survivorId,
        mergedIds: duplicateIds,
        repointed,
        rollback: { reason, deletedEntities: doomed, movedRows, survivorBefore: survivor },
      };
    }, { timeout: 30_000 });
  } catch (err: any) {
    log.warn('entity merge failed — nothing changed', { survivorId, error: err?.message });
    return null;
  }
}


/**
 * MEM-003 — self-pruning, unattended.
 *
 * The owner asked for pruning he does not have to intervene in. The first pass
 * merged 73 rows correctly, but *I* ran it: the logic was proven and nothing
 * repeated it, which is not self-pruning, it is a chore I happened to do once.
 *
 * Only `high` and `certain` proposals are merged automatically. `ambiguous` is
 * never touched by the scheduler — it exists precisely for cases where the
 * evidence does not settle it, and a scheduler that quietly resolved those
 * would defeat the reason the category exists. They surface as a finding
 * instead, so a human sees them without being interrupted.
 *
 * Bounded per run. A pruning pass that merges hundreds of records unattended is
 * exactly the kind of thing that should be discovered slowly.
 */
export async function runIdentityPruningPass(maxMergesPerRun = 25): Promise<{
  merged: number; groups: number; ambiguous: number;
}> {
  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT client_number FROM tenants WHERE is_active = true`,
  ).catch(() => [] as Array<{ client_number: string }>);

  let merged = 0;
  let groups = 0;
  let ambiguous = 0;

  for (const t of tenants) {
    const proposals = await proposeEntityMerges(t.client_number).catch(() => [] as MergeProposal[]);
    ambiguous += proposals.filter((p) => p.confidence === 'ambiguous').length;

    const actionable = proposals.filter((p) => p.confidence !== 'ambiguous');
    for (const p of actionable) {
      if (merged >= maxMergesPerRun) break;
      const out = await mergeEntities(t.client_number, p.survivorId, p.duplicateIds, p.reason);
      if (!out) continue;
      merged += out.mergedIds.length;
      groups += 1;
      // Every automatic merge is recorded where the owner can see it, with the
      // evidence that justified it. An unattended change nobody can audit is
      // indistinguishable from data loss.
      log.info('identity merged automatically', {
        clientNumber: t.client_number, survivorId: out.survivorId,
        mergedIds: out.mergedIds, reason: p.reason,
      });
    }

    // Ambiguity is reported, never resolved by the scheduler. This is the
    // owner's "email, name, contact" judgement call, and it needs context a
    // rule does not have.
    if (ambiguous > 0) {
      const { recordFinding } = await import('../selfheal/healthFindingService');
      void recordFinding({
        clientNumber: t.client_number,
        kind: 'identity_ambiguous_duplicates',
        severity: 'info',
        source: 'identity-resolution',
        summary: `${ambiguous} possible duplicate identities share a name but no address, number or domain — merging them automatically would risk fusing two people`,
        evidence: { ambiguous, examples: proposals.filter((p) => p.confidence === 'ambiguous').slice(0, 5).map((p) => p.displayName) },
      });
    }
  }
  return { merged, groups, ambiguous };
}
