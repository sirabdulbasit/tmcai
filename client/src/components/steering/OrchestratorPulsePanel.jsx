/**
 * OrchestratorPulsePanel — the orch pulse window, live in the browser.
 *
 * Owner, 2026-08-12: *"orch pulse is being read by pulse.py --loop 15. what if we
 * build live dashboard in ?tab=health which shows me exact picture (same like orch
 * pulse window) with good graphics? the dashboard should be live as orch pulse"*.
 *
 * Every number here comes from `GET /orchestrator/pulse`, which is
 * `scripts/orchestrator/pulse.py --json` — the same collector the terminal window
 * renders. This file draws; it never decides. Nothing is inferred here about what
 * is running, because a second stage detector is how that file already got it
 * wrong twice.
 *
 * TWO CLOCKS, ONE TRUTH. Polling every 5s would leave the timers frozen for 5s at
 * a stretch, which reads as a hung loop. So the running timers count up locally
 * from the frame's own epoch (`data.now` anchored to the moment it arrived) and
 * are corrected on every poll. A locally-advanced timer can drift by at most one
 * poll interval and is always pulled back to the server's figure — it can never
 * invent progress, because the phase's STATE only ever changes on a real frame.
 *
 * When the poll fails the last frame stays on screen but visibly dims and the
 * header says so. Showing a stale frame as live is the precise failure the pulse
 * exists to prevent.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../services/api';
import { Button, Card } from '../ui';
import { Icon } from '../ui/Icon';
import './OrchestratorPulsePanel.css';

const POLL_MS = 5_000;

// Stage colours match the terminal window's own, so the mental map transfers.
// Each is paired with its word and a dot — never colour alone.
const STAGE_COLOR = {
  BUILDING: 'var(--op-build)',
  CHECKS: 'var(--op-checks)',
  MEASURING: 'var(--op-measure)',
  REVIEWING: 'var(--op-review)',
  SCORING: 'var(--op-score)',
  STALLED: 'var(--op-stalled)',
  IDLE: 'var(--op-idle)',
};
const PHASE_COLOR = {
  Build: 'var(--op-build)',
  Checks: 'var(--op-checks)',
  Measure: 'var(--op-measure)',
  Review: 'var(--op-review)',
  Score: 'var(--op-score)',
};
const VERDICT_COLOR = {
  SOUND: 'var(--op-score)',
  WEAK: 'var(--op-measure)',
  WRONG: 'var(--op-stalled)',
};

const nowSec = () => Date.now() / 1000;

// Same shape the terminal prints, so a screenshot of either can be compared to
// the other without translating units.
function fmtDur(s) {
  if (s == null) return '—';
  const n = Math.max(0, Math.floor(s));
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m${String(n % 60).padStart(2, '0')}s`;
  return `${Math.floor(n / 3600)}h${String(Math.floor((n % 3600) / 60)).padStart(2, '0')}m`;
}

// Wall clocks render in the OWNER'S zone and say so, exactly as pulse.py does —
// the box runs UTC, the owner is Asia/Karachi, and an unlabeled clock in the wrong
// zone reads as a lie. The offset travels in the payload rather than being
// hardcoded twice.
function pkt(epoch, offset, withDate = false) {
  if (!epoch) return 'unknown';
  const iso = new Date((epoch + offset) * 1000).toISOString();
  return `${withDate ? `${iso.slice(0, 10)} ` : ''}${iso.slice(11, 19)} PKT`;
}

function DeltaChip({ value, className = '' }) {
  const v = Number(value ?? 0);
  const tone = v > 0 ? 'up' : v < 0 ? 'down' : '';
  // The sign is printed, so the movement is readable without the colour.
  return (
    <span className={`orch-delta ${tone} ${className}`}>
      {v > 0 ? `+${v}` : v === 0 ? '0' : `${v}`}
    </span>
  );
}

/* One aspect of the loop, framed. The hint doubles as the card's only control
   when it's given a handler — a card with two buttons in a deck this dense starts
   competing with the data for attention. */
function PulseCard({ title, hint, onHintClick, className = '', children }) {
  return (
    <section className={`orch-card ${className}`}>
      <header className="orch-card-head">
        <h3 className="orch-card-title">{title}</h3>
        {hint && (onHintClick
          ? <button type="button" className="orch-card-hint is-button" onClick={onHintClick}>{hint}</button>
          : <span className="orch-card-hint">{hint}</span>)}
      </header>
      <div className="orch-card-body">{children}</div>
    </section>
  );
}

/* ── phase timeline ──────────────────────────────────────────────────────────
   Bars encode DURATION — one quantity, so one hue and one axis. Widths are
   proportional to the longest phase in this iteration, which is what makes "the
   build took four times the review" visible at a glance. Every bar also prints
   its own duration, so the chart never has to be measured by eye. */
function PhaseTimeline({ data, liveNow }) {
  const durOf = (p) =>
    p.state === 'running' && p.start ? Math.max(0, liveNow - p.start) : p.duration;
  const max = Math.max(1, ...data.phases.map((p) => durOf(p) ?? 0));

  return (
    <div>
      {data.phases.map((p) => {
        const dur = durOf(p);
        const pct = dur ? Math.max(2, (dur / max) * 100) : 0;
        const word = p.state === 'running' ? (p.name === 'Build' ? 'Building' : 'Running') : null;
        const title = [
          p.start ? `start ${pkt(p.start, data.pkt_offset)}` : null,
          p.end ? `end ${pkt(p.end, data.pkt_offset)}` : null,
          p.detail || null,
        ].filter(Boolean).join(' · ');

        return (
          <div className="orch-phase" key={p.name} title={title || undefined}>
            <div className="orch-phase-name">{p.name}</div>
            <div className="orch-phase-track">
              {pct > 0 && (
                <div
                  className={`orch-phase-fill ${
                    p.state === 'running' ? 'is-running' : p.state === 'abandoned' ? 'is-abandoned' : ''
                  }`}
                  style={{ width: `${pct}%`, '--phase-color': PHASE_COLOR[p.name] }}
                />
              )}
            </div>
            <div className="orch-phase-state">
              {p.state === 'running' && (
                <>
                  <span style={{ color: PHASE_COLOR[p.name], fontWeight: 'var(--fw-semibold)' }}>{word}</span>
                  <span className="orch-phase-dur">{fmtDur(dur)}</span>
                  {p.current && <span style={{ color: 'var(--op-measure)' }}>· Current</span>}
                </>
              )}
              {p.state === 'done' && (
                <>
                  <span style={{ color: 'var(--op-score)' }}>done</span>
                  <span className="orch-phase-dur">{fmtDur(dur)}</span>
                </>
              )}
              {p.state === 'abandoned' && (
                // Never "done": an abandoned phase and a completed one must not
                // look alike.
                <span style={{ color: 'var(--op-stalled)' }}>
                  started {fmtDur(dur)} ago, no completion recorded
                </span>
              )}
              {p.state === 'pending' && <span className="orch-phase-empty">—</span>}
            </div>
            <div className="orch-phase-seat">
              {p.seat}
              {p.model ? ` · ${p.model}` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── capability vs professional ──────────────────────────────────────────────
   One bar per capability on a fixed 0→100 axis, with the professional benchmark
   as a reference marker on the same axis — not a second bar and never a second
   scale. Value, benchmark and movement are all direct-labeled, so the bars are
   the summary and the numbers are the source. */
function CapabilityBars({ data }) {
  const caps = data.capabilities;
  const brain = data.brain;
  if (!caps.length || !brain) return null;

  return (
    // A flex column, so the pinned BRAIN summary reaches the BOTTOM of the card
    // rather than the bottom of the bar list — on a 1080p screen the first version
    // left it floating in the middle of the card with dead space beneath it.
    <div className="orch-caps-wrap">
      {caps.map((c) => (
        <div className="orch-cap" key={c.name} title={`${c.name}: Nexeo ${c.nexeo} · professional ${c.professional} · gap ${Math.round((c.professional - c.nexeo) * 10) / 10}`}>
          <div className="orch-cap-name">{c.name}</div>
          <div className="orch-cap-val">{c.nexeo}</div>
          <div className="orch-cap-track">
            <div className="orch-cap-fill" style={{ width: `${Math.min(100, Math.max(0, c.nexeo))}%` }} />
            <div className="orch-cap-mark" style={{ left: `calc(${Math.min(100, Math.max(0, c.professional))}% - 1px)` }} />
          </div>
          <div className="orch-cap-pro">{c.professional}</div>
          <DeltaChip value={c.delta} />
        </div>
      ))}
      <div className="orch-brain">
        <div>
          <div className="orch-brain-num">{brain.nexeo}</div>
          <div className="orch-brain-lab">BRAIN overall</div>
        </div>
        <div className="orch-brain-lab">
          vs professional <b>{brain.professional}</b>
        </div>
        <div className="orch-brain-lab">
          gap <b>{brain.gap}</b>
        </div>
        <div className="orch-brain-lab">
          move <DeltaChip value={brain.move} />
        </div>
        <div className="orch-brain-lab" style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>
          scored by {brain.scored_by}
        </div>
      </div>
    </div>
  );
}

/* ── trend, iteration-wise ───────────────────────────────────────────────────
   One line, so no legend box — the title names the series. The y-axis is scaled to
   the series' own range with the endpoints direct-labeled, because the movement
   this loop produces is fractions of a point and a 0→100 axis would render ten
   iterations of real work as a flat line. The absolute numbers are printed at both
   ends so the scaling cannot overstate what happened. */
function TrendLine({ iterations, series, height = 132 }) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const W = 100; // viewBox units — the SVG scales to its container width
  const padT = 10;
  const padB = 18;

  const pts = useMemo(() => {
    const real = series.filter((v) => v != null);
    if (real.length < 2) return null;
    const lo = Math.min(...real);
    const hi = Math.max(...real);
    const span = hi - lo || 1;
    const inner = height - padT - padB;
    // Inset so the first and last marks don't sit on the frame's own edge.
    const x0 = 1.5;
    const xw = W - 3;
    return series.map((v, i) => ({
      i,
      iteration: iterations[i],
      v,
      x: series.length === 1 ? W / 2 : x0 + (i / (series.length - 1)) * xw,
      y: v == null ? null : padT + inner - ((v - lo) / span) * inner,
    }));
  }, [iterations, series, height]);

  if (!pts) return null;
  const drawn = pts.filter((p) => p.y != null);
  const path = drawn.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const area = `${path} L${drawn[drawn.length - 1].x.toFixed(2)},${height - padB} L${drawn[0].x.toFixed(2)},${height - padB} Z`;
  const last = drawn[drawn.length - 1];

  const onMove = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - box.left) / box.width) * W;
    let best = drawn[0];
    for (const p of drawn) if (Math.abs(p.x - rel) < Math.abs(best.x - rel)) best = p;
    setHover({ ...best, px: (best.x / W) * box.width, py: (best.y / height) * box.height });
  };

  return (
    <div className="orch-trend-chart" ref={wrapRef}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        /* Height comes from the card's spare room, not from a constant: in a deck
           that must fit one screen, the chart is the element that can shrink
           without losing its meaning — its endpoints are labeled in the card head
           — so it yields space to the sparklines and the never-moved line rather
           than pushing them out of sight. */
        style={{ height: '100%', minHeight: 64, display: 'block' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`BRAIN overall by iteration, ${iterations[0]} to ${iterations[iterations.length - 1]}`}
      >
        {/* recessive baseline only — a grid of gridlines on a nine-point series is
            more furniture than data */}
        {/* The fill fades downward rather than sitting as a solid block: at full
            opacity the area outweighed the line it belongs to and the chart read as
            a filled rectangle with a lighter top edge. */}
        <defs>
          <linearGradient id="orch-trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--op-bar)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--op-bar)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="0" y1={height - padB} x2={W} y2={height - padB} stroke="var(--op-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={area} fill="url(#orch-trend-fill)" />
        <path d={path} fill="none" stroke="var(--op-bar)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover && (
          <line x1={hover.x} y1={padT} x2={hover.x} y2={height - padB} stroke="var(--border-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        )}
        {/* End marker: the current value, always visible. Circles would be
            stretched by the non-uniform viewBox, so the marker is drawn in
            screen-stable units with a surface ring. */}
        <rect
          x={last.x - 0.9} y={last.y - 4} width="1.8" height="8" rx="0.9"
          fill="var(--op-bar)" stroke="var(--bg-1)" strokeWidth="1" vectorEffect="non-scaling-stroke"
        />
      </svg>
      {hover && (
        <div className="orch-tip" style={{ left: hover.px, top: hover.py }}>
          iteration {hover.iteration} · <span className="orch-tip-val">{hover.v}</span>
        </div>
      )}
    </div>
  );
}

function Sparkline({ series }) {
  const real = series.filter((v) => v != null);
  if (real.length < 2) return <svg viewBox="0 0 100 18" preserveAspectRatio="none" />;
  const lo = Math.min(...real);
  const hi = Math.max(...real);
  const span = hi - lo || 1;
  const path = series
    .map((v, i) => {
      if (v == null) return null;
      const x = (i / (series.length - 1)) * 100;
      const y = 15 - ((v - lo) / span) * 12;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter(Boolean);
  return (
    <svg viewBox="0 0 100 18" preserveAspectRatio="none" aria-hidden="true">
      <polyline
        points={path.join(' ')}
        fill="none"
        stroke="var(--op-bar)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ── the accessible twin: every plotted number, as a table ───────────────── */
function PulseTable({ data }) {
  const it = data.trend.iterations;
  return (
    <div className="orch-scroll">
      <table className="orch-table">
        <thead>
          <tr>
            <th>Capability</th>
            <th style={{ textAlign: 'right' }}>Nexeo</th>
            <th style={{ textAlign: 'right' }}>Professional</th>
            <th style={{ textAlign: 'right' }}>Gap</th>
            <th style={{ textAlign: 'right' }}>Last move</th>
          </tr>
        </thead>
        <tbody>
          {data.capabilities.map((c) => (
            <tr key={c.name}>
              <td>{c.name}</td>
              <td className="num">{c.nexeo}</td>
              <td className="num">{c.professional}</td>
              <td className="num">{Math.round((c.professional - c.nexeo) * 10) / 10}</td>
              <td className="num">{c.delta > 0 ? `+${c.delta}` : c.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.trend.rows.length > 0 && (
        <table className="orch-table" style={{ marginTop: 'var(--s-4)' }}>
          <thead>
            <tr>
              <th>Trend by iteration</th>
              {it.map((i) => (
                <th key={i} style={{ textAlign: 'right' }}>#{i}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.trend.rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                {r.series.map((v, idx) => (
                  <td className="num" key={idx}>{v == null ? '—' : v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function OrchestratorPulsePanel() {
  // A frame is the payload PLUS the client instant it arrived, which is what lets
  // the timers advance locally without trusting the browser's clock to agree with
  // the server's.
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState(null);
  const [paused, setPaused] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const [, setTick] = useState(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/orchestrator/pulse');
      setFrame({ data, at: nowSec() });
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'could not reach the pulse');
    }
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(() => {
      // Don't spawn a python process for a tab nobody is looking at.
      if (!pausedRef.current && document.visibilityState === 'visible') load();
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible' && !pausedRef.current) load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  // The local heartbeat that advances the running timers between polls.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (!frame && !error) {
    return (
      <Card className="orch-pulse">
        <div className="orch-pulse-meta">Reading the build loop…</div>
      </Card>
    );
  }
  if (!frame) {
    return (
      <Card className="orch-pulse">
        <div className="orch-pulse-head">
          <h2 className="orch-pulse-title">Brain build pulse</h2>
          <Button variant="secondary" size="sm" onClick={load}>
            <Icon name="refresh" size={14} /> Retry
          </Button>
        </div>
        <div className="orch-banner orch-banner-bad">{error}</div>
      </Card>
    );
  }

  const data = frame.data;
  const drift = nowSec() - frame.at;
  const liveNow = data.now + drift; // the server's clock, carried forward locally
  const stage = data.stage.name;
  const stageColor = STAGE_COLOR[stage] || 'var(--op-idle)';
  const frameAge = Math.floor(drift);
  const stale = !!error || (!paused && frameAge > POLL_MS / 1000 + 8);
  const trend = data.trend;
  const overall = trend.rows.find((r) => r.overall);
  const moved = trend.rows.filter((r) => !r.overall);
  const bench = data.benchmark;

  return (
    <Card className={`orch-pulse${stale ? ' is-stale' : ''}${paused ? ' is-paused' : ''}`}>
      <div className="orch-pulse-head">
        <h2 className="orch-pulse-title">
          Brain build pulse
          <span className="orch-section-note">the orchestrator loop, live</span>
        </h2>
        <div className="orch-pulse-meta">
          <span className="orch-pulse-live">
            <span className="orch-pulse-live-dot" />
            {paused ? 'paused' : stale ? 'not live' : 'live'}
          </span>
          <span>· frame {frameAge}s old</span>
          <span>· {pkt(liveNow, data.pkt_offset)}</span>
          <Button variant="secondary" size="sm" onClick={() => setPaused((p) => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant="secondary" size="sm" onClick={load}>
            <Icon name="refresh" size={14} /> Now
          </Button>
        </div>
      </div>

      {error && (
        <div className="orch-banner orch-banner-bad">
          Pulse unreadable ({error}) — showing the last good frame, {frameAge}s old.
        </div>
      )}

      <div className="orch-pulse-body">
        {/* ── stage hero — the one thing worth seeing from across the room ── */}
        <div className="orch-stage" style={{ '--stage-color': stageColor }}>
          <div className="orch-stage-word">
            <span className="orch-dot" />
            {stage}
          </div>
          <div className="orch-stage-timer">
            {fmtDur(stage === 'IDLE' ? data.stage.elapsed : data.stage.elapsed + drift)}
          </div>
          <div className="orch-stage-side">
            <div style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)' }}>
              Iteration #{data.iteration}
            </div>
            <div className="orch-pulse-meta" style={{ justifyContent: 'flex-end' }}>
              started {pkt(data.iteration_started, data.pkt_offset, true)}
              {data.iteration_started && ` · ${fmtDur(liveNow - data.iteration_started)} ago`}
            </div>
          </div>
          <div className="orch-stage-detail">
            {data.stage.detail} <span style={{ color: 'var(--text-dim)' }}>· timer from {data.stage.basis}</span>
          </div>
        </div>

        {stage === 'STALLED' && (
          <div className="orch-banner orch-banner-bad">
            <Icon name="warning" size={14} /> The seat is alive but producing nothing — this is not progress.
          </div>
        )}
        {!data.loop_alive && stage === 'IDLE' && (
          <div className="orch-banner orch-banner-warn">
            <Icon name="warning" size={14} /> The build loop is not running on this host.
          </div>
        )}

        {/* ── the deck: one aspect per card, all of them on one screen ──
             Owner, 2026-08-12: "i want complete deck of pulse with different
             aspects" and "it should be fit to page without scroll". So the
             sections became cards laid out in a fixed-height grid: every aspect
             the terminal window carries is here, and none of it is below the
             fold. Where a card cannot fit its own content on a short screen, that
             CARD scrolls — the page never does. */}
        <div className="orch-deck">
          {/* aspect 1 — what is happening right now, and for how long */}
          <PulseCard
            className="orch-deck-phases"
            title={`Iteration #${data.iteration} · phases`}
            hint={`bar = time spent · ${data.iterations_built} recorded`}
          >
            <PhaseTimeline data={data} liveNow={liveNow} />
            <div className="orch-progress">
              {data.current_phase && data.progress
                ? <><b>Progress {data.current_phase}:</b> {data.progress}</>
                : <><b>Progress:</b> nobody working</>}
            </div>
          </PulseCard>

          {/* aspect 2 — how far Brain is from a professional assistant */}
          {data.capabilities.length > 0 && (
            <PulseCard
              className="orch-deck-caps"
              title="Capability vs a professional"
              hint={showTable ? 'show charts' : 'show table'}
              onHintClick={() => setShowTable((s) => !s)}
            >
              {showTable ? <PulseTable data={data} /> : <CapabilityBars data={data} />}
            </PulseCard>
          )}

          {/* aspect 3 — whether any of it is moving, iteration by iteration */}
          {overall && (
            <PulseCard
              className="orch-deck-trend"
              title={`BRAIN overall · iteration ${trend.iterations[0]}→${trend.iterations[trend.iterations.length - 1]}`}
              hint={`${overall.first} → ${overall.last} across ${trend.iterations.length} scored`}
            >
              <TrendLine iterations={trend.iterations} series={overall.series} height={104} />
              {moved.length > 0 && (
                <div className="orch-deck-sparks">
                  {moved.map((r) => (
                    <div className="orch-spark" key={r.name} title={r.series.map((v, i) => `#${trend.iterations[i]} ${v ?? '—'}`).join(' · ')}>
                      <div className="orch-cap-name">{r.name}</div>
                      <div className="orch-cap-pro" style={{ textAlign: 'right' }}>{r.first}</div>
                      <div className="orch-spark-svg"><Sparkline series={r.series} /></div>
                      <div className="orch-cap-val">{r.last}</div>
                      <DeltaChip value={r.delta} />
                    </div>
                  ))}
                </div>
              )}
              {trend.unmoved.length > 0 && (
                // Named, not hidden — that most capabilities have never moved is the
                // most important fact about this loop's progress.
                <div className="orch-section-note orch-unmoved">
                  never moved: {trend.unmoved.join(', ')}
                </div>
              )}
            </PulseCard>
          )}

          {/* aspect 4 — the measurement itself, and what the reviewer made of it */}
          {bench && (
            <PulseCard
              className="orch-deck-bench"
              title={`Benchmark · iteration ${bench.iteration}`}
              hint="weakest criterion vs target"
            >
            <div className="orch-bench">
              <span>
                {bench.criterion} <span className="orch-bench-num">{bench.score}</span> →{' '}
                <span className="orch-bench-num">{bench.target}</span>
              </span>
              <span style={{ color: bench.gap > 0 ? 'var(--op-stalled)' : 'var(--op-score)' }} className="orch-bench-num">
                {bench.gap} to go
              </span>
              <span>
                codex{' '}
                <b style={{ color: VERDICT_COLOR[bench.verdict] || 'var(--text-muted)' }}>{bench.verdict}</b>
              </span>
              {bench.overall != null && (
                <span className="orch-section-note">overall {bench.overall}</span>
              )}
              {bench.cases_failed > 0 && (
                <span style={{ color: 'var(--op-stalled)' }}>
                  {bench.cases_failed} case(s) failed to score — incomplete, not low
                </span>
              )}
              {bench.mutated && (
                <span style={{ color: 'var(--op-measure)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Icon name="warning" size={13} /> last run wrote to live data
                </span>
              )}
            </div>
            {data.history.length > 0 && (
              <div className="orch-scroll orch-hist">
                <table className="orch-table">
                  <thead>
                    <tr>
                      <th>Iter</th>
                      <th>Run</th>
                      <th style={{ textAlign: 'right' }}>Overall</th>
                      <th style={{ textAlign: 'right' }}>Weakest</th>
                      <th>Crit</th>
                      <th>Codex</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((h) => (
                      <tr key={`${h.iteration}-${h.label}`}>
                        <td>#{h.iteration}</td>
                        <td>{h.label}</td>
                        <td className="num">{h.overall ?? '—'}</td>
                        <td className="num">{h.weakest ?? '—'}</td>
                        <td>{h.criterion ?? '—'}</td>
                        <td style={{ color: VERDICT_COLOR[h.verdict] || 'var(--text-dim)' }}>{h.verdict}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            </PulseCard>
          )}
        </div>
      </div>
    </Card>
  );
}
