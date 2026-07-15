/**
 * One-off: send a single WhatsApp test message using the existing LocalAuth
 * session on disk (./whatsapp-sessions/session-TMC-0001), then exit cleanly.
 *
 * Usage:  npx ts-node src/scripts/sendOneOffWaTest.ts <e164-phone> "<message>"
 *
 * Why this exists: the running dev server's in-process whatsapp-web.js client
 * has detached but the LocalAuth files on disk are intact, so a fresh process
 * can re-initialize from disk without a QR scan and send a single message.
 */
import path from 'path';
import { sendWhatsAppMessage } from '../services/whatsapp/WhatsAppManager';
import { getProvider, clearProviderCache } from '../services/whatsapp/WhatsAppManager';

const CLIENT_NUMBER = 'TMC-0001';
const SESSION_PATH = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';

async function main() {
  const phone = process.argv[2];
  const body  = process.argv[3] ?? 'MyOS test — Brain → user channel pipeline check.';
  if (!phone) { console.error('usage: <phone> <body>'); process.exit(1); }

  console.log(`[wa-test] session path: ${path.resolve(SESSION_PATH)}/session-${CLIENT_NUMBER}`);
  console.log(`[wa-test] target: ${phone}`);
  console.log(`[wa-test] initializing whatsapp-web.js from LocalAuth …`);

  const provider = await getProvider(CLIENT_NUMBER);
  await provider.initialize(CLIENT_NUMBER);

  // Wait for `ready` event — sendWhatsAppMessage will fail with
  // "WhatsApp not connected" until the client emits ready.
  // Poll testConnection() instead of subscribing — provider doesn't expose
  // its EventEmitter directly and polling is fine for a one-off.
  const deadline = Date.now() + 60_000;  // 60s
  let connected = false;
  while (Date.now() < deadline) {
    const t = await provider.testConnection(CLIENT_NUMBER);
    if (t.success) { connected = true; console.log(`[wa-test] connected as ${t.connectedNumber}`); break; }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!connected) {
    console.error('\n[wa-test] timed out waiting for whatsapp-web.js to become ready');
    process.exit(2);
  }

  // Use the canonical sendWhatsAppMessage path so the daily-limit claim,
  // log row, and provider.sendMessage all run exactly as in production.
  const r = await sendWhatsAppMessage({
    clientNumber: CLIENT_NUMBER,
    to: phone,
    message: body,
    userId: 5,                  // admin user (haseeb@tmcltd.ai); used only for log_user_id
  });
  console.log('[wa-test] result:', JSON.stringify(r, null, 2));

  // Graceful disconnect so LocalAuth flushes session state to disk before
  // process exits. WebjsProvider's destroyAllClients hook normally does this
  // on SIGTERM; we mirror the call here for the one-shot.
  try {
    await provider.disconnect(CLIENT_NUMBER);
    clearProviderCache(CLIENT_NUMBER);
  } catch { /* best effort */ }

  process.exit(r.success ? 0 : 3);
}

main().catch((err) => { console.error('[wa-test] failed:', err); process.exit(1); });
