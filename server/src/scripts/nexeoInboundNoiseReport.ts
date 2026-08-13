/**
 * C-3 increment 1 — print the inbound-noise count for one tenant/owner.
 *
 * The increment's "done when" is that the real count for the CL-033 burst is
 * quoted back to the owner FROM PRODUCTION DATA. This is how that number gets
 * read: a read-only query, run on the box, printing the report verbatim.
 *
 *   npx tsx src/scripts/nexeoInboundNoiseReport.ts --client TMC-0001 --user 2
 *   npx tsx src/scripts/nexeoInboundNoiseReport.ts --client TMC-0001 --user 2 --hours 168
 *
 * `--hours` widens the window; CL-033 is 2026-08-12, so reaching it from a later
 * date needs a window that spans back to it. **It reports what the rows say and
 * nothing else** — if the queue has no row for a push, this prints a smaller
 * number rather than inferring the missing ones. A count that quietly fills gaps
 * would be worse than no count.
 *
 * Writes nothing. Exits non-zero only on a failed read, so a broken query can
 * never be mistaken for a quiet inbox.
 */
import { summariseInboundNoise, renderNoiseReport } from '../services/selfpruning/inboundNoiseLedger';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const clientNumber = arg('client');
  const userId = Number(arg('user'));
  const hours = arg('hours') ? Number(arg('hours')) : undefined;

  if (!clientNumber || !Number.isFinite(userId)) {
    console.error('usage: --client <clientNumber> --user <userId> [--hours N]');
    process.exit(2);
    return;
  }

  const summary = await summariseInboundNoise({ clientNumber, userId, windowHours: hours });
  console.log(renderNoiseReport(summary));

  // A machine-readable tail, so the orchestrator can quote exact figures without
  // parsing prose.
  console.log('');
  console.log(`REACHED=${summary.totalReached} ANSWERED=${summary.totalActed} `
    + `UNANSWERED=${summary.totalIgnored} BURSTS=${summary.bursts.length}`);
}

main().catch((e) => {
  console.error('inbound noise report FAILED:', e?.message ?? e);
  process.exit(1);
});
