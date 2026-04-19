/**
 * HaseebOS v15 — Golden Dataset seeder
 *
 * Exports historical decisions from `decision_logs` into `golden_dataset` so
 * the Probabilistic Shadowing pipeline has a labeled reference set to score
 * new rules against.
 *
 * Usage:
 *   npx ts-node src/scripts/seedGoldenDataset.ts --tenant C-1604 --months 12 [--dry-run]
 *
 * The label is inferred from each decision: `isMatch=true` + `outcome` !== 'negative'
 * → positive example; everything else → counter-example. Abdul can curate manually
 * afterwards via the /api/v1/shadow/golden-dataset UI (Phase 6).
 */

import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();
import prisma from '../db/prisma';

type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

const RISK_THRESHOLD: Record<RiskTier, number> = {
  LOW: 0.95,
  MEDIUM: 0.98,
  HIGH: 1.0,
};

interface Args {
  tenant: string | null;
  months: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const a: Args = { tenant: null, months: 12, dryRun: false };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--tenant' && process.argv[i + 1]) a.tenant = process.argv[++i];
    else if (arg === '--months' && process.argv[i + 1]) a.months = parseInt(process.argv[++i], 10);
    else if (arg === '--dry-run') a.dryRun = true;
  }
  if (!a.tenant) {
    console.error('usage: seedGoldenDataset --tenant <clientNumber> [--months 12] [--dry-run]');
    process.exit(1);
  }
  return a;
}

async function main() {
  const args = parseArgs();
  const since = new Date();
  since.setMonth(since.getMonth() - args.months);

  console.log(`[seed] tenant=${args.tenant} months=${args.months} dryRun=${args.dryRun}`);
  console.log(`[seed] pulling decisions since ${since.toISOString()}`);

  const decisions = await prisma.decisionLog.findMany({
    where: {
      clientNumber: args.tenant!,
      createdAt: { gte: since },
      suggestedAction: { not: null },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`[seed] found ${decisions.length} decisions`);

  let inserted = 0;
  let duplicates = 0;
  let skippedNoInput = 0;

  for (const d of decisions) {
    if (!d.suggestedAction || !d.itemType) {
      skippedNoInput += 1;
      continue;
    }

    const inputText = buildInputText(d);
    const inputHash = crypto.createHash('sha256').update(inputText).digest('hex');
    const tier = inferRiskTier(d);
    const expectedOutput = {
      userDecision: d.userDecision,
      isMatch: d.isMatch,
      actionTaken: d.actionTaken,
      outcome: d.outcome ?? null,
    };

    if (args.dryRun) {
      console.log(`[dry-run] would insert ${inputHash.slice(0, 10)}… tier=${tier} decision=${d.userDecision}`);
      continue;
    }

    try {
      await prisma.goldenDataset.create({
        data: {
          clientNumber: args.tenant!,
          category: d.itemType,
          inputHash,
          inputText: inputText.slice(0, 2000),
          expectedOutput: expectedOutput as any,
          scoreThreshold: RISK_THRESHOLD[tier],
          riskTier: tier,
        },
      });
      inserted += 1;
    } catch (err: any) {
      if (err.code === 'P2002') duplicates += 1;
      else console.error(`[seed] error for ${d.id}: ${err.message}`);
    }
  }

  console.log(`[seed] done. inserted=${inserted} duplicates=${duplicates} skipped=${skippedNoInput}`);
}

function buildInputText(d: {
  sessionType: string;
  itemType: string;
  entityId: string | null;
  suggestedAction: string | null;
  connectorSlug: string | null;
  inputSummary: string | null;
}): string {
  return [
    `session:${d.sessionType}`,
    `itemType:${d.itemType}`,
    d.entityId ? `entity:${d.entityId}` : null,
    d.connectorSlug ? `connector:${d.connectorSlug}` : null,
    d.inputSummary ? `summary:${d.inputSummary}` : null,
    `suggested:${d.suggestedAction}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function inferRiskTier(d: { riskTier: string | null; itemType: string; suggestedAction: string | null }): RiskTier {
  if (d.riskTier === 'LOW' || d.riskTier === 'MEDIUM' || d.riskTier === 'HIGH') return d.riskTier;
  // Fall back to spec heuristics when legacy rows have no riskTier
  const action = (d.suggestedAction ?? '').toLowerCase();
  if (action.includes('opportunity') || action.includes('freeze') || action.includes('approval')) return 'HIGH';
  if (action.includes('send') || action.includes('reply') || action.includes('delegate') || action.includes('schedule')) return 'MEDIUM';
  return 'LOW';
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
