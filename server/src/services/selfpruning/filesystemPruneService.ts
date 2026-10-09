/**
 * filesystemPruneService — ASPECT 1 of Self-Pruning, made continuous.
 *
 * Owner, 2026-10-09: *"so now i want you to keep your self pruning from sizes,
 * files, db etc"* — i.e. stop auditing on request and start pruning on a clock.
 *
 * WHAT WAS ACTUALLY MISSING, measured rather than assumed. `centralCleanupGovernor`
 * already owns eleven autonomous cleanup tasks and every one of them is a DATABASE
 * concern (context memory, open items, system logs, idempotency, tokens, contacts,
 * memory decay, archives, wiki, feed events). So aspect 3 was largely covered and
 * ASPECT 1 — the filesystem — had NO owner at all. Nothing pruned a cache, a
 * superseded binary or a leaked temp directory, and nothing watched free space. The
 * box reached 93% full and the first thing that noticed was the owner's eye.
 *
 * This is a DOMAIN WORKER, not a second governor. The governor owns cadence,
 * ordering, isolation, observability and the durable lease; this file owns only
 * "which bytes are safe to remove, and how do I prove it before removing them".
 * Registering a twelfth task there is one owner per concern; a parallel scheduler
 * here would be the eleventh `protection-with-two-implementations` in this codebase.
 *
 * ── WHY IT IS A WHITELIST AND NOT A HEURISTIC ────────────────────────────────
 *
 * Every family below was reclaimed by hand on 2026-10-04/05 and each one had a
 * guard that caught a real mistake:
 *   * "all 2,733 wa-mig dirs are empty" — 1,822 held WhatsApp SESSION data. Class 4.
 *   * "the pnpm store is shared" — all 38,541 files were nlink=1, an orphan.
 *   * "these four vscode trees are in use" — a `ps` grep matched its own command
 *     line; /proc said only one was live.
 * A heuristic that scores paths by age and size would have deleted the session
 * directories. So nothing is removed unless its family's `guard` returns true for
 * that specific path, and a guard that throws is treated as "not safe".
 *
 * ── AND WHY IT IS DRY-RUN BY DEFAULT ─────────────────────────────────────────
 *
 * Same principle the digest switch carries: deleting takes consent. The sweep
 * MEASURES on every tick and reports what it would free; it removes nothing until
 * `selfpruning.filesystem_prune_enabled` is 1. The measurement alone is worth the
 * tick, because it is also what raises the disk-pressure finding.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import createLogger from '../../utils/logger';

const log = createLogger('filesystem-prune');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Free-space fraction below which the sweep raises a health finding. */
export const DISK_PRESSURE_THRESHOLD = 0.15;

export interface PruneCandidate {
  path: string;
  bytes: number;
}

export interface PruneFamily {
  id: string;
  description: string;
  /** Absolute directory whose direct children are the candidates. */
  parent: string;
  /** Child-name test. Keep it narrow; a broad match is how a sweep eats a product. */
  match: (name: string) => boolean;
  /** Never remove a child younger than this. */
  minAgeDays: number;
  /** Always retain this many newest children, however old the rest are. */
  keepNewest: number;
  /**
   * The proof. Returns true only when THIS path is provably safe to remove.
   * A guard that throws means "not safe" — never "assume yes".
   */
  guard: (p: string) => Promise<boolean>;
}

/** Every file under `p` has a link count of exactly 1, so nothing else shares it. */
async function noHardLinksElsewhere(p: string): Promise<boolean> {
  const out = await run('find', [p, '-type', 'f', '-links', '+1']);
  return out.trim() === '';
}

/** No running process names `p` in its cmdline, cwd or exe. */
async function notReferencedByAnyProcess(p: string): Promise<boolean> {
  const base = path.basename(p);
  // grep -l over /proc/*/cmdline rather than `ps`: a `ps | grep` matches its OWN
  // command line, which on 2026-10-05 reported all five vscode trees "in use"
  // when four were referenced by nothing.
  const cmd = await run('bash', ['-c',
    `cat /proc/*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -c -- ${JSON.stringify(base)} || true`]);
  const exe = await run('bash', ['-c',
    `ls -l /proc/*/exe /proc/*/cwd 2>/dev/null | grep -c -- ${JSON.stringify(base)} || true`]);
  return Number(cmd.trim() || 0) === 0 && Number(exe.trim() || 0) === 0;
}

/** The directory is empty — the only guard under which removing it cannot lose data. */
async function isEmptyDir(p: string): Promise<boolean> {
  const entries = await fs.readdir(p);
  return entries.length === 0;
}

/**
 * THE FAMILIES. Each is here because it was verified by hand, and each carries the
 * guard that verified it.
 *
 * DELIBERATELY ABSENT:
 *  * /tmp/nexeo-dist-backup-* — already retained by deploy.sh (keep newest 3,
 *    commit 33f22f1). Adding it here would be two owners for one concern.
 *  * /root/.claude/projects and /tmp/claude-0/* — session transcripts and other
 *    sessions' scratch. Not this box's to sweep; a shared-resource decision.
 *  * /var/www/sdf/**  — another application, another unix user, consent never given.
 *  * ms-playwright — the headless shell IS the binary that runs.
 */
export const PRUNE_FAMILIES: PruneFamily[] = [
  {
    id: 'npx_stale',
    description: 'npx package caches unused for 30 days; npx refetches on demand',
    parent: '/root/.npm/_npx',
    match: () => true,
    minAgeDays: 30,
    keepNewest: 0,
    guard: async () => true, // age is the whole safety story: a cache, by definition
  },
  {
    id: 'vscode_superseded_servers',
    description: 'VS Code server trees no process references; re-downloaded on connect',
    parent: '/root/.vscode/cli/servers',
    match: (n) => n.startsWith('Stable-'),
    minAgeDays: 7,
    keepNewest: 1,
    guard: notReferencedByAnyProcess,
  },
  {
    id: 'pnpm_store_orphan',
    description: 'pnpm content store with no remaining hardlinks into any project',
    parent: '/root/.local/share/pnpm',
    match: (n) => n === 'store',
    minAgeDays: 14,
    keepNewest: 0,
    guard: noHardLinksElsewhere,
  },
  {
    id: 'wa_mig_empty',
    description: 'Leaked WhatsApp-migration temp dirs that are EMPTY — the ones holding session-* are Class 4 and never touched',
    parent: '/tmp',
    match: (n) => n.startsWith('wa-mig-'),
    minAgeDays: 7,
    keepNewest: 0,
    guard: isEmptyDir,
  },
];

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout ?? ''))));
  });
}

async function dirBytes(p: string): Promise<number> {
  try {
    const out = await run('du', ['-xsb', p]);
    return Number(out.split(/\s+/)[0] || 0);
  } catch { return 0; }
}

export interface DiskState { totalBytes: number; freeBytes: number; freeFraction: number }

export async function diskState(mount = '/'): Promise<DiskState> {
  const out = await run('df', ['-B1', '--output=size,avail', mount]);
  const line = out.trim().split('\n').pop() || '';
  const [size, avail] = line.trim().split(/\s+/).map(Number);
  const totalBytes = size || 0;
  const freeBytes = avail || 0;
  return { totalBytes, freeBytes, freeFraction: totalBytes ? freeBytes / totalBytes : 1 };
}

export interface FamilyResult {
  id: string;
  candidates: number;
  guardRefused: number;
  bytes: number;
  removed: number;
  paths: string[];
}

/**
 * Find what each family could free. Pure measurement — removes nothing.
 */
export async function planPrune(
  now: number,
  /** Injectable so the guards can be tested without a real /tmp — the guards ARE
   *  the safety story, so they must be exercisable in isolation. */
  families: PruneFamily[] = PRUNE_FAMILIES,
): Promise<FamilyResult[]> {
  const results: FamilyResult[] = [];
  for (const fam of families) {
    const r: FamilyResult = { id: fam.id, candidates: 0, guardRefused: 0, bytes: 0, removed: 0, paths: [] };
    let names: string[];
    try {
      names = (await fs.readdir(fam.parent)).filter(fam.match);
    } catch {
      results.push(r); // parent absent on this box: not an error, just nothing to do
      continue;
    }
    const stated: Array<{ p: string; mtime: number }> = [];
    for (const n of names) {
      const p = path.join(fam.parent, n);
      try { stated.push({ p, mtime: (await fs.stat(p)).mtimeMs }); } catch { /* vanished */ }
    }
    // Newest first, so keepNewest protects the newest and not an arbitrary N.
    stated.sort((a, b) => b.mtime - a.mtime);
    const eligible = stated.slice(fam.keepNewest)
      .filter((s) => now - s.mtime >= fam.minAgeDays * DAY_MS);
    r.candidates = eligible.length;
    for (const { p } of eligible) {
      let ok = false;
      try { ok = await fam.guard(p); } catch (e: any) {
        // A guard that cannot answer is a NO. This is the direction that keeps
        // a broken `find` from becoming a deletion.
        log.warn('guard failed; treating as unsafe', { family: fam.id, path: p, error: e?.message });
        ok = false;
      }
      if (!ok) { r.guardRefused += 1; continue; }
      r.bytes += await dirBytes(p);
      r.paths.push(p);
    }
    results.push(r);
  }
  return results;
}

/**
 * Measure, and remove only when the owner has switched it on.
 *
 * Returns the plan either way, so a dry tick is still useful evidence — it is what
 * tells the scorer, and the owner, what Self-Pruning aspect 1 is holding.
 */
export async function runFilesystemPrune(opts: {
  now: number;
  apply: boolean;
  clientNumber?: string;
  families?: PruneFamily[];
}): Promise<{ disk: DiskState; families: FamilyResult[]; freedBytes: number; applied: boolean }> {
  const disk = await diskState('/');
  const families = await planPrune(opts.now, opts.families);
  let freedBytes = 0;

  if (opts.apply) {
    for (const fam of families) {
      for (const p of fam.paths) {
        try {
          const before = await dirBytes(p);
          await fs.rm(p, { recursive: true, force: true });
          fam.removed += 1;
          freedBytes += before;
        } catch (e: any) {
          log.warn('removal failed; leaving it', { path: p, error: e?.message });
        }
      }
    }
  }

  const plannedBytes = families.reduce((s, f) => s + f.bytes, 0);
  log.info(opts.apply ? 'filesystem prune applied' : 'filesystem prune measured (dry run)', {
    freeFraction: Number(disk.freeFraction.toFixed(3)),
    plannedBytes, freedBytes,
    families: families.map((f) => `${f.id}:${f.candidates}c/${f.guardRefused}refused/${f.removed}rm`).join(' '),
  });

  // RUNG 1 OF SELF-HEALING: notice our own condition without being asked. The box
  // hit 93% on 2026-10-04 and nothing in the product knew. A finding is the only
  // mechanism here that reaches a human.
  if (disk.freeFraction < DISK_PRESSURE_THRESHOLD && opts.clientNumber) {
    try {
      const { recordFinding } = await import('../selfheal/healthFindingService');
      const pct = (disk.freeFraction * 100).toFixed(1);
      const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)}G`;
      await recordFinding({
        clientNumber: opts.clientNumber,
        kind: 'disk_pressure',
        severity: 'warn',
        source: 'filesystem-prune',
        summary: `Disk is ${pct}% free (${gb(disk.freeBytes)} of ${gb(disk.totalBytes)}); `
          + `self-pruning can reclaim ${gb(plannedBytes)} from ${families.reduce((s, f) => s + f.paths.length, 0)} verified paths`,
        evidence: {
          freeFraction: disk.freeFraction, plannedBytes, applied: opts.apply,
          families: families.map((f) => ({ id: f.id, candidates: f.candidates, guardRefused: f.guardRefused, bytes: f.bytes })),
        },
      });
    } catch (e: any) {
      log.warn('could not record the disk-pressure finding', { error: e?.message });
    }
  }

  return { disk, families, freedBytes, applied: opts.apply };
}
