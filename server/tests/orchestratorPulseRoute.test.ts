import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// GET /orchestrator/pulse — the build loop's live status, feeding the Brain build
// pulse panel on ?tab=health.
//
// Two things have to hold and neither is obvious from reading the route:
//   1. it is admin-only, and a non-admin must be refused BEFORE anything is run
//      on the host — the payload carries session ids, model names and raw agent
//      output lines;
//   2. it must never answer with a stale frame when the read fails. The whole
//      point of the pulse is that a stalled loop cannot look like a working one,
//      and an endpoint that quietly re-serves the last good snapshot would
//      reintroduce exactly that.
//
// The last test is a contract test against the real `pulse.py --json`: the panel
// reads `stage.name`, `phases[].state`, `capabilities[]` and `trend.rows[]` by
// name, so a rename inside the collector has to fail here rather than in the
// browser.

const execFileMock = vi.fn();
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return { ...actual, execFile: (...args: any[]) => execFileMock(...args) };
});

const FRAME = {
  now: 1786540905.5,
  pkt_offset: 18000,
  stage: { name: 'BUILDING', elapsed: 993, basis: 'process', detail: 'claude -p' },
  phases: [{ name: 'Build & Deploy', seat: 'Claude -> production', state: 'running', duration: 994, current: true }],
  capabilities: [{ name: 'Memory', nexeo: 60, professional: 92, delta: 0 }],
  trend: { iterations: [1, 2], rows: [], unmoved: [] },
};

/** A fresh module instance, so the 3s response cache never leaks between tests. */
async function freshApp(isAdmin: boolean) {
  vi.resetModules();
  const mod = await import('../src/routes/orchestratorPulseRoutes');
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { id: 1, clientNumber: 'tmc', isAdmin };
    next();
  });
  app.use('/orchestrator', mod.default);
  return { app, PULSE_SCRIPT: mod.PULSE_SCRIPT };
}

function resolveWith(payload: unknown) {
  execFileMock.mockImplementation((_py: string, _args: string[], _opts: any, cb: any) => {
    cb(null, JSON.stringify(payload), '');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /orchestrator/pulse', () => {
  it('refuses a non-admin without running anything on the host', async () => {
    resolveWith(FRAME);
    const { app } = await freshApp(false);
    const res = await request(app).get('/orchestrator/pulse');
    expect(res.status).toBe(403);
    // The gate is the point: no python process for a caller who may not see this.
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns the collector frame to an admin, stamped with its own freshness', async () => {
    resolveWith(FRAME);
    const { app } = await freshApp(true);
    const res = await request(app).get('/orchestrator/pulse');
    expect(res.status).toBe(200);
    expect(res.body.stage).toEqual(FRAME.stage);
    expect(res.body.phases[0].state).toBe('running');
    expect(typeof res.body.served_at).toBe('number');
    expect(typeof res.body.cache_age_ms).toBe('number');
    // A proxy caching a pulse frame is a status display showing the past.
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('invokes pulse.py in --json mode, never the terminal renderer', async () => {
    resolveWith(FRAME);
    const { app, PULSE_SCRIPT } = await freshApp(true);
    await request(app).get('/orchestrator/pulse');
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual([PULSE_SCRIPT, '--json']);
  });

  it('coalesces concurrent readers onto one python process', async () => {
    let calls = 0;
    execFileMock.mockImplementation((_py: string, _args: string[], _opts: any, cb: any) => {
      calls += 1;
      setTimeout(() => cb(null, JSON.stringify(FRAME), ''), 10);
    });
    const { app } = await freshApp(true);
    const all = await Promise.all([
      request(app).get('/orchestrator/pulse'),
      request(app).get('/orchestrator/pulse'),
      request(app).get('/orchestrator/pulse'),
    ]);
    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls).toBe(1);
  });

  it('reports a failed read as an error instead of re-serving the last good frame', async () => {
    resolveWith(FRAME);
    const { app } = await freshApp(true);
    const ok = await request(app).get('/orchestrator/pulse');
    expect(ok.status).toBe(200);

    // Past the cache window, with the collector now failing. A stale frame served
    // as live is the failure the pulse exists to prevent.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 10_000);
      execFileMock.mockImplementation((_py: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('exit 1'), '', 'Traceback: boom');
      });
      const bad = await request(app).get('/orchestrator/pulse');
      expect(bad.status).toBe(502);
      expect(bad.body.error).toContain('could not read the pulse');
      expect(bad.body.stage).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so plainly when the script is not on this host', async () => {
    vi.resetModules();
    process.env.ORCH_PULSE_SCRIPT = '/nonexistent/pulse.py';
    try {
      const mod = await import('../src/routes/orchestratorPulseRoutes');
      const app = express();
      app.use((req: any, _res, next) => { req.user = { isAdmin: true }; next(); });
      app.use('/orchestrator', mod.default);
      const res = await request(app).get('/orchestrator/pulse');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not found/i);
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.ORCH_PULSE_SCRIPT;
    }
  });
});

describe('pulse.py --json contract (what the dashboard reads by name)', () => {
  const script = path.resolve(__dirname, '../..', 'scripts/orchestrator/pulse.py');

  it('emits the fields the panel renders', () => {
    if (!fs.existsSync(script)) {
      throw new Error(`the collector the dashboard depends on is missing: ${script}`);
    }
    const out = execFileSync('python3', [script, '--json'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    const d = JSON.parse(out);

    expect(typeof d.now).toBe('number');
    expect(typeof d.pkt_offset).toBe('number');
    expect(typeof d.stage.name).toBe('string');
    expect(['process', 'transcript', 'logfile', 'process+cold transcript', 'none'])
      .toContain(d.stage.basis);
    expect(typeof d.loop_alive).toBe('boolean');

    // Two pulse kinds, two phase lists (pulse.py, owner 2026-08-18): a
    // conversational pulse reads the new turns and ships a fix — it does not
    // score, measure or review, so those rows would read as a stalled pulse.
    // The kind comes from state/pulse-mode, so the contract is pinned against
    // the mode the collector itself reports rather than whichever mode this
    // box is in when the suite runs. Phases stay in loop order, each in one of
    // four states — done and abandoned must never collapse into one another.
    expect(['conversational', 'evaluation']).toContain(d.pulse_mode);
    expect(d.phases.map((p: any) => p.name)).toEqual(
      d.pulse_mode === 'conversational'
        ? ['Chat Analysis', 'Build & Deploy']
        : [
          'Capability Evaluation',
          'Chat Analysis',
          'Build & Deploy',
          'Check & Measure',
          'Review Capabilities',
        ],
    );
    for (const p of d.phases) {
      expect(['running', 'done', 'abandoned', 'pending']).toContain(p.state);
      expect(typeof p.seat).toBe('string');
      if (p.state === 'pending') expect(p.duration).toBeNull();
      else expect(typeof p.duration).toBe('number');
    }

    expect(Array.isArray(d.capabilities)).toBe(true);
    for (const c of d.capabilities) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.nexeo).toBe('number');
      expect(typeof c.professional).toBe('number');
    }

    // THE TOTAL MUST BE THE EXACT MEAN OF THE CAPABILITIES IT IS SERVED WITH.
    //
    // Owner, 2026-08-31: "recalculate total score". Nothing was stale — the figure is
    // derived on every collect — but it was rounded to ONE decimal, and after the
    // nine-to-eight merge the professional mean is 738/8 = 92.25, which lands exactly on
    // a half. Python rounds half to EVEN, so the deck served 92.2 and a gap of 38.7 while
    // brain_evaluation_chart.md recorded 92.25 and 38.75: the UI and the documents
    // disagreeing about one number, with nothing watching.
    //
    // Asserted against the capabilities in the SAME frame rather than against literals,
    // so this stays true as scores move and as the capability count changes again.
    if (d.brain && d.capabilities.length > 0) {
      const n = d.capabilities.length;
      const meanNexeo = d.capabilities.reduce((s: number, c: any) => s + c.nexeo, 0) / n;
      const meanPro = d.capabilities.reduce((s: number, c: any) => s + c.professional, 0) / n;
      // Tight tolerance: this is a rounding guard, so it has to fail on a 0.05 slip.
      expect(d.brain.nexeo).toBeCloseTo(meanNexeo, 2);
      expect(d.brain.professional).toBeCloseTo(meanPro, 2);
      expect(d.brain.gap).toBeCloseTo(meanPro - meanNexeo, 2);
    }
    expect(Array.isArray(d.trend.iterations)).toBe(true);
    expect(Array.isArray(d.trend.rows)).toBe(true);
    expect(Array.isArray(d.trend.unmoved)).toBe(true);
    for (const r of d.trend.rows) {
      expect(r.series.length).toBe(d.trend.iterations.length);
      expect(typeof r.overall).toBe('boolean');
    }
    expect(Array.isArray(d.history)).toBe(true);
  });

  it('renders the terminal window from that same frame — one detector, two views', () => {
    const out = execFileSync('python3', [script, '--plain'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    // The window still draws. This is the guard on the collect/render split: the
    // browser dashboard must not be able to break the owner's terminal window.
    expect(out).toMatch(/Iteration #/);
    expect(out).toMatch(/Build & Deploy:/);
  });
});
