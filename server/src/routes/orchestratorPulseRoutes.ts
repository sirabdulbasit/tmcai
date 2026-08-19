/**
 * Orchestrator pulse — the build loop's live status, for the Health Check tab.
 *
 * Owner, 2026-08-12: *"orch pulse is being read by pulse.py --loop 15. what if we
 * build live dashboard in ?tab=health which shows me exact picture (same like orch
 * pulse window) with good graphics? the dashboard should be live as orch pulse"*.
 *
 *   GET /orchestrator/pulse   → the same snapshot the terminal window draws
 *
 * THE STAGE IS NOT RE-DERIVED HERE. This endpoint shells out to
 * `scripts/orchestrator/pulse.py --json`, which is the same collector the terminal
 * window renders. Detecting BUILDING/REVIEWING/STALLED is subtle work that has
 * already been got wrong twice in that file's history — an IDE window counted as a
 * 16-hour build turn, the Codex editor extension counted as a review — and both
 * times the cause was a rule that existed in two copies. A TypeScript
 * reimplementation would be a third copy. One detector, two renderers.
 *
 * Admin-only: it exposes internal build state (session ids, model names, agent
 * output lines), which no tenant user has any business reading.
 */
import { Router, Request, Response } from 'express';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { requireAdmin } from '../middleware/auth';

const router = Router();

// dist/routes/…js and src/routes/…ts both sit two levels under `server/`, so this
// resolves to the repo root in production and in dev alike. Overridable for a box
// that checks the repo out somewhere else.
export const PULSE_SCRIPT =
  process.env.ORCH_PULSE_SCRIPT ||
  path.resolve(__dirname, '../../..', 'scripts/orchestrator/pulse.py');

const PYTHON = process.env.ORCH_PULSE_PYTHON || 'python3';
// The browser polls every few seconds and there can be more than one tab open.
// One python process per window of this length, shared by every caller.
const CACHE_MS = 3_000;
const TIMEOUT_MS = 20_000;

type Cached = { at: number; payload: unknown };
let cache: Cached | null = null;
let inflight: Promise<unknown> | null = null;

function readPulse(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON,
      [PULSE_SCRIPT, '--json'],
      { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message).trim().split('\n').slice(-3).join(' · ');
          reject(new Error(tail || 'pulse.py failed'));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('pulse.py did not return JSON'));
        }
      },
    );
  });
}

/** Cached read, with concurrent callers coalesced onto one process. */
export async function getPulse(): Promise<{ payload: unknown; cacheAgeMs: number }> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) {
    return { payload: cache.payload, cacheAgeMs: now - cache.at };
  }
  if (!inflight) {
    inflight = readPulse()
      .then((payload) => {
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  const payload = await inflight;
  return { payload, cacheAgeMs: Date.now() - (cache?.at ?? now) };
}

router.get('/pulse', requireAdmin, async (_req: Request, res: Response) => {
  // no-store, always. A cached pulse frame served by a proxy is a status display
  // showing the past while claiming to be live — the precise failure the terminal
  // window was built to end.
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!fs.existsSync(PULSE_SCRIPT)) {
    res.status(503).json({
      error: 'orchestrator pulse script not found on this host',
      script: PULSE_SCRIPT,
    });
    return;
  }
  try {
    const { payload, cacheAgeMs } = await getPulse();
    res.json({ ...(payload as object), served_at: Date.now() / 1000, cache_age_ms: cacheAgeMs });
  } catch (err: any) {
    // Never fall back to the last good frame: the dashboard has to be able to say
    // "I could not read the pulse" instead of quietly showing a stale one as live.
    res.status(502).json({ error: `could not read the pulse: ${err.message}` });
  }
});

/**
 * POST /orchestrator/heal — start a conversational healing pulse now.
 *
 * Owner, 2026-08-19: he wanted the manual trigger on the Brain Evolution deck rather than
 * having to reach a shell. This runs the same heal-now.sh a human would run, which runs the
 * same watch-conversations.sh the cron runs — one implementation, three callers, so the
 * button cannot drift from the schedule.
 *
 * SECURITY, and the reasons rather than the assertions:
 *  • requireAdmin, like the pulse read above: this spends money and writes to production.
 *  • execFile with a FIXED argv and no shell. Nothing from the request reaches a command
 *    line — `force` and `capability` are the only inputs, and both are validated below,
 *    because a capability name interpolated into a shell is a command-injection hole on a
 *    box that deploys to production.
 *  • `capability` is checked against the nine names, not sanitised. An allow-list cannot be
 *    escaped; a sanitiser can.
 *  • detached + unref: a healing pulse takes ~15 minutes and must not be tied to the
 *    lifetime of an HTTP request. The response says "started", never "finished" — claiming
 *    a result we have not observed is the exact class this deck exists to expose.
 */
const NINE_CAPABILITIES = new Set([
  'Simple & Smart', 'Thinking', 'Memory', 'Accurate Communication',
  'Authorized Action', 'Self Follow-Up', 'Learn', 'Self-Healing', 'Self-Pruning',
]);

export const HEAL_SCRIPT =
  process.env.ORCH_HEAL_SCRIPT ||
  path.resolve(__dirname, '../../..', 'scripts/orchestrator/heal-now.sh');

router.post('/heal', requireAdmin, (req: Request, res: Response) => {
  if (!fs.existsSync(HEAL_SCRIPT)) {
    res.status(503).json({ error: 'heal script not found on this host', script: HEAL_SCRIPT });
    return;
  }
  const args: string[] = [HEAL_SCRIPT];
  // heal-now.sh forces the READ by default now, so `force` from the UI means the stronger
  // thing: build even when the ranking has not moved. Owner, 2026-08-20: a click that
  // returned in a second and changed nothing on screen read as a dead button.
  if (req.body?.force === true) args.push('--build-anyway');
  const cap = typeof req.body?.capability === 'string' ? req.body.capability.trim() : '';
  if (cap) {
    if (!NINE_CAPABILITIES.has(cap)) {
      res.status(400).json({ error: `not one of the nine capabilities: ${cap}` });
      return;
    }
    args.push(cap);
  }

  // spawn, not execFile: only spawn takes `detached`, and a 15-minute pulse must outlive
  // the request. stdio ignored — the pulse writes its own logs, and buffering its output
  // here would tie a long build to this process's memory for no reader.
  const child = spawn('/bin/bash', args, { detached: true, stdio: 'ignore' });
  child.unref();
  res.json({
    started: true,
    force: req.body?.force === true,
    capability: cap || null,
    // Said plainly because the deck must never imply an outcome it has not seen: this
    // confirms the pulse was LAUNCHED. Whether it fixes anything shows up in the phases,
    // the token table and the symptom list, minutes later.
    // The client no longer renders this; the phases are the answer. It stays for anyone
    // calling the route directly, and it no longer says the pulse "may decline to build" —
    // heal-now.sh now runs with NEXEO_WATCH_MANUAL=1, which waives the daily auto-build cap
    // and the hourly spacing. A click on a day that had used its four auto-builds used to
    // run the analysis and skip the build, which is indistinguishable from doing nothing.
    note: 'pulse started',
  });
});

export default router;
