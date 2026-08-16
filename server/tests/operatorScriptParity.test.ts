import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import ts from 'typescript';

// ═══════════════════════════════════════════════════════════════════
// Operator-script parity (CMP-2026-08-16 chunk 1).
//
// Two configs, two jobs:
//   tsconfig.json        TYPECHECK — every file under src/, including all 41
//                        operator scripts. `npx tsc --noEmit` and the deploy
//                        gate use it.
//   tsconfig.build.json  BUILD ONLY — excludes the 41 so they never reach
//                        server/dist on the production box.
//
// c572ccf collapsed both into one config, silently dropping the 41 from the
// typecheck gate — Codex WRONG. b3a213d split them but tested the split by
// reading the `exclude` ARRAY TEXT, which Codex then ruled WEAK: the array is
// a description of the program, not the program. `include`, `files` or
// `extends` can empty the program by another route and a text assertion still
// passes.
//
// So every guard below resolves the ACTUAL TypeScript program through the
// compiler API and asserts membership, and the entry-graph guard walks real
// module resolution rather than searching for substrings.
// ═══════════════════════════════════════════════════════════════════

const SERVER = join(__dirname, '..');

function resolveConfig(name: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(SERVER, name), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`${name}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    },
  } as ts.ParseConfigFileHost);
  if (!parsed) throw new Error(`${name} did not resolve`);
  return parsed;
}

/** Basenames (no extension) of the files TypeScript actually puts in the program. */
const programScripts = (p: ts.ParsedCommandLine) =>
  new Set(
    p.fileNames
      .filter((f) => f.includes('/src/scripts/'))
      .map((f) => basename(f, '.ts')),
  );

// ── The classified inventory ────────────────────────────────────────
// Membership is by PRODUCTION SURFACE, read out of each file. No glob, so a
// new smoke*.ts inherits nothing.
//
// Tiers 4 and 5 were CORRECTED after Codex's LOW on b3a213d: the original scan
// matched only the Prisma model API (`prisma.<model>.create|update|…`) and
// never looked for raw SQL, so four scripts that write via `$executeRaw` /
// `$executeRawUnsafe` were labelled read-only. They are Tier 4 below.

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
/** Writes production data — via the Prisma model API OR raw SQL. */
const TIER_4_PRODUCTION_WRITES = [
  'cleanupBatterySeeds', 'draftTestWaToBasit', 'seedGoldenDataset',
  'smokeOpsManualRetrieval', 'smokeRetrievalFeedback', 'smokeRiskRadarV2',
  'smokeUserPromptOverlay',
  // corrected from Tier 5 — these write through raw SQL:
  'loadTestFeed',           // $executeRaw`DELETE FROM feed_events …`
  'smokeInstructionVeto',   // $executeRawUnsafe × 1
  'smokeMeetingDigest',     // $executeRawUnsafe × 2
  'smokeWaDailyLimit',      // $executeRawUnsafe × 5
];
/** No write detected through EITHER the Prisma model API or raw SQL. */
const TIER_5_PRODUCTION_READS = [
  'diagnoseAttention', 'probeTasks', 'scribeBackfillEmails',
  'smokeBrainIntelligence', 'smokeCommitments', 'smokeCriticality',
  'smokeFeedback', 'smokeInstructions', 'smokeTenantIsolation',
];

const INVENTORY = [
  ...TIER_1_ACTION_REGISTRY, ...TIER_2_BRAIN_ANSWER_PATH, ...TIER_3_OUTBOUND_MESSAGING,
  ...TIER_4_PRODUCTION_WRITES, ...TIER_5_PRODUCTION_READS,
];

/**
 * The other 38 scripts in src/scripts/. NOT triaged and NOT asserted safe —
 * they are still emitted into dist. Codex's scope note on b3a213d: several are
 * plainly production-capable (migrations, backfills, purges, token
 * provisioning, one-off WhatsApp sending). Listed so the partition below is
 * exhaustive and a NEW script cannot join either group silently.
 */
const UNTRIAGED_STILL_EMITTED = [
  'applyPendingMigrations', 'auditHardcodedBrainReplies', 'auditPerModelTenantScope',
  'auditTenantScopedQueries', 'backfillAttachments', 'backfillBasitGmail30d',
  'backfillConceptPages', 'backfillDevanagariToUrdu', 'backfillEmailBodies',
  'backfillEmailThreadIds', 'backfillEntityLinks', 'backfillFeedEventAt',
  'backfillOpenItemDelegationStatus', 'backfillPersons', 'backfillSenderWiki',
  'backfillTodayGmail', 'backfillVoiceTranscripts', 'backfillWikiEmbeddings',
  'brainBasitCheck', 'brainTranscriptReplay', 'calibrateResponseJudge',
  'cleanupDuplicateOpenItems', 'cleanupJunkContacts', 'cleanupLegacyHaseebOSContent',
  'dedupContactsByEmail', 'diagnoseWebjsBootstrap', 'feedEventsPruner',
  'kickGmailPoll', 'nexeoInboundNoiseReport', 'nexeoNotifyOwner',
  'nexeoProactiveBenchmark', 'normalizeContactNames', 'provisionAgentToken',
  'purgeNonMessageWaEvents', 'seedActionDefinitions', 'seedOpsManual',
  'seedPromptBlocks', 'sendOneOffWaTest',
];

/**
 * Scripts genuinely reachable from the runtime entry graph. Established by
 * module resolution (guard 7), not by assumption. These must NEVER be
 * excluded from the build — the positive control that stops the exclusion
 * mechanism over-reaching.
 */
const RUNTIME_REACHABLE = ['seedActionDefinitions'];

describe('operator-script parity — resolved programs, not config text', () => {
  it('1 · inventory is 41 across five tiers, no duplicates', () => {
    expect(INVENTORY.length).toBe(41);
    expect(new Set(INVENTORY).size).toBe(41);
    expect(TIER_1_ACTION_REGISTRY.length).toBe(5);
    expect(TIER_2_BRAIN_ANSWER_PATH.length).toBe(10);
    expect(TIER_3_OUTBOUND_MESSAGING.length).toBe(6);
    expect(TIER_4_PRODUCTION_WRITES.length).toBe(11);
    expect(TIER_5_PRODUCTION_READS.length).toBe(9);
  });

  it('2 · every inventory entry exists on disk — no stale exclusions', () => {
    const missing = INVENTORY.filter(
      (n) => !existsSync(join(SERVER, `src/scripts/${n}.ts`)),
    );
    expect(missing, `not on disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('3 · all 41 are IN the resolved typecheck program — the c572ccf guard', () => {
    // Resolves tsconfig.json through the compiler API and asks which files the
    // program actually contains. Unlike an `exclude`-array assertion this also
    // fails if `include`/`files`/`extends` removes them by another route,
    // which is the hole Codex found in b3a213d.
    const inProgram = programScripts(resolveConfig('tsconfig.json'));
    const dropped = INVENTORY.filter((n) => !inProgram.has(n));
    expect(
      dropped,
      `operator scripts missing from the TYPECHECK program: ${dropped.join(', ')}. ` +
        'They can act on production and must stay type-checked; put build-only ' +
        'exclusions in tsconfig.build.json.',
    ).toEqual([]);
  });

  it('4 · none of the 41 is in the resolved build program', () => {
    const inBuild = programScripts(resolveConfig('tsconfig.build.json'));
    const leaked = INVENTORY.filter((n) => inBuild.has(n));
    expect(leaked, `would be emitted into dist: ${leaked.join(', ')}`).toEqual([]);
  });

  it('5 · the two programs differ by exactly the 41', () => {
    const tc = programScripts(resolveConfig('tsconfig.json'));
    const bd = programScripts(resolveConfig('tsconfig.build.json'));
    const diff = [...tc].filter((n) => !bd.has(n)).sort();
    expect(diff).toEqual([...INVENTORY].sort());
    expect(tc.size - bd.size).toBe(41);
  });

  it('6 · src/scripts is exhaustively partitioned — a new script forces triage', () => {
    const onDisk = readdirSync(join(SERVER, 'src/scripts'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    const known = [...INVENTORY, ...UNTRIAGED_STILL_EMITTED].sort();

    expect(
      new Set([...INVENTORY].filter((n) => UNTRIAGED_STILL_EMITTED.includes(n))).size,
      'a script cannot be both classified and untriaged',
    ).toBe(0);

    const unaccounted = onDisk.filter((n) => !known.includes(n));
    expect(
      unaccounted,
      `new script(s) in src/scripts not triaged: ${unaccounted.join(', ')}. ` +
        'Read the file, decide whether it reaches production, then either add it ' +
        'to a tier in tsconfig.build.json + INVENTORY, or to UNTRIAGED_STILL_EMITTED ' +
        'acknowledging it still ships in dist. Filename is not a classification.',
    ).toEqual([]);
    expect(onDisk).toEqual(known);
  });

  it('7 · no build-graph import resolves into the 41 — real module resolution', () => {
    // Replaces the substring search Codex ruled insufficient. `exclude` only
    // filters the INITIAL file set; an import from any emitted file pulls a
    // file back into the program and therefore into dist. This walks every
    // import edge in the build graph through TypeScript's own resolver, so it
    // sees re-exports, path aliases and deep imports that a text search misses.
    const bd = resolveConfig('tsconfig.build.json');
    const cache = ts.createModuleResolutionCache(SERVER, (s) => s, bd.options);
    const inventory = new Set(INVENTORY);
    const edges: string[] = [];

    for (const file of bd.fileNames) {
      const pre = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
      for (const imported of pre.importedFiles) {
        const r = ts.resolveModuleName(
          imported.fileName, file, bd.options, ts.sys, cache,
        );
        const resolvedFile = r.resolvedModule?.resolvedFileName;
        if (!resolvedFile || !resolvedFile.includes('/src/scripts/')) continue;
        if (inventory.has(basename(resolvedFile, '.ts'))) {
          edges.push(`${basename(file)} -> ${basename(resolvedFile)}`);
        }
      }
    }
    expect(
      edges,
      `emitted code imports excluded operator script(s): ${edges.join(', ')}. ` +
        'The import re-includes them in dist, defeating the exclusion.',
    ).toEqual([]);
  });

  it('8 · runtime-reachable scripts are NOT excluded — the over-reach control', () => {
    // seedActionDefinitions is imported by src/server.ts (found by guard 7's
    // resolver). Excluding it would break the build, so this asserts the
    // mechanism does not over-reach as the inventory grows.
    const inBuild = programScripts(resolveConfig('tsconfig.build.json'));
    const wronglyExcluded = RUNTIME_REACHABLE.filter((n) => !inBuild.has(n));
    expect(
      wronglyExcluded,
      `runtime-reachable script(s) excluded from the build: ${wronglyExcluded.join(', ')}`,
    ).toEqual([]);
    RUNTIME_REACHABLE.forEach((n) => expect(INVENTORY).not.toContain(n));
  });
});
