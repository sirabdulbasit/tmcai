/**
 * Phase G — MyOS CLI.
 *
 * `myos ask` — ask Brain a question from the shell, same two-pass
 * pipeline the web chat uses. Resolves the user by email so it works
 * for any user in the tenant without needing a session cookie.
 *
 * Usage:
 *   npx ts-node src/cli/myos.ts ask --user basit.ahmed@tmcltd.com "what did Fahim say?"
 *   npx ts-node src/cli/myos.ts ask --user haseeb@tmcltd.ai "status of the Voyage AI proposal"
 *   npx ts-node src/cli/myos.ts lint --user basit.ahmed@tmcltd.com
 *
 * Karpathy spirit: Brain as a Unix citizen, pipe-able, scriptable.
 * Keeps Brain out from behind the webpage.
 */
import prisma from '../db/prisma';

function parseArgs(argv: string[]): { cmd: string; userEmail?: string; rest: string[] } {
  const [cmd, ...rest] = argv.slice(2);
  const userIdx = rest.indexOf('--user');
  let userEmail: string | undefined;
  if (userIdx >= 0 && rest[userIdx + 1]) {
    userEmail = rest[userIdx + 1];
    rest.splice(userIdx, 2);
  }
  return { cmd: cmd ?? 'help', userEmail, rest };
}

async function resolveUser(email?: string): Promise<{ id: number; clientNumber: string; name: string | null; email: string }> {
  if (!email) throw new Error('--user <email> required');
  const u = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } } as any,
    select: { id: true, clientNumber: true, name: true, email: true },
  });
  if (!u) throw new Error(`user not found: ${email}`);
  return u;
}

async function cmdAsk(userEmail: string | undefined, rest: string[]) {
  const u = await resolveUser(userEmail);
  const question = rest.join(' ').trim();
  if (!question) throw new Error('question required: myos ask --user <email> "your question"');
  const { answerAsBrain } = await import('../routes/brainAskRoutes');
  const t0 = Date.now();
  const r = await answerAsBrain(u.clientNumber, u.id, question);
  const ms = Date.now() - t0;
  console.log(`\n━━━ ${u.name ?? u.email} (${u.clientNumber})  ${ms}ms  intent=${(r as any).intent}  cites=${(r.sources ?? []).length}  gaps=${(r.gaps ?? []).length}`);
  console.log(`Q: ${question}`);
  console.log(`A: ${r.answer}`);
  if ((r.sources ?? []).length > 0) {
    console.log('Sources:');
    for (const s of r.sources) console.log(`  · [${s.type}] ${String(s.snippet ?? '').slice(0, 120)}`);
  }
  const gaps = r.gaps ?? [];
  if (gaps.length > 0) {
    console.log('Gaps:');
    for (const g of gaps) console.log(`  · ${g}`);
  }
}

async function cmdLint(userEmail: string | undefined) {
  const u = await resolveUser(userEmail);
  const { runLintForUser } = await import('../jobs/wikiLintWorker');
  const f = await runLintForUser(u.clientNumber, u.id);
  console.log(JSON.stringify(f, null, 2));
}

async function cmdStatus(userEmail: string | undefined) {
  const u = await resolveUser(userEmail);
  const { getBackfillStatusForUser } = await import('../jobs/attachmentBackfillWorker');
  const { getSystemCapabilities, renderCapabilitiesBlock } = await import('../services/knowledge/systemCapabilitiesService');
  const [bf, caps] = await Promise.all([
    getBackfillStatusForUser(u.clientNumber, u.id),
    getSystemCapabilities(u.clientNumber, u.id),
  ]);
  console.log(renderCapabilitiesBlock(caps));
  console.log('\n## Attachment backfill');
  console.log(JSON.stringify(bf, null, 2));
}

function usage() {
  console.log(`MyOS CLI — Brain as a Unix citizen.

Commands:
  ask    --user <email> "<question>"    Ask Brain a question
  lint   --user <email>                 Run wiki lint for a user and print findings
  status --user <email>                 Show connector + backfill status for a user
  help                                  This message
`);
}

async function main() {
  const { cmd, userEmail, rest } = parseArgs(process.argv);
  try {
    switch (cmd) {
      case 'ask':    await cmdAsk(userEmail, rest); break;
      case 'lint':   await cmdLint(userEmail); break;
      case 'status': await cmdStatus(userEmail); break;
      case 'help':
      default:       usage();
    }
  } catch (err: any) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

main().finally(() => setTimeout(() => process.exit(0), 1500).unref());
