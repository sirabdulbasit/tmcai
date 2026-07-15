/**
 * draftTestWaToBasit.ts — drop a WhatsApp draft into the agentAction queue
 * from Brain to Basit Ahmed (user id=1, +923226288256). It will appear on
 * the MD's Day Brief → Drafts section; a single Send click fires through
 * the existing `POST /brief/drafts/:id/send` path, which uses the live
 * UserWebjsProvider session (user=5, last authenticated earlier today).
 *
 * No message is sent by this script itself — that's a user action.
 */
import prisma from '../db/prisma';

const MD_USER_ID = 5;
const BASIT_PHONE = '+923226288256';
const BASIT_CHAT_ID = '923226288256@c.us';
const BASIT_NAME = 'Basit Ahmed';

const body = [
  `Hi ${BASIT_NAME.split(' ')[0]} — this is a test from MyOS Brain.`,
  '',
  'Abdul Haseeb is testing whether Brain can reach him on WhatsApp for critical alerts. If this lands, reply with 👍 so we have round-trip confirmation.',
  '',
  'No action needed beyond the 👍 — this is a connection health check, not a real ask.',
].join('\n');

async function main() {
  const md = await prisma.user.findUnique({
    where: { id: MD_USER_ID },
    select: { clientNumber: true, name: true, email: true },
  });
  if (!md) throw new Error(`MD user ${MD_USER_ID} not found`);

  const created = await prisma.agentAction.create({
    data: {
      clientNumber: md.clientNumber,
      userId: MD_USER_ID,
      actionType: 'draft_reply',
      status: 'done',
      requiresApproval: true,
      input: {
        reason: 'Brain self-test — verify WhatsApp round-trip to Basit',
        draftedBy: 'brain_self_test',
        feedEventId: null,
      } as any,
      output: {
        channel: 'whatsapp',
        chatId: BASIT_CHAT_ID,
        phoneNumber: BASIT_PHONE,
        toName: BASIT_NAME,
        body,
        provider: 'webjs',
      } as any,
    },
  });
  console.log('draft created id=', created.id);
  console.log('channel: whatsapp  to:', BASIT_PHONE, '  via: webjs session u5');
  console.log('\nMessage body:\n' + '—'.repeat(60));
  console.log(body);
  console.log('—'.repeat(60));
  console.log('\nIt should now appear on your Day Brief under Drafts.');
  console.log('Click Send (or approve) to actually transmit it to Basit.');

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
