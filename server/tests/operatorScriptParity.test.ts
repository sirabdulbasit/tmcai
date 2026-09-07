import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import ts from 'typescript';

// ═══════════════════════════════════════════════════════════════════
// Operator-script parity (CMP-2026-08-16 chunk 1).
//
// Two configs, two jobs:
//   tsconfig.json        TYPECHECK — every file under src/, including all 42
//                        operator scripts. `npx tsc --noEmit` and the deploy
//                        gate use it.
//   tsconfig.build.json  BUILD ONLY — excludes the 42 so they never reach
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
// Tiers 1-3 are surface classifications read out of each file. Tiers 4 and 5
// are COMPUTED by guard 9 from the import closure, because hand-labelling got
// them wrong twice: the first scan saw only the Prisma model API and missed raw
// SQL, the second added raw SQL and still missed service-mediated writes.

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
/**
 * Reaches a production write. MEASURED by guard 9 through the import closure,
 * not asserted by hand — two rounds of hand-labelling produced two rounds of
 * Codex LOWs (raw SQL missed, then service-mediated writes missed), so the
 * classification is now computed and the list below is only its expected value.
 */
const TIER_4_PRODUCTION_WRITES = [
  'cleanupBatterySeeds', 'draftTestWaToBasit', 'seedGoldenDataset',
  'smokeOpsManualRetrieval', 'smokeRetrievalFeedback', 'smokeRiskRadarV2',
  'smokeUserPromptOverlay',
  // LEARN-002 (2026-09-07): the nightly's LEARN phase. Reaches
  // prisma.governedBrainMemory.update through sweepQualifyingMemories, so guard 9
  // computes it into this tier — activating a memory changes what Brain says.
  'nexeoLearnSweep',
  // direct raw SQL (first correction):
  'loadTestFeed', 'smokeInstructionVeto', 'smokeMeetingDigest', 'smokeWaDailyLimit',
  // service-mediated writes (second correction) — e.g. scribeBackfillEmails ->
  // backfillUserScribe -> prisma.wikiPage.create:
  'diagnoseAttention', 'probeTasks', 'scribeBackfillEmails',
  'smokeBrainIntelligence', 'smokeCommitments', 'smokeCriticality',
  'smokeFeedback', 'smokeInstructions',
];
/** No write reachable anywhere in the import closure. Exactly one script. */
const TIER_5_NO_WRITE_REACHABLE = ['smokeTenantIsolation'];

const INVENTORY = [
  ...TIER_1_ACTION_REGISTRY, ...TIER_2_BRAIN_ANSWER_PATH, ...TIER_3_OUTBOUND_MESSAGING,
  ...TIER_4_PRODUCTION_WRITES, ...TIER_5_NO_WRITE_REACHABLE,
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
  it('1 · inventory is 42 across five tiers, no duplicates', () => {
    expect(INVENTORY.length).toBe(42);
    expect(new Set(INVENTORY).size).toBe(42);
    expect(TIER_1_ACTION_REGISTRY.length).toBe(5);
    expect(TIER_2_BRAIN_ANSWER_PATH.length).toBe(10);
    expect(TIER_3_OUTBOUND_MESSAGING.length).toBe(6);
    expect(TIER_4_PRODUCTION_WRITES.length).toBe(20);
    expect(TIER_5_NO_WRITE_REACHABLE.length).toBe(1);
  });

  it('2 · every inventory entry exists on disk — no stale exclusions', () => {
    const missing = INVENTORY.filter(
      (n) => !existsSync(join(SERVER, `src/scripts/${n}.ts`)),
    );
    expect(missing, `not on disk: ${missing.join(', ')}`).toEqual([]);
  });

  it('3 · all 42 are IN the resolved typecheck program — the c572ccf guard', () => {
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

  it('4 · none of the 42 is in the resolved build program', () => {
    const inBuild = programScripts(resolveConfig('tsconfig.build.json'));
    const leaked = INVENTORY.filter((n) => inBuild.has(n));
    expect(leaked, `would be emitted into dist: ${leaked.join(', ')}`).toEqual([]);
  });

  it('5 · the FULL programs differ by exactly the 42, in both directions', () => {
    // Compares complete normalized fileNames, not just src/scripts basenames.
    // The basename-only version passed even if an unrelated source file had
    // vanished from the build program, so it did not support the claim it made.
    const norm = (p: ts.ParsedCommandLine) =>
      new Set(p.fileNames.map((f) => f.replace(/\\/g, '/')));
    const tc = norm(resolveConfig('tsconfig.json'));
    const bd = norm(resolveConfig('tsconfig.build.json'));

    const expected = INVENTORY
      .map((n) => join(SERVER, `src/scripts/${n}.ts`).replace(/\\/g, '/'))
      .sort();

    const onlyTypecheck = [...tc].filter((f) => !bd.has(f)).sort();
    const onlyBuild = [...bd].filter((f) => !tc.has(f)).sort();

    expect(
      onlyTypecheck,
      'typecheck-minus-build must be exactly the 42 operator scripts',
    ).toEqual(expected);
    expect(
      onlyBuild,
      `build program contains file(s) the typecheck program does not: ${onlyBuild.join(', ')}`,
    ).toEqual([]);
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

      // importedFiles carries import/require/re-export/literal dynamic import.
      // referencedFiles carries `/// <reference path="…" />`, which TypeScript
      // also follows into the program — omitting it left a route by which an
      // emitted file could pull an excluded script back into dist.
      for (const ref of pre.importedFiles) {
        const r = ts.resolveModuleName(ref.fileName, file, bd.options, ts.sys, cache);
        const resolved = r.resolvedModule?.resolvedFileName;
        if (resolved && inventory.has(basename(resolved, '.ts'))
            && resolved.includes('/src/scripts/')) {
          edges.push(`${basename(file)} -import-> ${basename(resolved)}`);
        }
      }
      for (const ref of pre.referencedFiles) {
        // Triple-slash paths are file paths relative to the referencing file,
        // not module specifiers, so they are resolved directly.
        const resolved = join(file, '..', ref.fileName).replace(/\\/g, '/');
        if (resolved.includes('/src/scripts/')
            && inventory.has(basename(resolved, '.ts'))) {
          edges.push(`${basename(file)} -reference-> ${basename(resolved)}`);
        }
      }
    }
    expect(
      edges,
      `emitted code imports excluded operator script(s): ${edges.join(', ')}. ` +
        'The import re-includes them in dist, defeating the exclusion.',
    ).toEqual([]);
  });

  it('9 · tier 4/5 membership is COMPUTED from the import closure, not declared', () => {
    // Two rounds of hand-labelling produced two rounds of Codex LOWs: the first
    // scan saw only `prisma.<model>.write`, the second added raw SQL and still
    // missed service-mediated writes (scribeBackfillEmails -> backfillUserScribe
    // -> prisma.wikiPage.create). Hand-reading a file cannot answer "does this
    // reach a write", so the test computes it and the declared lists are only
    // the expected value of that computation.
    const cfg = resolveConfig('tsconfig.json');
    const cache = ts.createModuleResolutionCache(SERVER, (s) => s, cfg.options);
    const SRC = join(SERVER, 'src');
    const WRITE =
      /prisma\.[a-zA-Z]+\.(create|update|upsert|delete|deleteMany|updateMany|createMany)\b|\$executeRaw(Unsafe)?\s*[`(]/;

    const text = new Map<string, string>();
    const read = (f: string) => {
      if (!text.has(f)) {
        try { text.set(f, readFileSync(f, 'utf8')); } catch { text.set(f, ''); }
      }
      return text.get(f)!;
    };

    const reachesWrite = (name: string): boolean => {
      const seen = new Set<string>();
      const stack = [join(SRC, `scripts/${name}.ts`)];
      while (stack.length) {
        const f = stack.pop()!;
        if (seen.has(f)) continue;
        seen.add(f);
        const body = read(f);
        if (!body) continue;
        if (WRITE.test(body)) return true;
        const pre = ts.preProcessFile(body, true, true);
        for (const ref of [...pre.importedFiles, ...pre.referencedFiles]) {
          const r = ts.resolveModuleName(ref.fileName, f, cfg.options, ts.sys, cache);
          const rf = r.resolvedModule?.resolvedFileName;
          if (rf && rf.startsWith(SRC) && !rf.endsWith('.d.ts')) stack.push(rf);
        }
      }
      return false;
    };

    const candidates = [...TIER_4_PRODUCTION_WRITES, ...TIER_5_NO_WRITE_REACHABLE];
    const measuredWriters = candidates.filter(reachesWrite).sort();
    const measuredClean = candidates.filter((n) => !reachesWrite(n)).sort();

    expect(
      measuredWriters,
      'declared Tier 4 disagrees with measured write-reachability',
    ).toEqual([...TIER_4_PRODUCTION_WRITES].sort());
    expect(
      measuredClean,
      'a script declared write-free reaches a write, or vice versa',
    ).toEqual([...TIER_5_NO_WRITE_REACHABLE].sort());
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
