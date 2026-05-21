/**
 * Contact resolver — given a partial name like "Asad", return ranked
 * candidates (internal users + external Entity contacts).
 *
 * This is the resolver Brain Chat uses when MD says "delegate to Asad"
 * or "set a meeting with Asad" — instead of guessing or denying, Brain
 * gets a ranked list, and the composer prompt asks Brain to:
 *   - emit the action with the resolved email if there's a dominant winner
 *   - ask ONE clarifying question listing top 2 if it's ambiguous
 *
 * Ranking signals (per candidate):
 *   - nameSimilarity   : how well the candidate name matches the query
 *   - recency7d        : interactions in the last 7 days (gmail/wa/chat)
 *   - frequency        : total interaction count (sender wiki metadata)
 *   - relationship     : 'internal_teammate' (User row in same tenant)
 *                        beats 'external_contact' (Entity row only)
 *   - delegateePast    : has MD delegated to this person before? (boost)
 *
 * Designed to degrade gracefully:
 *   - pg_trgm not installed → fall back to ILIKE prefix/contains match
 *   - sender wiki missing → drop the recency/frequency signal (still ranks
 *     by name + delegation history)
 *   - no candidates found → return empty array; the composer must then
 *     ask the user to spell out who they mean
 */
import prisma from '../../db/prisma';

export interface ContactCandidate {
  source: 'user' | 'entity';
  id: string | number;
  displayName: string;
  email: string | null;
  /** 'internal_teammate' for User rows (same tenant), 'external_contact'
   *  for Entity rows (anyone MD has corresponded with). */
  relationship: 'internal_teammate' | 'external_contact';
  signals: {
    nameSimilarity: number;     // 0..1 — higher = better match
    lastInteractionAt: Date | null;
    interactions7d: number;
    totalInteractions: number;
    delegatedToCount: number;    // times MD has delegated TO this person
    /** Plain-English reasons the candidate ranked here; injected into
     *  the prompt so Brain can quote them when asking the user to pick. */
    reasons: string[];
  };
  /** Composite score used for ranking. */
  score: number;
}

export interface ResolveContactOptions {
  /** Tenant for User & Entity lookups. */
  clientNumber: string;
  /** Caller's user id — used to scope delegation history. */
  userId: number;
  /** Hard cap on candidates returned. */
  limit?: number;
  /** Optional topic hint ("audit", "Phoenix Systems") to nudge ranking
   *  toward people whose recent activity matches the topic. Not used in
   *  v1 — placeholder for future expansion. */
  topicHint?: string;
}

const DEFAULT_LIMIT = 5;

/** Strip noise tokens before comparison: titles, common honorifics, etc.
 *  Keep alphanumerics + spaces; lowercase. */
function normalise(s: string): string {
  return s
    .replace(/\b(mr|mrs|ms|miss|dr|prof|sir|madam)\.?\b/gi, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Cheap name-similarity: substring containment plus first-token equality.
 *  Returns 0..1. Used as a fallback when pg_trgm isn't available. */
function nameScore(candidate: string, query: string): number {
  const c = normalise(candidate);
  const q = normalise(query);
  if (!c || !q) return 0;
  if (c === q) return 1;
  const cTokens = c.split(' ');
  const qTokens = q.split(' ');
  // First-name exact match — "Asad" → "Asad Shafique" scores high.
  if (cTokens[0] === qTokens[0]) return 0.85;
  // Any token equal — "Khan" → "Asad Khan" scores high.
  if (cTokens.some((t) => qTokens.includes(t))) return 0.7;
  // Substring containment — "asad" inside "asadshafique" (compressed) etc.
  if (c.replace(/\s/g, '').includes(q.replace(/\s/g, ''))) return 0.5;
  return 0;
}

export async function resolveContact(
  partialName: string,
  opts: ResolveContactOptions,
): Promise<ContactCandidate[]> {
  const { clientNumber, userId, limit = DEFAULT_LIMIT } = opts;
  const q = partialName.trim();
  if (!q) return [];

  // ── 1. Pull candidates from BOTH the internal user roster and the
  //      external Entity table. We do this in parallel and merge.
  const ilikePattern = `%${q.replace(/[%_]/g, '\\$&')}%`;
  const [users, entities] = await Promise.all([
    prisma.user.findMany({
      where: {
        clientNumber,
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' as any } },
          { email: { contains: q, mode: 'insensitive' as any } },
        ],
      },
      select: { id: true, name: true, email: true, department: true, jobDescription: true },
      take: 20,
    }).catch(() => [] as any[]),
    // P0 (2026-05-22): user-owned entities ONLY, plus tenant-shared
    // ones. Without this filter, contacts created from Haseeb's email
    // ingestion (scope='user', ownerUserId=Haseeb.id) would leak into
    // Basit's resolver results. The cross-user leak Basit reported.
    prisma.entity.findMany({
      where: {
        clientNumber,
        entityType: 'contact',
        OR: [
          { name: { contains: q, mode: 'insensitive' as any } },
          { email: { contains: q, mode: 'insensitive' as any } },
        ],
        AND: [{
          OR: [
            { scope: 'tenant' },                           // tenant-shared
            { scope: 'user', ownerUserId: userId },         // user-owned
            // Legacy rows with createdBy but no ownerUserId yet — fall back
            // to createdBy for back-compat until backfill completes.
            { ownerUserId: null, createdBy: userId },
          ],
        }],
      },
      select: { id: true, name: true, email: true, lastInteraction: true, relationshipStrength: true },
      take: 30,
    }).catch(() => [] as any[]),
  ]);

  // De-duplicate: an internal user usually ALSO has an Entity row from
  // when MD's emails to them got scribed. The User row wins (we get
  // department/jobDescription from it). Drop the Entity row whose email
  // matches a User we already have.
  const userEmails = new Set(users.map((u) => (u.email || '').toLowerCase()).filter(Boolean));
  const dedupedEntities = entities.filter((e) => !userEmails.has((e.email || '').toLowerCase()));

  // ── 2. Pull aggregate signals from feed_events for each unique email.
  //      Used to compute recency7d and totalInteractions WITHOUT relying
  //      on the sender wiki being up to date.
  const allEmails = [
    ...users.map((u) => u.email).filter(Boolean),
    ...dedupedEntities.map((e) => e.email).filter(Boolean),
  ] as string[];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const recentByEmail = new Map<string, { recent7d: number; total: number; lastAt: Date | null }>();
  if (allEmails.length > 0) {
    const rows = await prisma.$queryRawUnsafe<Array<{ email: string; recent7d: bigint; total: bigint; last_at: Date | null }>>(
      `SELECT lower(sender_email) AS email,
              SUM(CASE WHEN created_at >= $2 THEN 1 ELSE 0 END)::bigint AS recent7d,
              COUNT(*)::bigint AS total,
              MAX(created_at) AS last_at
         FROM feed_events
        WHERE client_number = $1
          AND lower(sender_email) = ANY($3::text[])
          AND created_at >= $4
        GROUP BY lower(sender_email)`,
      clientNumber, sevenDaysAgo, allEmails.map((e) => e.toLowerCase()), ninetyDaysAgo,
    ).catch(() => [] as any[]);
    for (const r of rows) {
      recentByEmail.set(r.email, {
        recent7d: Number(r.recent7d),
        total: Number(r.total),
        lastAt: r.last_at,
      });
    }
  }

  // ── 3. Pull delegation history (how often has MD delegated TO this
  //      person from any feed). Boosts candidates MD already trusts for
  //      handing things off.
  const delegatedByEmail = new Map<string, number>();
  if (allEmails.length > 0) {
    const rows = await prisma.$queryRawUnsafe<Array<{ email: string; n: bigint }>>(
      `SELECT lower(delegatee_email) AS email, COUNT(*)::bigint AS n
         FROM open_items
        WHERE client_number = $1
          AND user_id = $2
          AND status = 'DELEGATED'
          AND lower(delegatee_email) = ANY($3::text[])
        GROUP BY lower(delegatee_email)`,
      clientNumber, userId, allEmails.map((e) => e.toLowerCase()),
    ).catch(() => [] as any[]);
    for (const r of rows) delegatedByEmail.set(r.email, Number(r.n));
  }

  // ── 4. Assemble candidates and score.
  const out: ContactCandidate[] = [];
  for (const u of users) {
    const emailLc = (u.email || '').toLowerCase();
    const stats = recentByEmail.get(emailLc) ?? { recent7d: 0, total: 0, lastAt: null };
    const delegated = delegatedByEmail.get(emailLc) ?? 0;
    const sim = nameScore(u.name, q);
    const score = scoreCandidate({
      nameSimilarity: sim,
      recent7d: stats.recent7d,
      total: stats.total,
      delegated,
      relationship: 'internal_teammate',
    });
    const reasons: string[] = [];
    if (sim >= 0.85) reasons.push('first-name match');
    else if (sim >= 0.5) reasons.push('name contains your query');
    if (stats.recent7d > 0) reasons.push(`${stats.recent7d} interaction${stats.recent7d === 1 ? '' : 's'} this week`);
    if (delegated > 0) reasons.push(`you've delegated to them ${delegated} time${delegated === 1 ? '' : 's'} before`);
    if (u.department) reasons.push(`${u.department} team`);
    out.push({
      source: 'user',
      id: u.id,
      displayName: u.name,
      email: u.email,
      relationship: 'internal_teammate',
      signals: {
        nameSimilarity: sim,
        lastInteractionAt: stats.lastAt,
        interactions7d: stats.recent7d,
        totalInteractions: stats.total,
        delegatedToCount: delegated,
        reasons,
      },
      score,
    });
  }
  for (const e of dedupedEntities) {
    const emailLc = (e.email || '').toLowerCase();
    const stats = recentByEmail.get(emailLc) ?? { recent7d: 0, total: 0, lastAt: e.lastInteraction ?? null };
    const delegated = delegatedByEmail.get(emailLc) ?? 0;
    const sim = nameScore(e.name, q);
    const score = scoreCandidate({
      nameSimilarity: sim,
      recent7d: stats.recent7d,
      total: stats.total,
      delegated,
      relationship: 'external_contact',
    });
    const reasons: string[] = [];
    if (sim >= 0.85) reasons.push('first-name match');
    else if (sim >= 0.5) reasons.push('name contains your query');
    if (stats.recent7d > 0) reasons.push(`${stats.recent7d} interaction${stats.recent7d === 1 ? '' : 's'} this week`);
    else if (stats.total > 0 && stats.lastAt) {
      const days = Math.round((Date.now() - stats.lastAt.getTime()) / (24 * 60 * 60 * 1000));
      reasons.push(`last contact ${days}d ago`);
    } else {
      reasons.push('external contact');
    }
    if (delegated > 0) reasons.push(`you've delegated to them ${delegated}x before`);
    out.push({
      source: 'entity',
      id: e.id,
      displayName: e.name,
      email: e.email,
      relationship: 'external_contact',
      signals: {
        nameSimilarity: sim,
        lastInteractionAt: stats.lastAt,
        interactions7d: stats.recent7d,
        totalInteractions: stats.total,
        delegatedToCount: delegated,
        reasons,
      },
      score,
    });
  }

  // ── Sprint 2: alias memory boost ─────────────────────────────────
  // Before sorting, check whether the user has previously resolved
  // this alias to a specific identifier. If so, boost the matching
  // candidate dramatically — the user has already done the work of
  // disambiguation; we shouldn't re-ask. Per the third-party review:
  // "Once the user has resolved 'Asad → asad.ahmed@tmcltd.ai',
  // subsequent sessions should not re-ask."
  try {
    const { bestAliasResolution } = await import('./userResolutionAliasService');
    const prior = await bestAliasResolution(userId, q);
    if (prior) {
      const matchIdLc = prior.identifier.toLowerCase();
      for (const c of out) {
        if ((c.email ?? '').toLowerCase() === matchIdLc) {
          // +200 boost is decisive — even a single past resolution
          // makes this the obvious winner unless something has
          // catastrophically changed.
          c.score += 200;
          c.signals.reasons.unshift(
            `you've previously resolved "${q}" to this person (${prior.usedCount}× before)`,
          );
        }
      }
    }
  } catch { /* alias service failure is non-fatal — drop to vanilla ranking */ }

  // ── Sprint 3: Person cross-channel enrichment ────────────────────
  // For each candidate with an email, look up if a Person record has
  // multiple facets — surface the additional channels ("also reachable
  // via WhatsApp +923...") so the LLM and user see ONE coherent
  // identity instead of three split rows. Non-fatal on error.
  try {
    const { findPersonByFacet } = await import('./personService');
    for (const c of out) {
      const email = c.email;
      if (!email) continue;
      const person = await findPersonByFacet(userId, 'email', email).catch(() => null);
      if (!person) continue;
      const otherFacets = person.facets.filter(
        (f) => !(f.facetType === 'email' && f.facetValue.toLowerCase() === email.toLowerCase()),
      );
      if (otherFacets.length === 0) continue;
      const channelList = otherFacets
        .map((f) => `${f.facetType.replace('_', ' ')} ${f.facetValue}`)
        .slice(0, 3)
        .join(', ');
      c.signals.reasons.push(`also reachable via ${channelList}`);
    }
  } catch { /* person service failure is non-fatal */ }

  // Sort by score desc, return top N. Drop anything with similarity 0 — if
  // there's no name overlap at all, it shouldn't be in the candidate list
  // (avoids the "I matched on email substring nobody asked about" failure).
  out.sort((a, b) => b.score - a.score);
  const filtered = out.filter((c) => c.signals.nameSimilarity > 0);

  // ── Same-name HINT, not silent merge ─────────────────────────────────
  // Per MD 2026-05-12 ("are you hardcoding??"): I previously merged
  // candidates with the same normalized name silently. That's a
  // hardcoded judgement — "same name = same person" — applied without
  // LLM context. Two real people can share a name.
  //
  // Brain-grade approach: surface BOTH candidates with a "likelySamePerson"
  // hint when names match closely. The LLM sees both rows + the hint
  // and reasons from full context (sender wikis, recent activity,
  // employer, prior delegations) about whether they're the same identity.
  // If the LLM is confident they're one person, it treats them as such
  // in its response. If not, it asks the user. Either way the JUDGEMENT
  // happens at the LLM-with-context layer, not at a string compare.
  for (const c of filtered) {
    const others = filtered.filter((o) => o !== c && normalise(o.displayName) === normalise(c.displayName));
    if (others.length > 0) {
      // Mark this candidate as having same-name siblings. The
      // renderCandidatesBlock function picks this up and adds a hint
      // like "(also appears as +923... — possibly same person)".
      const altIdentifiers = others.map((o) => o.email ?? 'WhatsApp').join(' / ');
      c.signals.reasons.push(`same name also appears via ${altIdentifiers} — likely same person, confirm with user if uncertain`);
    }
  }

  return filtered.slice(0, limit);
}

function scoreCandidate(args: {
  nameSimilarity: number;
  recent7d: number;
  total: number;
  delegated: number;
  relationship: 'internal_teammate' | 'external_contact';
}): number {
  // Name match is the gate (everything below ~0.5 means "probably wrong
  // person"). Then layer recency/frequency/delegation/role on top.
  const nameWeight = args.nameSimilarity * 100;
  const recencyWeight = Math.min(args.recent7d, 10) * 8;          // up to +80 for 10+ interactions in last 7 days
  const frequencyWeight = Math.log10(1 + args.total) * 10;        // diminishing returns; 100 total → +20
  const delegationWeight = Math.min(args.delegated, 5) * 12;      // up to +60 for 5+ past delegations
  const relWeight = args.relationship === 'internal_teammate' ? 15 : 0;
  return nameWeight + recencyWeight + frequencyWeight + delegationWeight + relWeight;
}

/** Determine whether the top candidate is clearly dominant. Brain Chat
 *  uses this to decide between "act with this email" vs "ask user to
 *  pick from the top N". Definition: top score > 1.5x the second's
 *  AND top has at least the minimum confidence floor. */
export function topIsDominant(candidates: ContactCandidate[]): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length === 1) return candidates[0].score >= 50;
  const [a, b] = candidates;
  return a.score >= 50 && a.score > b.score * 1.5;
}

/** Markdown block of candidates for injection into the composer prompt.
 *  Lists name, email, relationship, and reasons. Used by the composer
 *  to disambiguate person names mentioned in the user's message. */
export function renderCandidatesBlock(query: string, candidates: ContactCandidate[]): string {
  if (candidates.length === 0) {
    return `# Candidates for "${query}"\n(no matching contacts found — ask the user to spell out the full name or provide an email)`;
  }
  const lines: string[] = [`# Candidates for "${query}" (resolver ranked, top first)`];
  candidates.forEach((c, idx) => {
    const tag = c.relationship === 'internal_teammate' ? '[teammate]' : '[external]';
    const email = c.email ?? '(no email on file)';
    const reasons = c.signals.reasons.length ? ` — ${c.signals.reasons.join(', ')}` : '';
    lines.push(`${idx + 1}. ${c.displayName} <${email}> ${tag}${reasons}  (score ${Math.round(c.score)})`);
  });
  if (topIsDominant(candidates)) {
    lines.push('\nThe top candidate is dominant — use it directly when filling action.delegateeEmail / attendeeEmails. Confirm in your prose ("Setting up with X — sound right?") but do not ask "which X?".');
  } else {
    lines.push('\nNo dominant winner. Ask ONE question listing the top 2 by name + one distinguishing reason each. Do NOT emit an action yet.');
  }
  return lines.join('\n');
}
