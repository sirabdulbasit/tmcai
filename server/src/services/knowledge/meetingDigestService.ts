/**
 * Meeting digest — turn a transcript email into a living memory update.
 *
 * The user's rule: "Plaud is not a source, it's a communicator." The
 * source of truth for any commitment or decision made in a meeting is
 * (a) when the meeting was held, (b) who was in it, (c) the user who
 * attended. Plaud (or any future transcription service) is the channel
 * that *delivered* the transcript — not the source.
 *
 * Pipeline:
 *   1. Detect a transcript email (Plaud sender, or attachments named
 *      transcript.* / summary.*).
 *   2. Read the summary + transcript attachment_doc pages.
 *   3. LLM extraction → StructuredMeetingDigest.
 *   4. Create one `meeting_minutes` wiki page carrying heldAt, attendees,
 *      attendedBy, decisions, executiveSummary, openQuestions, and
 *      BACK-links to the raw transcript + summary pages (so anyone can
 *      audit the raw evidence behind an extracted claim).
 *   5. For every extracted commitment → create an `open_item` with
 *      sourceFeed='meeting' and sourceRef pointing at the meeting_minutes
 *      page (NOT the Plaud email). The open_item's description carries
 *      the "held YYYY-MM-DD HH:mm with <attendees>" line so the lineage
 *      is visible without having to click through.
 *   6. Link meeting → entity_person for each attendee + topic pages for
 *      the themes. Synthesizer debounce fires so entity + topic pages
 *      pick up the meeting as a new source.
 *
 * Keep this idempotent: a digest is keyed by source email ID; running
 * twice won't double-file commitments.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('meeting-digest');

interface ExtractedAttendee {
  /** Speaker 1 / Speaker 2 / a named person if the transcript names them. */
  label: string;
  /** Best-guess real name if clearly identified in the transcript. */
  name?: string;
  /** Best-guess email if cited. */
  email?: string;
}

interface ExtractedCommitment {
  /** "send the updated proposal to legal" */
  text: string;
  /** Which attendee made the commitment (label like "Speaker 2" OR a real name). */
  ownerLabel: string;
  /** ISO datetime if transcript names one, else null. */
  dueAt: string | null;
  /** 0..1 — how confident the extractor is that this is really a commitment. */
  confidence: number;
}

interface StructuredMeetingDigest {
  /** Short meeting title the LLM infers — "Pension system status review", not the Plaud subject line. */
  title: string;
  /** ISO datetime the meeting was held. Falls back to email received-time. */
  heldAt: string;
  /** Approximate duration in minutes, from transcript timestamps. */
  durationMinutes: number | null;
  attendees: ExtractedAttendee[];
  executiveSummary: string;
  decisions: string[];
  openQuestions: string[];
  commitments: ExtractedCommitment[];
  /** Short topic labels the meeting covered — used to link to topic pages. */
  topics: string[];
}

const EXTRACTOR_PROMPT = `You are reading a meeting transcript + (optional) Plaud-generated summary for an executive assistant. Produce ONE JSON object describing the meeting, nothing else.

Shape:
{
  "title":            "5-10 word meeting name inferred from content, NOT from the email subject",
  "heldAt":           "ISO8601 datetime when the meeting actually took place (use the emailDate only if the transcript doesn't say)",
  "durationMinutes":  number | null,
  "attendees":        [{ "label": "Speaker 1 | Abdul Haseeb | ...", "name": "optional real name if clearly said in transcript", "email": "optional if cited" }],
  "executiveSummary": "3 sentence summary, plain language, no hedging",
  "decisions":        ["<one concrete decision per line>"],
  "openQuestions":    ["<a question raised but not resolved>"],
  "commitments":      [{ "text": "short imperative: 'compile the report', 'call the vendor', etc.", "ownerLabel": "Speaker 2 | Abdul | ...", "dueAt": "ISO or null", "confidence": 0..1 }],
  "topics":           ["1-3 word theme labels: 'pension system', 'vendor selection', ..."]
}

Rules:
- Commitments are things SOMEONE SAID they will DO. "We should" is not a commitment unless someone clearly owns it. If the owner is unclear, put "Unassigned" as ownerLabel and confidence <= 0.5.
- Decisions are things the group AGREED to (not proposals).
- Keep every field present; use [] for empty arrays.
- Never invent attendees who aren't named in the transcript.
- Never invent due dates. If the transcript says "by evening" without a date, leave dueAt null.
- Output ONLY the JSON object.`;

interface DigestInput {
  emailMessagePageId: string;
  summaryBody: string | null;
  transcriptBody: string | null;
  emailDate: string;
}

async function extractDigest(
  input: DigestInput,
  userId: number,
  clientNumber: string,
): Promise<StructuredMeetingDigest | null> {
  const userMsg = [
    `emailDate: ${input.emailDate}`,
    '',
    '---- SUMMARY (may be absent) ----',
    input.summaryBody?.slice(0, 6000) ?? '(none)',
    '',
    '---- TRANSCRIPT ----',
    input.transcriptBody?.slice(0, 18000) ?? '(none)',
  ].join('\n');

  try {
    const r = await callLLM(EXTRACTOR_PROMPT, userMsg, {
      maxTokens: 2000,
      providers: ['gemini', 'gemini-flash', 'claude'],
      userId, clientNumber, purpose: 'meeting_digest',
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as StructuredMeetingDigest;
    // Hardening: ensure required arrays exist
    obj.attendees     = Array.isArray(obj.attendees)     ? obj.attendees     : [];
    obj.decisions     = Array.isArray(obj.decisions)     ? obj.decisions     : [];
    obj.openQuestions = Array.isArray(obj.openQuestions) ? obj.openQuestions : [];
    obj.commitments   = Array.isArray(obj.commitments)   ? obj.commitments   : [];
    obj.topics        = Array.isArray(obj.topics)        ? obj.topics        : [];
    if (!obj.heldAt || Number.isNaN(Date.parse(obj.heldAt))) obj.heldAt = input.emailDate;
    if (!obj.title) obj.title = 'Meeting';
    return obj;
  } catch (err: any) {
    log.warn('extractDigest failed', { emailMessagePageId: input.emailMessagePageId, error: err.message });
    return null;
  }
}

function formatSourceLine(d: StructuredMeetingDigest): string {
  const when = d.heldAt
    ? new Date(d.heldAt).toISOString().slice(0, 16).replace('T', ' ')
    : 'unknown time';
  const who = (d.attendees ?? [])
    .slice(0, 6)
    .map((a) => a.name || a.label)
    .filter(Boolean)
    .join(', ');
  return `Source: meeting held ${when} UTC with ${who || 'unnamed attendees'}`;
}

function renderMeetingMinutesBody(d: StructuredMeetingDigest, sources: { transcriptPageId: string | null; summaryPageId: string | null; emailPageId: string }): string {
  const who = d.attendees.map((a) => `- ${a.label}${a.name ? ` → ${a.name}` : ''}${a.email ? ` <${a.email}>` : ''}`).join('\n') || '- (none detected)';
  const dec = d.decisions.length > 0 ? d.decisions.map((x) => `- ${x}`).join('\n') : '- (none)';
  const qs  = d.openQuestions.length > 0 ? d.openQuestions.map((x) => `- ${x}`).join('\n') : '- (none)';
  const com = d.commitments.length > 0
    ? d.commitments.map((c) => `- **${c.ownerLabel}** — ${c.text}${c.dueAt ? ` (due ${c.dueAt})` : ''} · conf ${c.confidence.toFixed(2)}`).join('\n')
    : '- (none extracted)';
  const tpc = d.topics.length > 0 ? d.topics.map((t) => `- ${t}`).join('\n') : '- (none)';

  return [
    `# ${d.title}`,
    '',
    `**Held:** ${d.heldAt}${d.durationMinutes ? ` · ${d.durationMinutes} min` : ''}`,
    '',
    '## Executive summary',
    d.executiveSummary || '(no summary extracted)',
    '',
    '## Attendees',
    who,
    '',
    '## Decisions',
    dec,
    '',
    '## Open questions',
    qs,
    '',
    '## Commitments (filed as open items)',
    com,
    '',
    '## Topics',
    tpc,
    '',
    '## Evidence (raw)',
    sources.summaryPageId    ? `- summary page: ${sources.summaryPageId}` : '',
    sources.transcriptPageId ? `- transcript page: ${sources.transcriptPageId}` : '',
    `- delivery channel (email): ${sources.emailPageId}`,
  ].filter(Boolean).join('\n');
}

export interface DigestResult {
  meetingMinutesPageId: string;
  openItemIds: string[];
  commitmentsFiled: number;
  decisionsFiled: number;
}

/**
 * Idempotently digest a single meeting transcript email into a
 * meeting_minutes wiki page + commitments as open_items.
 *
 * Returns null if the email isn't a transcript-looking message, the
 * transcript can't be loaded, or the LLM extraction fails.
 */
export async function digestMeetingFromEmail(emailMessagePageId: string): Promise<DigestResult | null> {
  // 1. Load the email page
  const emailPage = await prisma.wikiPage.findUnique({
    where: { id: emailMessagePageId },
    select: { id: true, title: true, clientNumber: true, userId: true, metadata: true, bodyMarkdown: true },
  });
  if (!emailPage || emailPage.userId === null) return null;

  const meta: any = emailPage.metadata ?? {};
  const emailDate = meta.date ?? new Date().toISOString();
  const { clientNumber } = emailPage;
  const userId = emailPage.userId;

  // 2. Idempotency — if we already have a meeting_minutes page keyed on this email, skip.
  const prior = await prisma.wikiPage.findFirst({
    where: {
      clientNumber, userId, pageType: 'meeting_minutes',
      metadata: { path: ['sourceEmailPageId'], equals: emailMessagePageId } as any,
    },
    select: { id: true },
  }).catch(() => null);
  if (prior) {
    log.info('meeting already digested', { emailMessagePageId, meetingMinutesPageId: prior.id });
    return {
      meetingMinutesPageId: prior.id, openItemIds: [], commitmentsFiled: 0, decisionsFiled: 0,
    };
  }

  // 3. Find attached transcript + summary pages (same feedEventId)
  const feedEventId = meta.feedEventId;
  let attachments: any[] = [];
  if (feedEventId) {
    attachments = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, body_markdown AS "bodyMarkdown", metadata
         FROM wiki_pages
        WHERE client_number = $1 AND user_id = $2
          AND page_type = 'attachment_doc'
          AND metadata->>'feedEventId' = $3`,
      clientNumber, userId, feedEventId,
    ).catch(() => []);
  }
  const transcriptPage = attachments.find((a: any) => /transcript/i.test(a.title));
  const summaryPage    = attachments.find((a: any) => /summary/i.test(a.title));

  // Cheap short-circuit: if there's nothing transcript-shaped, skip.
  if (!transcriptPage && !summaryPage) {
    log.info('no transcript/summary attachment found', { emailMessagePageId });
    return null;
  }

  // 4. LLM extraction
  const digest = await extractDigest({
    emailMessagePageId,
    summaryBody: summaryPage?.bodyMarkdown ?? null,
    transcriptBody: transcriptPage?.bodyMarkdown ?? null,
    emailDate,
  }, userId, clientNumber);
  if (!digest) return null;

  // 5. Create meeting_minutes wiki page
  const body = renderMeetingMinutesBody(digest, {
    transcriptPageId: transcriptPage?.id ?? null,
    summaryPageId:    summaryPage?.id ?? null,
    emailPageId:      emailPage.id,
  });

  const mmMetadata: any = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope: 'user',
    authoredBy: 'meeting_digest',
    heldAt: digest.heldAt,
    durationMinutes: digest.durationMinutes,
    attendedBy: userId,
    attendees: digest.attendees,
    topics: digest.topics,
    executiveSummary: digest.executiveSummary,
    decisionCount: digest.decisions.length,
    commitmentCount: digest.commitments.length,
    sourceEmailPageId: emailMessagePageId,
    sourceTranscriptPageId: transcriptPage?.id ?? null,
    sourceSummaryPageId: summaryPage?.id ?? null,
  };

  let meetingTitle = digest.title.slice(0, 300);
  // title uniqueness — if collision, append held-at to disambiguate
  const titleCollision = await prisma.wikiPage.findFirst({
    where: { clientNumber, userId, pageType: 'meeting_minutes', title: meetingTitle },
    select: { id: true },
  }).catch(() => null);
  if (titleCollision) {
    meetingTitle = `${meetingTitle} · ${digest.heldAt.slice(0, 16).replace('T', ' ')}`.slice(0, 300);
  }

  const mm = await prisma.wikiPage.create({
    data: {
      clientNumber, userId,
      pageType: 'meeting_minutes',
      title: meetingTitle,
      bodyMarkdown: body,
      metadata: mmMetadata as any,
      storage: 'postgres', status: 'active',
      sourceCount: 1 + (transcriptPage ? 1 : 0) + (summaryPage ? 1 : 0),
      lastUpdatedBy: 'meeting_digest',
    },
  });

  // 6. Back-link meeting_minutes → raw transcript, summary, delivery email
  const linkTargets: Array<{ to: string; kind: string }> = [];
  if (transcriptPage?.id) linkTargets.push({ to: transcriptPage.id, kind: 'derived_from' });
  if (summaryPage?.id)    linkTargets.push({ to: summaryPage.id,    kind: 'derived_from' });
  linkTargets.push({ to: emailPage.id, kind: 'delivered_by' });
  for (const t of linkTargets) {
    await prisma.wikiPageLink.upsert({
      where: { fromPageId_toPageId_linkType: { fromPageId: mm.id, toPageId: t.to, linkType: t.kind } } as any,
      update: {},
      create: { clientNumber, userId, fromPageId: mm.id, toPageId: t.to, linkType: t.kind },
    }).catch(() => {});
  }

  // 7. Create open_items for commitments, with the meeting as source
  const sourceLine = formatSourceLine(digest);
  const openItemIds: string[] = [];
  for (const c of digest.commitments) {
    if (!c.text || c.confidence < 0.35) continue;  // skip junk / low-confidence

    // Try to resolve owner to a real email/entity. Best-effort — if the
    // ownerLabel is a named person we can match by attendee.name/email.
    const ownerAttendee = digest.attendees.find((a) =>
      a.label.toLowerCase() === c.ownerLabel.toLowerCase()
      || (a.name && a.name.toLowerCase() === c.ownerLabel.toLowerCase()),
    );

    const isInternal = !!(ownerAttendee?.email && ownerAttendee.email.toLowerCase().endsWith(`@${(meta.to ?? '').split('@')[1] ?? ''}`));
    const description = [
      sourceLine,
      ownerAttendee?.name
        ? `Committed by: ${ownerAttendee.name}${ownerAttendee.email ? ` <${ownerAttendee.email}>` : ''}`
        : `Committed by: ${c.ownerLabel}`,
      c.dueAt ? `Stated due: ${c.dueAt}` : '',
      '',
      `Extracted from meeting transcript (confidence ${c.confidence.toFixed(2)}).`,
    ].filter(Boolean).join('\n');

    try {
      const created = await prisma.openItem.create({
        data: {
          clientNumber, userId,
          title: c.text.slice(0, 480),
          description,
          type: 'task',
          status: 'NEW',
          priority: c.confidence >= 0.8 ? 'high' : 'medium',
          ownerId: userId,  // MD owns it for tracking; delegateeName carries real owner
          delegateeName: (!isInternal && ownerAttendee?.name) ? ownerAttendee.name : (ownerAttendee?.label !== c.ownerLabel ? c.ownerLabel : null),
          delegateeEmail: ownerAttendee?.email ?? null,
          dueDate: c.dueAt ? new Date(c.dueAt) : null,
          sourceFeed: 'meeting',
          sourceRef: mm.id,   // ← meeting_minutes page, NOT the Plaud email
          archetype: 'reply_needed',
          metadata: {
            source: {
              kind: 'meeting',
              meetingMinutesId: mm.id,
              heldAt: digest.heldAt,
              attendees: digest.attendees.slice(0, 10),
              attendedBy: userId,
              deliveredByEmailPageId: emailMessagePageId,  // audit trail only
              extractionConfidence: c.confidence,
            },
          } as any,
        },
      });
      openItemIds.push(created.id);
    } catch (err: any) {
      log.warn('open_item create failed', { commitment: c.text, error: err.message });
    }
  }

  // 8. Fire embedding for the meeting_minutes page so it's retrievable
  void (async () => {
    try {
      const { embedWikiPage } = await import('./wikiEmbeddingService');
      await embedWikiPage(mm.id);
    } catch { /* best effort */ }
  })();

  log.info('meeting digested', {
    emailMessagePageId, meetingMinutesPageId: mm.id,
    attendees: digest.attendees.length, decisions: digest.decisions.length, commitments: openItemIds.length,
  });

  return {
    meetingMinutesPageId: mm.id,
    openItemIds,
    commitmentsFiled: openItemIds.length,
    decisionsFiled: digest.decisions.length,
  };
}

/**
 * Detector that triggers digestion. Kept deliberately narrow:
 *   - email has a `transcript.*` attachment (strongest signal), OR
 *   - sender email is on the Plaud-style auto-transcription domains.
 * Extend later for Otter, Fathom, Fireflies, native Google Meet recordings.
 */
export function looksLikeTranscriptEmail(meta: any): boolean {
  const from = String(meta?.from ?? meta?.senderEmail ?? '').toLowerCase();
  if (from.includes('plaud.ai')) return true;
  if (from.includes('otter.ai')) return true;
  if (from.includes('fathom.video') || from.includes('fireflies.ai')) return true;
  return false;
}
