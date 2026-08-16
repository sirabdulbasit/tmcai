import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

// ═══════════════════════════════════════════════════════════════════
// Operator-script parity (CMP-2026-08-16 chunk 1, remediating Codex
// WRONG on c572ccf).
//
// Two configs, two jobs:
//   tsconfig.json        TYPECHECK — covers everything under src/,
//                        including all 41 operator scripts. This is what
//                        `npx tsc --noEmit` and deploy.sh:170 run.
//   tsconfig.build.json  BUILD ONLY — excludes the 41 so they never
//                        reach server/dist on the production box.
//
// c572ccf collapsed both into one config, which silently dropped the 41
// from the typecheck gate. §5 below is the guard that makes that exact
// regression impossible to reintroduce quietly.
//
// Membership is by PRODUCTION SURFACE, read out of each file, never by
// filename — so there is no smoke* glob and a new smoke*.ts inherits
// nothing (§4).
// ═══════════════════════════════════════════════════════════════════

const SERVER = join(__dirname, '..');

/** tsconfig files are JSONC; TypeScript's own parser handles the comments. */
function readTsconfig(name: string): { exclude: string[] } {
  const text = readFileSync(join(SERVER, name), 'utf8');
  const parsed = ts.parseConfigFileTextToJson(name, text);
  expect(parsed.error, `${name} must be parseable`).toBeUndefined();
  return { exclude: (parsed.config?.exclude ?? []) as string[] };
}

/**
 * The classified inventory. Tiers are the rationale, established by reading
 * each script; see tsconfig.build.json for the per-tier explanation.
 */
const TIER_1_ACTION_REGISTRY = [
  '_smoke_undo', 'chaosDrill', 'smokeMcp', 'smokeNewSystems', 'smokeNextSession',
];
const TIER_2_BRAIN_ANSWER_PATH = [
  'brainChatBattery', 'brainChatRegressionBattery', 'nexeoCapabilityBenchmark',
  'verifyGuruFix', 'smokeBatch2', 'smokeBrainOverWa', 'smokeBrainRetryLoop',
  'smokeGru', 'smokeLiveSnapshots', 'smokeVectorRetrieval',
];
const TIER_3_OUTBOUND_MESSAGING = [
  'smokeBrainOutbound', 'smokeBrainPromptDelegateeEmail', 'smokeBrainPromptProducer',
  'smokeBrainPromptQueue', 'smokeBrainPromptReplyFlow', 'smokeWhatsappVoiceCall',
];
const TIER_4_PRODUCTION_WRITES = [
  'cleanupBatterySeeds', 'draftTestWaToBasit', 'seedGoldenDataset',
  'smokeOpsManualRetrieval', 'smokeRetrievalFeedback', 'smokeRiskRadarV2',
  'smokeUserPromptOverlay',
];
const TIER_5_PRODUCTION_READS = [
  'diagnoseAttention', 'loadTestFeed', 'probeTasks', 'scribeBackfillEmails',
  'smokeBrainIntelligence', 'smokeCommitments', 'smokeCriticality', 'smokeFeedback',
  'smokeInstructions', 'smokeInstructionVeto', 'smokeMeetingDigest',
  'smokeTenantIsolation', 'smokeWaDailyLimit',
];

const INVENTORY = [
  ...TIER_1_ACTION_REGISTRY, ...TIER_2_BRAIN_ANSWER_PATH, ...TIER_3_OUTBOUND_MESSAGING,
  ...TIER_4_PRODUCTION_WRITES, ...TIER_5_PRODUCTION_READS,
];
const EXPECTED_COUNT = 41;

const toPath = (n: string) => `src/scripts/${n}.ts`;
const scriptExcludes = (excl: string[]) => excl.filter((e) => e.startsWith('src/scripts/'));

describe('operator-script parity — typecheck covers all, build excludes the classified', () => {
  it('1 · the inventory is 41 files across five tiers, with no duplicates', () => {
    expect(INVENTORY.length).toBe(EXPECTED_COUNT);
    expect(new Set(INVENTORY).size).toBe(EXPECTED_COUNT);
    expect(TIER_1_ACTION_REGISTRY.length).toBe(5);
    expect(TIER_2_BRAIN_ANSWER_PATH.length).toBe(10);
    expect(TIER_3_OUTBOUND_MESSAGING.length).toBe(6);
    expect(TIER_4_PRODUCTION_WRITES.length).toBe(7);
    expect(TIER_5_PRODUCTION_READS.length).toBe(13);
  });

  it('2 · every inventory entry exists on disk — no stale exclusions', () => {
    const missing = INVENTORY.filter((n) => !existsSync(join(SERVER, toPath(n))));
    expect(missing, `inventory names no longer on disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('3 · tsconfig.build.json excludes exactly the inventory — no drift, no glob', () => {
    const excluded = scriptExcludes(readTsconfig('tsconfig.build.json').exclude);
    const expected = INVENTORY.map(toPath).sort();

    // An explicit inventory, so nothing may be matched by wildcard.
    const globs = excluded.filter((e) => e.includes('*'));
    expect(globs, `build config must name scripts explicitly, found globs: ${globs.join(', ')}`)
      .toEqual([]);

    expect([...excluded].sort()).toEqual(expected);
  });

  it('4 · a new src/scripts/ file is not silently excluded, and smoke* inherits nothing', () => {
    // The anti-glob guard. Under the old smoke*.ts glob a new file with that
    // prefix silently lost emission AND type checking. Now an untriaged
    // smoke*.ts fails here instead, forcing a classification decision.
    const onDisk = readdirSync(join(SERVER, 'src/scripts'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''));

    const untriagedSmoke = onDisk
      .filter((n) => /^_?smoke/i.test(n))
      .filter((n) => !INVENTORY.includes(n));

    expect(
      untriagedSmoke,
      `new smoke-prefixed script(s) not classified: ${untriagedSmoke.join(', ')}. ` +
        'Read the file, assign a tier in tsconfig.build.json, and add it to the ' +
        'inventory here — membership is by production surface, not by filename.',
    ).toEqual([]);
  });

  it('5 · tsconfig.json (typecheck) excludes NONE of the 41 — the c572ccf guard', () => {
    // This is the regression guard for the WRONG verdict. If anyone moves the
    // operator exclusions back into the typecheck config, the standing
    // `npx tsc --noEmit` gate stops covering scripts that can act on
    // production — silently, which is exactly how c572ccf passed its own
    // matrix. It must fail loudly here instead.
    const excluded = scriptExcludes(readTsconfig('tsconfig.json').exclude);
    expect(
      excluded,
      'tsconfig.json is the TYPECHECK config and must not exclude operator ' +
        'scripts; put build-only exclusions in tsconfig.build.json',
    ).toEqual([]);
  });

  it('6 · no excluded script is reachable from the runtime entry graph', () => {
    // Dropping them from the artifact is only safe while nothing running
    // imports them.
    const runtime = [join(SERVER, 'src/server.ts'), join(SERVER, 'src/jobs')];
    const sources: string[] = [];
    const walk = (p: string) => {
      if (!existsSync(p)) return;
      const stat = readdirSync(p, { withFileTypes: true });
      for (const e of stat) {
        const full = join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) sources.push(readFileSync(full, 'utf8'));
      }
    };
    sources.push(readFileSync(runtime[0], 'utf8'));
    walk(runtime[1]);

    const referenced = INVENTORY.filter((n) =>
      sources.some((s) => s.includes(`scripts/${n}`)),
    );
    expect(referenced, `runtime code imports excluded script(s): ${referenced.join(', ')}`)
      .toEqual([]);
  });
});
