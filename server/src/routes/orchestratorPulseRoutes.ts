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
import { execFile } from 'child_process';
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

export default router;
