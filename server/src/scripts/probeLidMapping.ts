/**
 * DEF-075 probe — why does an @lid counterpart not resolve to a phone?
 *
 * READ-ONLY. Sends nothing, writes nothing, mutates nothing.
 *
 * On 2026-08-06 10:16 Hamna's reply arrived as `255043747987458@lid` and
 * collapsed to the synthetic phone `+255043747987458`, matching no thread.
 * `waIdentity.lidToPhone` calls the right API — `getContactLidAndPhone`, which
 * the library types as returning `{ lid, pn }[]` — and it produced nothing
 * usable. The call site swallows the error, so from the logs it is impossible
 * to tell WHICH of these happened:
 *
 *   A. the API threw            → upstream broken again, as in recurrence #4
 *   B. it returned []           → it cannot map a contact outside the address
 *                                 book, and no resolver-side fix will ever work
 *   C. it returned a row with   → our parsing is wrong, and this is a small fix
 *      an empty or odd `pn`
 *
 * Each needs a completely different response, and I have been wrong twice
 * today reasoning from code instead of evidence. So: ask the system.
 *
 * Run:  cd /var/www/tmcai/server && npx tsx src/scripts/probeLidMapping.ts
 */
import 'dotenv/config';

const CLIENT_NUMBER = process.env.PROBE_CLIENT ?? 'TMC-0001';
// The exact id from the 10:16 inbound, plus Hamna's real number for the
// reverse direction.
const LID = process.env.PROBE_LID ?? '255043747987458@lid';
const PHONE = process.env.PROBE_PHONE ?? '923134199294';

function show(label: string, value: unknown): void {
  console.log(`\n── ${label} ──`);
  try { console.log(JSON.stringify(value, null, 2)?.slice(0, 1200) ?? String(value)); }
  catch { console.log(String(value)); }
}

async function main(): Promise<void> {
  const { getRawClientForDiagnostics } = await import('../services/whatsapp/WebjsProvider');
  const client = getRawClientForDiagnostics(CLIENT_NUMBER);
  if (!client) {
    console.log('No live client for', CLIENT_NUMBER, '— run this on the box while the server is up.');
    process.exit(1);
  }

  console.log('client ready. wid =', client?.info?.wid?._serialized ?? '(none)');
  console.log('getContactLidAndPhone present:', typeof client.getContactLidAndPhone === 'function');

  // A/B/C — the decisive call, LID → phone.
  try {
    const byLid = await client.getContactLidAndPhone([LID]);
    show(`getContactLidAndPhone(["${LID}"])`, byLid);
    if (Array.isArray(byLid) && byLid.length === 0) {
      console.log('\n>>> OUTCOME B: empty array. The API cannot map this contact.');
      console.log('    No resolver fix will work. The thread must carry the LID instead.');
    } else if (Array.isArray(byLid) && !byLid[0]?.pn) {
      console.log('\n>>> OUTCOME C: row returned but `pn` is empty/odd. Parsing or field name.');
    } else {
      console.log('\n>>> OUTCOME: mapping EXISTS. lidToPhone should have worked — bug is ours.');
    }
  } catch (e: any) {
    show('getContactLidAndPhone THREW', e?.message ?? String(e));
    console.log('\n>>> OUTCOME A: upstream API broken, same as @lid recurrence #4.');
  }

  // Reverse direction — does the phone map to a LID? This is what a
  // send-time mapping would depend on, and it is the fallback plan.
  try {
    show(`getContactLidAndPhone(["${PHONE}@c.us"])`, await client.getContactLidAndPhone([`${PHONE}@c.us`]));
  } catch (e: any) {
    show('reverse lookup THREW', e?.message ?? String(e));
  }

  // What the contact object itself knows — the first limb that failed.
  try {
    const c = await client.getContactById(LID);
    show('getContactById(LID)', {
      id: c?.id?._serialized, number: c?.number, isMyContact: c?.isMyContact,
      pushname: c?.pushname, name: c?.name, lid: (c as any)?.lid,
    });
  } catch (e: any) {
    show('getContactById(LID) THREW', e?.message ?? String(e));
  }

  process.exit(0);
}

main().catch((e) => { console.error('probe failed:', e?.message ?? e); process.exit(1); });
