/**
 * Provision a tenant-bound agent API token (E1).
 *
 * Usage: npx tsx src/scripts/provisionAgentToken.ts <clientNumber> [label]
 *
 * Generates a random token, stores ONLY its sha256 hash in agent_api_tokens
 * bound to the given tenant, and prints the raw token ONCE. Give the raw
 * value to the ADK worker's env; it cannot be recovered later — re-provision
 * if lost (old row can be deactivated with is_active=false).
 */
import crypto from 'crypto';
import prisma from '../db/prisma';
import { hashAgentToken } from '../middleware/agentAuthMiddleware';

async function main() {
  const [clientNumber, label] = process.argv.slice(2);
  if (!clientNumber) {
    console.error('Usage: provisionAgentToken <clientNumber> [label]');
    process.exit(1);
  }

  const tenant = await prisma.tenant.findFirst({ where: { clientNumber } });
  if (!tenant) {
    console.error(`No tenant with clientNumber=${clientNumber}`);
    process.exit(1);
  }

  const raw = 'agt_' + crypto.randomBytes(32).toString('hex');
  const row = await prisma.agentApiToken.create({
    data: {
      tokenHash: hashAgentToken(raw),
      clientNumber,
      label: label ?? null,
    },
  });

  console.log(`Provisioned agent token for tenant ${clientNumber} (${tenant.name ?? ''})`);
  console.log(`  token id : ${row.id}`);
  console.log(`  label    : ${row.label ?? '(none)'}`);
  console.log('');
  console.log('Raw token (shown ONCE — store it in the agent worker env now):');
  console.log(`  ${raw}`);
  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
