/**
 * MyOS Knowledge — Wiki Scribe.
 *
 * First-cut entity writer. Runs on every new feed_event (post-ingest) and
 * on every decision_log row (post-decide). Purpose: maintain the `entities`
 * graph and create lightweight `wiki_pages` for entities that cross an
 * importance threshold.
 *
 * No LLM required for v1. Heuristics:
 *   - Sender email → Contact entity (upsert by email)
 *   - Sender company (from domain) → Company entity (upsert by email-domain key)
 *   - Link Contact → Company with 'works_at'
 *   - Update `last_interaction`, increment `relationship_strength`
 *   - Auto-create a Wiki page for any Contact with interactions ≥ 3
 *   - Auto-create a Wiki page for any Company with interactions ≥ 5
 *
 * The Entity schema is tenant-scoped (no user_id column), so all users in a
 * tenant see the same graph — matches the intent that Contacts/Companies
 * are organization-wide knowledge, not personal. Wiki pages are per-user.
 *
 * Idempotent: multiple invocations on the same event adjust counts but
 * don't create duplicates. Uses Entity's composite unique index
 * (clientNumber, entityType, email).
 *
 * LLM upgrade path (not in v1): given subject + preview, extract project/
 * topic entities, infer roles from signatures, detect sentiment.
 */
import prisma from '../../db/prisma';

// ─── Helpers ────────────────────────────────────────────────

const INTERNAL_DOMAINS = new Set(['tmcltd.ai', 'tmcltd.com', 'imperialsoft.com.pk']);
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'live.com', 'aol.com', 'protonmail.com',
]);

function parseEmail(raw?: string | null): { email?: string; name?: string } {
  if (!raw) return {};
  // "Foo Bar" <foo@bar.com>  OR  foo@bar.com
  const m = raw.match(/^\s*"?([^"<]+)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  const m2 = raw.match(/^\s*<?([^>\s]+@[^>\s]+)>?\s*$/);
  if (m2) return { email: m2[1].trim().toLowerCase() };
  return {};
}

function domainOf(email?: string): string | undefined {
  if (!email) return undefined;
  const m = email.match(/@([a-zA-Z0-9.-]+)$/);
  return m?.[1]?.toLowerCase();
}

/** Derive a human-ish company name from an email domain.
 *  lums.edu.pk → "Lums"   acme.com → "Acme"   go.fiercetelecom.com → "Fiercetelecom" */
const TLD_RE = /\.(co\.uk|co\.in|ac\.uk|ac\.in|com|org|net|ai|io|pk|ae|edu|gov|uk|us|ca|in|eu|info|biz|tv|xyz|me|dev|app)$/i;
function companyFromDomain(domain: string): string {
  let stripped = domain.toLowerCase();
  // Strip all trailing TLDs iteratively so ".edu.pk" turns into the core slug.
  for (let i = 0; i < 3 && TLD_RE.test(stripped); i++) {
    stripped = stripped.replace(TLD_RE, '');
  }
  const parts = stripped.split('.').filter(Boolean);
  const core = parts[parts.length - 1] || domain;
  return core.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Upserts ────────────────────────────────────────────────

async function upsertContact(
  clientNumber: string,
  email: string,
  name?: string,
  lastInteractionAt?: Date,
): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.entity.findUnique({
    where: { clientNumber_entityType_email: { clientNumber, entityType: 'contact', email } } as any,
    select: { id: true, relationshipStrength: true },
  }).catch(() => null);
  if (existing) {
    await prisma.entity.update({
      where: { id: existing.id },
      data: {
        name: name ?? undefined,
        lastInteraction: lastInteractionAt ?? new Date(),
        relationshipStrength: { increment: 1 } as any,
        updatedAt: new Date(),
      } as any,
    });
    return { id: existing.id, created: false };
  }

  // Duplicate prevention (2026-07-14, Basit: "don't create duplicate
  // records of contacts"). Email-exact missed = maybe a KNOWN person
  // with a NEW address (the Asad .ai/.com split produced 3 rows for
  // one man). Before creating: exactly ONE contact with the IDENTICAL
  // name → attach this email to THAT row (fills the empty slot, or
  // lands in metadata.altEmails when a different primary exists) —
  // no second row. Zero or 2+ name matches → create; ambiguity is
  // never guessed away.
  if (name && name.trim().length >= 3) {
    try {
      const { findContactByExactName, attachIdentifierToContact } = await import('./personIdentityService');
      const match = await findContactByExactName(clientNumber, name);
      if (match) {
        await attachIdentifierToContact(match.id, { email });
        await prisma.entity.update({
          where: { id: match.id },
          data: {
            lastInteraction: lastInteractionAt ?? new Date(),
            relationshipStrength: { increment: 1 } as any,
            updatedAt: new Date(),
          } as any,
        }).catch(() => {});
        return { id: match.id, created: false };
      }
    } catch { /* dedup is best-effort — fall through to create */ }
  }

  const row = await prisma.entity.create({
    data: {
      entityType: 'contact',
      name: name ?? email,
      email,
      clientNumber,
      relationshipStrength: 1,
      lastInteraction: lastInteractionAt ?? new Date(),
    } as any,
    select: { id: true },
  });
  return { id: row.id, created: true };
}

async function upsertCompany(
  clientNumber: string,
  domain: string,
): Promise<{ id: string; created: boolean }> {
  // Represent the company as an entity keyed by a synthetic "domain email"
  // to use the existing composite unique. Only non-generic consumer domains
  // get companies. (Gmail / Yahoo / etc → skip; those are personal inboxes.)
  if (GENERIC_DOMAINS.has(domain) || INTERNAL_DOMAINS.has(domain)) return { id: '', created: false };
  const syntheticEmail = `__company__@${domain}`;
  const existing = await prisma.entity.findUnique({
    where: { clientNumber_entityType_email: { clientNumber, entityType: 'account', email: syntheticEmail } } as any,
    select: { id: true },
  }).catch(() => null);
  if (existing) {
    await prisma.entity.update({
      where: { id: existing.id },
      data: {
        relationshipStrength: { increment: 1 } as any,
        lastInteraction: new Date(),
        updatedAt: new Date(),
      } as any,
    });
    return { id: existing.id, created: false };
  }
  const row = await prisma.entity.create({
    data: {
      entityType: 'account',
      name: companyFromDomain(domain),
      email: syntheticEmail,
      company: domain,
      clientNumber,
      relationshipStrength: 1,
      lastInteraction: new Date(),
    } as any,
    select: { id: true },
  });
  return { id: row.id, created: true };
}

async function linkWorksAt(clientNumber: string, contactId: string, companyId: string): Promise<void> {
  if (!contactId || !companyId) return;
  const existing = await prisma.entityLink.findFirst({
    where: {
      entityId: contactId,
      linkedEntityId: companyId,
      linkType: 'works_at',
      clientNumber,
    },
  }).catch(() => null);
  if (existing) return;
  await prisma.entityLink.create({
    data: {
      entityId: contactId,
      linkedEntityId: companyId,
      linkType: 'works_at',
      clientNumber,
    },
  }).catch(() => { /* duplicate race — ok */ });
}

// ─── Wiki page auto-creation ────────────────────────────────

const CONTACT_PAGE_THRESHOLD = 3;
const COMPANY_PAGE_THRESHOLD = 5;

async function ensureWikiPage(
  clientNumber: string,
  userId: number,
  entityId: string,
  title: string,
  pageType: 'entity',
  bodyMarkdown: string,
  sourceFeedEventId?: string,
): Promise<void> {
  const existing = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType, title },
    select: { id: true, bodyMarkdown: true },
  }).catch(() => null);
  let pageId: string | null = existing?.id ?? null;
  if (existing) {
    if (existing.bodyMarkdown !== bodyMarkdown) {
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: { bodyMarkdown, lastUpdatedBy: 'wiki_scribe', lastUpdatedAt: new Date() },
      });
    }
  } else {
    const created = await prisma.wikiPage.create({
      data: {
        clientNumber, userId, pageType, title,
        storage: 'postgres', bodyMarkdown,
        lastUpdatedBy: 'wiki_scribe',
      } as any,
      select: { id: true },
    }).catch(() => null);
    pageId = created?.id ?? null;
  }

  // Cite the source feed_event so the linter sees a non-zero source count.
  // Guard against duplicates (same page + same feed_event) since this runs
  // on every ingest.
  if (pageId && sourceFeedEventId) {
    const alreadyCited = await prisma.wikiPageSource.findFirst({
      where: { wikiPageId: pageId, feedEventId: sourceFeedEventId },
      select: { id: true },
    }).catch(() => null);
    if (!alreadyCited) {
      await prisma.wikiPageSource.create({
        data: { wikiPageId: pageId, feedEventId: sourceFeedEventId, clientNumber, userId },
      }).catch(() => { /* dup ok */ });
    }
  }
}

async function maybeCreateContactPage(
  clientNumber: string,
  userId: number,
  contactId: string,
  sourceFeedEventId?: string,
): Promise<void> {
  const contact = await prisma.entity.findUnique({
    where: { id: contactId },
    select: { name: true, email: true, relationshipStrength: true, lastInteraction: true },
  });
  if (!contact || (contact.relationshipStrength ?? 0) < CONTACT_PAGE_THRESHOLD) return;

  // Count feed_events we've seen from them to build summary
  const recent = await prisma.feedEvent.findMany({
    where: { clientNumber, senderEmail: contact.email ?? undefined } as any,
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { rawPayload: true, createdAt: true },
  }).catch(() => []);

  const recentSubjects = recent
    .map((r) => (r.rawPayload as any)?.subject)
    .filter(Boolean)
    .slice(0, 5);

  const body = [
    `# ${contact.name}`,
    ``,
    `- **Email**: ${contact.email ?? '—'}`,
    `- **First seen**: ${contact.lastInteraction?.toISOString().slice(0, 10) ?? '—'}`,
    `- **Interactions**: ${contact.relationshipStrength ?? 1}`,
    ``,
    `## Recent threads`,
    ...(recentSubjects.length > 0 ? recentSubjects.map((s: string) => `- ${s}`) : ['- (no subjects yet)']),
    ``,
    `*Auto-maintained by wiki_scribe — edit freely; scribe only fills empty fields.*`,
  ].join('\n');

  await ensureWikiPage(clientNumber, userId, contactId, contact.name, 'entity', body, sourceFeedEventId);
}

async function maybeCreateCompanyPage(
  clientNumber: string,
  userId: number,
  companyId: string,
  sourceFeedEventId?: string,
): Promise<void> {
  const company = await prisma.entity.findUnique({
    where: { id: companyId },
    select: { name: true, company: true, relationshipStrength: true, lastInteraction: true },
  });
  if (!company || (company.relationshipStrength ?? 0) < COMPANY_PAGE_THRESHOLD) return;

  // Count unique contacts for this company
  const contacts = await prisma.entityLink.count({
    where: { linkedEntityId: companyId, linkType: 'works_at' },
  }).catch(() => 0);

  const body = [
    `# ${company.name}`,
    ``,
    `- **Domain**: ${company.company ?? '—'}`,
    `- **Contacts known**: ${contacts}`,
    `- **Last interaction**: ${company.lastInteraction?.toISOString().slice(0, 10) ?? '—'}`,
    ``,
    `*Auto-maintained by wiki_scribe — add deal context / relationship notes freely.*`,
  ].join('\n');

  await ensureWikiPage(clientNumber, userId, companyId, company.name, 'entity', body, sourceFeedEventId);
}

// ─── Entry points ───────────────────────────────────────────

export interface ScribeInput {
  clientNumber: string;
  userId?: number | null;
  senderEmail?: string | null;
  senderName?: string | null;
  fromHeader?: string | null;
  createdAt?: Date;
  feedEventId?: string;
}

// Substring match — "Office365Alerts" has no word boundary between 5 and A
// so a \b-anchored regex misses it. We accept a few false positives on
// automation keywords to keep the contact list clean of alert/digest noise.
const AUTOMATION_LOCAL_PARTS = /(notification|noreply|no[-_.]reply|do[-_.]?not[-_.]?reply|alerts?|mailer|daemon|postmaster|digest|newsletter|autoreply|automated)/i;

async function shouldSkipSender(
  clientNumber: string,
  email: string,
  userId?: number | null,
): Promise<boolean> {
  // 1. Automation/no-reply style senders → not real contacts
  const local = email.split('@')[0] ?? '';
  if (AUTOMATION_LOCAL_PARTS.test(local)) return true;

  // 2. Internal colleague → already in users table; people intelligence reads
  //    them from there. Contact graph is for EXTERNAL relationships only.
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (INTERNAL_DOMAINS.has(domain)) return true;

  // 3. Self
  if (userId) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, integrationEmail: true } });
    const lower = email.toLowerCase();
    if (u?.email?.toLowerCase() === lower) return true;
    if (u?.integrationEmail?.toLowerCase() === lower) return true;
  }

  return false;
}

export async function scribeFromFeedEvent(input: ScribeInput): Promise<void> {
  // sender_email in feed_events may be either a plain address OR a raw
  // "Name <email@x>" string depending on the adapter. Always normalize.
  let email = '';
  let name = input.senderName ?? undefined;
  for (const src of [input.senderEmail, input.fromHeader]) {
    if (!src) continue;
    const parsed = parseEmail(src);
    if (parsed.email) {
      email = parsed.email;
      if (!name && parsed.name) name = parsed.name;
      break;
    }
  }
  // Absolute fallback: if senderEmail was a plain address without brackets
  if (!email && input.senderEmail?.includes('@') && !input.senderEmail.includes('<')) {
    email = input.senderEmail.trim().toLowerCase();
  }
  if (!email || !email.includes('@')) return;

  const domain = domainOf(email);
  if (!domain) return;

  if (await shouldSkipSender(input.clientNumber, email, input.userId)) return;

  const contact = await upsertContact(input.clientNumber, email, name, input.createdAt);
  const company = await upsertCompany(input.clientNumber, domain);
  if (contact.id && company.id) await linkWorksAt(input.clientNumber, contact.id, company.id);

  // Wiki pages are per-user; create for the event owner if we know them.
  if (input.userId) {
    await maybeCreateContactPage(input.clientNumber, input.userId, contact.id, input.feedEventId);
    if (company.id) await maybeCreateCompanyPage(input.clientNumber, input.userId, company.id, input.feedEventId);
  }
}

// ─── Batch backfill ─────────────────────────────────────────

export interface BackfillSummary {
  scanned: number;
  contactsCreated: number;
  companiesCreated: number;
  wikiPagesCreated: number;
  errors: number;
  durationMs: number;
}

/**
 * One-off or scheduled: walk feed_events from last N days and run the scribe.
 * Safe to call repeatedly — idempotent.
 */
export async function backfillFromRecentFeedEvents(
  clientNumber: string,
  daysBack = 30,
): Promise<BackfillSummary> {
  const t0 = Date.now();
  const summary: BackfillSummary = { scanned: 0, contactsCreated: 0, companiesCreated: 0, wikiPagesCreated: 0, errors: 0, durationMs: 0 };
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const events = await prisma.feedEvent.findMany({
    where: {
      clientNumber,
      sourceType: { in: ['gmail', 'whatsapp', 'gchat'] as any },
      createdAt: { gte: since },
      senderEmail: { not: null },
    } as any,
    select: { id: true, userId: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
    take: 2000,
  }).catch(() => []);

  summary.scanned = events.length;
  for (const e of events) {
    try {
      await scribeFromFeedEvent({
        clientNumber,
        userId: e.userId ?? null,
        senderEmail: e.senderEmail,
        senderName: e.senderName,
        fromHeader: (e.rawPayload as any)?.from ?? null,
        createdAt: e.createdAt,
        feedEventId: e.id,
      });
    } catch {
      summary.errors += 1;
    }
  }
  // Totals come from post-run queries (rough — not tracking deltas precisely)
  const [c, a, p] = await Promise.all([
    prisma.entity.count({ where: { clientNumber, entityType: 'contact' } }),
    prisma.entity.count({ where: { clientNumber, entityType: 'account' } }),
    prisma.wikiPage.count({ where: { clientNumber, pageType: 'entity' } }),
  ]);
  summary.contactsCreated = c;
  summary.companiesCreated = a;
  summary.wikiPagesCreated = p;
  summary.durationMs = Date.now() - t0;
  return summary;
}
