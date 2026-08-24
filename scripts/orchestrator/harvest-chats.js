#!/usr/bin/env node
/**
 * harvest-chats.js — read the owner's real conversations with Brain, straight from the
 * database, so the loop analyses what he actually experienced rather than a file
 * somebody remembered to update.
 *
 * Owner, 2026-08-18: "i don't want to paste the conversation, i want you to read it by
 * yourself and analyze it and fix it — this is the capability of Self Healing." And:
 * "you should analyze deeply the conversation that can give you the exact picture where
 * brain stands, because i am also analyzing brain through that conversation."
 *
 * WHY THIS EXISTS. brain_chat_archive.md — the only chat evidence any agent reads —
 * stopped at Chat 17 on 2026-08-04. Thirteen days later the database held 424 WhatsApp
 * messages the loop had never seen. Every ranking, every target, every "capability gap"
 * was computed from two-week-old conversations while the owner hit new problems daily.
 * The pipeline was real and its input was stale, which is worse than no pipeline,
 * because it looks like it is working.
 *
 * WHAT IT DOES NOT DO: it does not judge. It renders turns as readable transcript and
 * writes them to a file the Chat Analysis stage reads. Deciding what went wrong is
 * Codex's job, and a harvester that pre-filtered "interesting" turns would be deciding
 * that with a regex — `detector-is-a-list-of-sentences` has three recorded occurrences
 * in this project already.
 *
 * PII. This writes real message bodies to disk, which the aggregate evidence pack
 * deliberately does not. That is the owner's own conversation on the owner's own box and
 * it is the only thing that can answer "what did Brain actually say" — but the file is
 * local, git-ignored, and never leaves the machine.
 *
 * Usage: node -r dotenv/config harvest-chats.js [--days 14] [--out <path>]
 */
// Resolved from server/, not from here. Node resolves modules relative to the SCRIPT,
// and this script lives in scripts/orchestrator/ while @prisma/client is installed under
// server/node_modules — so a bare require fails no matter which directory you run from.
const { PrismaClient } = require('/var/www/tmcai/server/node_modules/@prisma/client');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const DAYS = parseInt(argOf('--days', '14'), 10);
// DELTA HARVEST. Owner, 2026-08-18: "only when new conversation has arrived, it will not
// run on old conversation, so you need keep delta conversation record."
//
// --since <epoch-ms> emits ONLY turns after that instant. The 10-minute watcher passes
// its watermark, so a single new message produces a transcript of that message rather
// than a fortnight the analyst has already read — which is both cheaper and sharper,
// because "what is new" stops being something the model has to work out for itself.
// Omitted (the nightly run) it falls back to the --days window.
const SINCE_MS = parseInt(argOf('--since', '0'), 10);
const OUT = argOf('--out', '/var/www/tmcai/server/docs/orchestrator/state/recent-chats.md');

// A gap longer than this starts a new "session" in the transcript. Conversation rows are
// long-lived (one row held all 424 messages), so grouping by row would render a
// fortnight as a single wall of text with no sense of where one exchange ended.
const SESSION_GAP_MIN = 45;

(async () => {
  const prisma = new PrismaClient();
  // ALWAYS THE FULL WINDOW in the file. --since now marks where the NEW turns begin
  // rather than truncating the transcript to them.
  //
  // Delta-only harvesting broke the owner's deck: the panel counts failures from this file,
  // so a 5-turn delta made it read "5 turns from 5:17pm" above counts of 17 occurrences
  // carried from a frozen archive. Two datasets under one label, which he correctly called
  // meaningless. The analyst still reads incrementally — it is told the boundary — but the
  // file it reads holds the whole picture, so anything counting from it is coherent.
  const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  const NEW_FROM = SINCE_MS > 0 ? new Date(SINCE_MS) : null;
  const mode = `last ${DAYS} days`;
  // EVERY TENANT, EVERY USER. Owner, 2026-08-18: "since it is multitenant and multiuser
  // you should read conversation of each user and collectively analyze the gap of
  // brain's capability."
  //
  // No tenant filter anywhere in this query. Today one tenant is active (TMC-0001, one
  // user), so a filter would have looked correct and silently gone blind the moment a
  // second tenant started talking — and this codebase already carries four recorded
  // `query-without-tenant-scope` defects, which is the same mistake in the opposite
  // direction: assuming one tenant is all of them.
  const rows = await prisma.message.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true, source: true, createdAt: true,
              clientNumber: true, conversationId: true,
              outputTokens: true, responseTimeMs: true },
  });

  // conversationId -> userId, so a transcript can say WHOSE exchange it is. Users are
  // identified by tenant + numeric id, never by name or number: the analyst needs to
  // tell two users apart, not to know who they are.
  const convIds = [...new Set(rows.map((r) => r.conversationId))];
  const convs = await prisma.conversation.findMany({
    where: { id: { in: convIds } },
    select: { id: true, userId: true, clientNumber: true },
  });
  const whose = new Map(convs.map((c) => [c.id, `${c.clientNumber}/u${c.userId}`]));

  const out = [];
  out.push(`# Recent conversations with Brain — harvested ${new Date().toISOString()}`);
  out.push('');
  // The spread comes first, because "Brain is failing" and "Brain is failing for one
  // user" need different fixes and the transcript alone cannot tell them apart.
  const perParty = {};
  for (const r of rows) {
    const k = whose.get(r.conversationId) || `${r.clientNumber}/u?`;
    perParty[k] = (perParty[k] || 0) + 1;
  }
  out.push(`Straight from the \`messages\` table: ${rows.length} turns · ${mode}.`);
  if (NEW_FROM) {
    const fresh = rows.filter((r) => r.createdAt > NEW_FROM).length;
    out.push('');
    out.push(`**NEW SINCE THE LAST ANALYSIS: ${fresh} turn(s) after ${NEW_FROM.toISOString()}.**`);
    out.push('Everything before that line was already analysed — read it for context and');
    out.push('recurrence, but the new turns are what you are being asked about.');
  }
  out.push('');
  out.push(`**Parties: ${Object.keys(perParty).length}** (tenant/user → turns) — `
    + Object.entries(perParty).map(([k, v]) => `${k}: ${v}`).join(' · '));
  out.push('');
  out.push('A defect that appears for EVERY party is a Brain capability gap. One that');
  out.push('appears for a single party may be that party\'s data or configuration, and');
  out.push('saying which is part of the analysis — do not merge them silently.');
  out.push('This is the OWNER TALKING TO BRAIN IN PRODUCTION — not a curated archive, not');
  out.push('a test fixture. Where Brain answered badly, the bad answer is here verbatim.');
  out.push('');
  out.push('Roles: **owner** is him, **brain** is what he received.');
  out.push('');

  let lastAt = null;
  let session = 0;
  for (const r of rows) {
    const gapMin = lastAt ? (r.createdAt - lastAt) / 60000 : Infinity;
    if (gapMin > SESSION_GAP_MIN) {
      session += 1;
      out.push('');
      out.push(`## Session ${session} — ${r.createdAt.toISOString().replace('T', ' ').slice(0, 16)} UTC · ${whose.get(r.conversationId) || r.clientNumber}`);
      out.push('');
    }
    lastAt = r.createdAt;
    const party = whose.get(r.conversationId) || `${r.clientNumber}/u?`;
    const who = r.role === 'user' ? `user ${party}` : 'brain';
    // Response time and output size are kept on Brain's turns: a 40-second reply or a
    // one-word answer to a compound question is itself evidence, and it is lost the
    // moment this is read as prose alone.
    const meta = who === 'brain'
      ? ` _(${r.responseTimeMs != null ? `${(r.responseTimeMs / 1000).toFixed(1)}s` : 'no timing'}${r.outputTokens != null ? `, ${r.outputTokens} out` : ''})_`
      : '';
    const body = String(r.content ?? '').trim().replace(/\r/g, '');
    out.push(`- **${who}** ${r.createdAt.toISOString().slice(11, 16)}${meta}: ${body}`);
  }

  // ── THE COMM SURFACE ────────────────────────────────────────────────────────────────
  // Owner, 2026-08-24: *"pulse healing should analyze the comm"* — Comm being WhatsApp,
  // email, chat (Gmail/Teams) and anything arriving through a connector, not WhatsApp alone.
  //
  // Everything above this line comes from `messages`: conversations WITH Brain, which is where
  // Brain's own bad answers live. That is 1,660 turns. Meanwhile `feed_events` holds ~4,800
  // items Brain RECEIVED across five channels and the analyst had never been shown one of them.
  //
  // These two are NOT the same evidence and the section is kept separate on purpose. A bad
  // answer in a conversation is Brain reasoning wrongly. An item sitting at status='new'
  // forever is Brain never acting at all — a different defect class, invisible in any
  // transcript, and the reason this section exists.
  //
  // No tenant filter, for the same reason as the query above: one active tenant today would
  // make a filter look correct and go blind the moment a second one starts talking.
  const feed = await prisma.feedEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: {
      sourceType: true, status: true, eventType: true, createdAt: true,
      clientNumber: true, senderEmail: true, senderName: true, rawPayload: true,
    },
  });

  // Lifetime totals as well as the window: "294 emails this fortnight, none processed" is a
  // weaker statement than "2,600 lifetime, none processed", and the analyst needs both to tell
  // a new outage from a capability that has never once run.
  const lifetime = await prisma.feedEvent.groupBy({
    by: ['sourceType', 'status'],
    _count: { _all: true },
  }).catch(() => []);

  out.push('');
  out.push('---');
  out.push('');
  out.push('# The Comm surface — what Brain RECEIVED, and whether it acted');
  out.push('');
  out.push('Everything above is `messages`: conversations WITH Brain. This section is');
  out.push('`feed_events`: items that ARRIVED across every channel — email, WhatsApp, Google');
  out.push('Chat, calendar, tasks. A bad answer above is Brain reasoning wrongly. An item stuck');
  out.push('at `new` here is Brain never acting at all, which no transcript can show you.');
  out.push('');

  const lifeBy = {};
  for (const g of lifetime) {
    const k = g.sourceType || '?';
    lifeBy[k] = lifeBy[k] || {};
    lifeBy[k][g.status || '?'] = g._count._all;
  }
  if (Object.keys(lifeBy).length) {
    out.push('| channel | lifetime received | still `new` | processed | never acted on |');
    out.push('|---|---|---|---|---|');
    for (const [ch, st] of Object.entries(lifeBy).sort((a, b) => {
      const t = (x) => Object.values(x[1]).reduce((m, n) => m + n, 0);
      return t(b) - t(a);
    })) {
      const total = Object.values(st).reduce((a, b) => a + b, 0);
      const fresh = st.new || 0;
      const done = st.processed || 0;
      const pct = total ? Math.round((fresh / total) * 100) : 0;
      out.push(`| ${ch} | ${total} | ${fresh} | ${done} | **${pct}%** |`);
    }
    out.push('');
    out.push('A channel at or near 100% never-acted-on is a capability that has not run, not a');
    out.push('backlog. Say which it is — and if Brain has ever CLAIMED to act on that channel,');
    out.push('that claim and this table cannot both be true.');
    out.push('');
  }

  const winBy = {};
  for (const f of feed) {
    const k = `${f.sourceType || '?'}`;
    winBy[k] = winBy[k] || { n: 0, fresh: 0 };
    winBy[k].n += 1;
    if (f.status === 'new') winBy[k].fresh += 1;
  }
  out.push(`In this window (${mode}): `
    + (Object.keys(winBy).length
      ? Object.entries(winBy).map(([k, v]) => `${k} ${v.n} (${v.fresh} unactioned)`).join(' · ')
      : 'no comm events at all — itself worth reporting'));
  out.push('');

  // A sample with real subjects, because a count cannot be diagnosed and a subject can.
  const SAMPLE_PER_CHANNEL = 6;
  const seen = {};
  const subjectOf = (fe) => {
    const pl = fe.rawPayload || {};
    const raw = pl.subject ?? pl.summary ?? pl.title ?? pl.snippet ?? pl.text ?? pl.body ?? '';
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, 130);
  };
  const lines = [];
  for (const f of feed) {
    const ch = f.sourceType || '?';
    seen[ch] = (seen[ch] || 0) + 1;
    if (seen[ch] > SAMPLE_PER_CHANNEL) continue;
    const who = f.senderName || f.senderEmail || 'unknown sender';
    const subj = subjectOf(f) || '(no subject in payload)';
    lines.push(`- **${ch}** ${f.createdAt.toISOString().slice(0, 16).replace('T', ' ')} `
      + `· status \`${f.status}\` · from ${who} — ${subj}`);
  }
  if (lines.length) {
    out.push(`## Newest items per channel (up to ${SAMPLE_PER_CHANNEL} each)`);
    out.push('');
    out.push(...lines);
    out.push('');
  }

  const fs = require('fs');
  // A quiet WhatsApp week is NOT an empty analysis any more. Since 2026-08-24 this file also
  // carries the Comm surface, and "22 conversation turns but 294 emails, none actioned" is
  // exactly the week where the transcript alone would have said there was nothing to look at.
  if (rows.length === 0 && feed.length === 0) {
    console.log('harvested 0 turns and 0 comm events in the window — leaving the existing file in place');
    await prisma.$disconnect();
    return;
  }
  fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
  console.log(`harvested ${rows.length} turns across ${session} session(s) `
    + `+ ${feed.length} comm events (${Object.keys(winBy).length} channels) -> ${OUT}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('harvest-chats FAILED:', e.message); process.exit(1); });
