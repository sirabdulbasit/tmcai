/**
 * replyContextBuilder — for "reply to X about Y" / "ask Numair the
 * same as Debby" style multi-source action requests.
 *
 * 2026-05-22. The empty-promise guard correctly catches Brain
 * claiming it sent a reply without actually emitting send_email,
 * but Brain SHOULD actually succeed at this — by finding the
 * referenced email + the question source + emitting a proper
 * reply action.
 *
 * This builder runs BEFORE the main composer call on action turns
 * that match a reply / forward / "ask same as X" intent. It
 * augments the composer's prompt with:
 *
 *   1. **Target thread** — the email Brain is being asked to reply
 *      to (sender + subject + body). The composer / action-decider
 *      uses the feedEvent.id as replyToFeedEventId so Gmail
 *      threading stays correct.
 *
 *   2. **Body source** — when the user says "ask same as X did" /
 *      "what X is asking", the recent messages from X (across
 *      email + WhatsApp) so the LLM can quote X's actual question
 *      instead of paraphrasing.
 *
 * Both are best-effort. When no clear match exists, returns null so
 * the composer falls back to its normal flow (and the diagnostic
 * empty-promise message guides the user to clarify).
 */
import prisma from '../../db/prisma';

export interface ReplyContext {
  targetThread: TargetThread | null;
  bodySource: BodySource | null;
  rawDebug: string; // for prompt injection — describes what we found
}

export interface TargetThread {
  feedEventId: string;
  senderName: string | null;
  senderEmail: string | null;
  subject: string;
  bodyExcerpt: string;
  threadParticipants: string[]; // for reply-all
  receivedAt: Date;
}

export interface BodySource {
  sourcePersonName: string;
  channel: 'email' | 'whatsapp';
  messageExcerpt: string;
  receivedAt: Date;
}

/** Look for a "reply to X's email about Y" intent in the user's
 *  message. Returns the extracted sender hint + topic hint when
 *  found, null otherwise. */
function detectReplyIntent(question: string): { senderHint: string | null; topicHint: string | null } | null {
  const q = question.trim().toLowerCase();
  // Patterns we want to match:
  //  "reply to <name>'s email about <topic>"
  //  "respond to <name> on <topic>"
  //  "reply all on <name>'s <topic> thread"
  //  "<topic> by replying to all"
  //  "reply to that thread from <name>"
  //  "ask <name> on <his/the> email of <topic>"
  if (!/\b(reply|respond|reply\s*all|reply\s+all|replying\s+to)\b/i.test(q) &&
      !/\bemail\s+of\s+\w/i.test(q) &&
      !/\bhis\s+email\b|her\s+email\b|their\s+email\b/i.test(q)) {
    return null;
  }

  let senderHint: string | null = null;
  let topicHint: string | null = null;

  // Try a few common shapes — best-effort regex on natural language.
  const patterns = [
    /\b(?:reply|respond)(?:ing)?\s+(?:to\s+)?(?:all\s+(?:to\s+)?|all\s+on\s+)?([a-z'][a-z'\s]{2,30}?)(?:'s)?\s+(?:email|thread|message)\s+(?:about|on|of)\s+([a-z][a-z\s]{2,40})/i,
    /\bask\s+([A-Z][a-z]{2,15}(?:\s+[A-Z][a-z]{2,15})?)\s+(?:on\s+)?(?:his|her|their|the)\s+(?:email|thread)\s+(?:of|about|on)\s+([a-z][a-z\s]{2,40})/i,
    /\b(?:from|on)\s+([A-Z][a-z]{2,15}(?:\s+[A-Z][a-z]{2,15})?)\s+(?:about|on|regarding)\s+([a-z][a-z\s]{2,40})/i,
  ];
  for (const p of patterns) {
    const m = question.match(p);
    if (m) {
      if (m[1]) senderHint = m[1].trim().replace(/\s+/g, ' ');
      if (m[2]) topicHint = m[2].trim().replace(/\s+/g, ' ').replace(/\s+by\s+replying.*$/i, '');
      break;
    }
  }
  // Fallback: a capitalized name token + a non-capitalized topic word run.
  if (!senderHint) {
    const nameMatch = question.match(/\b([A-Z][a-z]{2,15}(?:\s+[A-Z][a-z]{2,15})?)\b/);
    if (nameMatch) senderHint = nameMatch[1];
  }
  if (!topicHint) {
    // Pull a meaningful noun phrase after "about|on|of|regarding".
    const topicMatch = question.match(/\b(?:about|on|of|regarding)\s+([a-z][a-z\s]{2,30})\b/i);
    if (topicMatch) topicHint = topicMatch[1].trim();
  }
  if (!senderHint && !topicHint) return null;
  return { senderHint, topicHint };
}

/** Look for a "same as X is asking" / "X's question" / "what X said"
 *  pattern. Returns the cited person's name when found. */
function detectBodySourceIntent(question: string): { sourcePersonHint: string } | null {
  const m = question.match(/\b(?:same|like)\s+(?:as|what)\s+([A-Z][a-z]{2,15})\b/i)
    ?? question.match(/\bwhat\s+([A-Z][a-z]{2,15})\s+(?:is\s+asking|asked|said|wants)/i)
    ?? question.match(/\b([A-Z][a-z]{2,15})['']?s\s+question\b/i);
  if (!m?.[1]) return null;
  return { sourcePersonHint: m[1] };
}

/** Find a recent email matching senderHint + topicHint. Returns
 *  the best single match or null. */
async function findTargetThread(
  userId: number,
  clientNumber: string,
  senderHint: string | null,
  topicHint: string | null,
): Promise<TargetThread | null> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days
  const where: any = {
    clientNumber, userId,
    sourceType: 'gmail',
    createdAt: { gte: since },
  };
  // Sender filter — match against sender_name OR sender_email.
  if (senderHint) {
    const s = senderHint.toLowerCase();
    where.OR = [
      { senderName: { contains: s, mode: 'insensitive' } },
      { senderEmail: { contains: s, mode: 'insensitive' } },
    ];
  }
  const rows = await prisma.feedEvent.findMany({
    where,
    select: {
      id: true, senderEmail: true, senderName: true,
      rawPayload: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
  }).catch(() => [] as any[]);

  if (rows.length === 0) return null;

  // If topicHint present, filter by subject / body contains.
  let matches = rows;
  if (topicHint) {
    const topicLc = topicHint.toLowerCase();
    matches = rows.filter((r) => {
      const p: any = r.rawPayload ?? {};
      const subject = String(p.subject ?? '').toLowerCase();
      const body = String(p.body ?? p.snippet ?? '').toLowerCase();
      return subject.includes(topicLc) || body.includes(topicLc);
    });
    if (matches.length === 0) matches = rows.slice(0, 1); // fall back to most recent from sender
  }

  const top = matches[0];
  const p: any = top.rawPayload ?? {};
  const participants: string[] = [];
  if (top.senderEmail) participants.push(top.senderEmail);
  if (Array.isArray(p.cc)) participants.push(...p.cc.filter((c: any) => typeof c === 'string'));
  if (Array.isArray(p.to)) participants.push(...p.to.filter((c: any) => typeof c === 'string'));

  return {
    feedEventId: top.id,
    senderName: top.senderName,
    senderEmail: top.senderEmail,
    subject: String(p.subject ?? '(no subject)').slice(0, 200),
    bodyExcerpt: String(p.body ?? p.snippet ?? '').slice(0, 800),
    threadParticipants: Array.from(new Set(participants)).slice(0, 6),
    receivedAt: top.createdAt,
  };
}

/** Find recent messages from the named person across email +
 *  WhatsApp. Returns the most recent / most relevant. */
async function findBodySource(
  userId: number,
  clientNumber: string,
  sourcePersonHint: string,
  topicHint: string | null,
): Promise<BodySource | null> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days
  const personLc = sourcePersonHint.toLowerCase();
  const rows = await prisma.feedEvent.findMany({
    where: {
      clientNumber, userId,
      createdAt: { gte: since },
      sourceType: { in: ['gmail', 'whatsapp'] as any },
      OR: [
        { senderName: { contains: personLc, mode: 'insensitive' } },
        { senderEmail: { contains: personLc, mode: 'insensitive' } },
      ],
    },
    select: { id: true, sourceType: true, senderName: true, rawPayload: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 15,
  }).catch(() => [] as any[]);
  if (rows.length === 0) return null;
  // If topic specified, prefer messages mentioning it.
  let best = rows[0];
  if (topicHint) {
    const topicLc = topicHint.toLowerCase();
    const matching = rows.find((r) => {
      const p: any = r.rawPayload ?? {};
      const text = String(p.subject ?? '') + ' ' + String(p.body ?? p.snippet ?? p.text ?? '');
      return text.toLowerCase().includes(topicLc);
    });
    if (matching) best = matching;
  }
  const p: any = best.rawPayload ?? {};
  return {
    sourcePersonName: best.senderName ?? sourcePersonHint,
    channel: best.sourceType === 'whatsapp' ? 'whatsapp' : 'email',
    messageExcerpt: String(p.body ?? p.snippet ?? p.text ?? '').slice(0, 600),
    receivedAt: best.createdAt,
  };
}

/** Top-level entry: detect intent and fetch context. Called by the
 *  composer on action turns. Returns null when no relevant intent. */
export async function buildReplyContext(args: {
  userId: number;
  clientNumber: string;
  question: string;
}): Promise<ReplyContext | null> {
  const replyIntent = detectReplyIntent(args.question);
  const bodySourceIntent = detectBodySourceIntent(args.question);
  if (!replyIntent && !bodySourceIntent) return null;

  const [targetThread, bodySource] = await Promise.all([
    replyIntent
      ? findTargetThread(args.userId, args.clientNumber, replyIntent.senderHint, replyIntent.topicHint)
      : Promise.resolve(null),
    bodySourceIntent
      ? findBodySource(args.userId, args.clientNumber, bodySourceIntent.sourcePersonHint, replyIntent?.topicHint ?? null)
      : Promise.resolve(null),
  ]);
  if (!targetThread && !bodySource) return null;

  const debugLines: string[] = [];
  if (targetThread) {
    debugLines.push(`Found target thread: from ${targetThread.senderName ?? targetThread.senderEmail}, subject "${targetThread.subject}", feedEventId=${targetThread.feedEventId}`);
  }
  if (bodySource) {
    debugLines.push(`Found body source: ${bodySource.sourcePersonName} via ${bodySource.channel}, ${bodySource.receivedAt.toISOString().slice(0, 10)}`);
  }
  return {
    targetThread,
    bodySource,
    rawDebug: debugLines.join(' | '),
  };
}

/** Render the reply context as a prompt block for the composer.
 *  Empty string when no context. */
export function renderReplyContextBlock(ctx: ReplyContext | null): string {
  if (!ctx || (!ctx.targetThread && !ctx.bodySource)) return '';
  const out: string[] = ['# Email reply context (you were asked to reply to a specific thread; use this to compose)'];
  if (ctx.targetThread) {
    out.push('');
    out.push('## Target thread — reply to THIS:');
    out.push(`- feedEventId: ${ctx.targetThread.feedEventId}  ← use this as send_email.replyToFeedEventId`);
    out.push(`- From: ${ctx.targetThread.senderName ?? '(unknown)'} <${ctx.targetThread.senderEmail ?? '(no email)'}>`);
    out.push(`- Subject: ${ctx.targetThread.subject}  ← use "Re: ${ctx.targetThread.subject}" as send_email.subject`);
    out.push(`- Received: ${ctx.targetThread.receivedAt.toISOString()}`);
    if (ctx.targetThread.threadParticipants.length > 0) {
      out.push(`- Thread participants (for reply-all): ${ctx.targetThread.threadParticipants.join(', ')}`);
    }
    out.push(`- Original body (excerpt):`);
    out.push(ctx.targetThread.bodyExcerpt.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (ctx.bodySource) {
    out.push('');
    out.push('## Body source — quote/paraphrase THIS person\'s question in your reply:');
    out.push(`- ${ctx.bodySource.sourcePersonName} via ${ctx.bodySource.channel} on ${ctx.bodySource.receivedAt.toISOString().slice(0, 10)}:`);
    out.push(ctx.bodySource.messageExcerpt.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  out.push('');
  out.push(`When you emit send_email, set replyToFeedEventId to the feedEventId above. For reply-all, include all thread participants in 'to' / 'cc'. The body should incorporate the question/content from the body source above when one is provided.`);
  return out.join('\n');
}
