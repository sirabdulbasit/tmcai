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
/* ── the owner's own capability diagram, with the live numbers written into it ──
   Owner, 2026-08-13: *"i want same file to be present on my dashboard where you
   will just write the progres % on given spaces/box"*. The nine empty squares in
   his artwork are exactly the nine capabilities the scorecard already carries, so
   this overlays the live score onto each one.

   Positions are PERCENTAGES of the image box, not pixels, so the overlay tracks
   the artwork at any width. They are keyed to the scorecard's own capability
   names — never to the label printed in the picture — because the picture says
   "ACTION" and "COMMUNICATES" where the scorecard says "Authorized Action" and
   "Accurate Communication", and a display that renames a capability is how two
   sources of truth start disagreeing. */
/* `above` mirrors the owner's artwork: in his picture ACTION, COMMUNICATES, SELF
   FOLLOW-UP, SIMPLE & SMART and SELF PRUNING are captioned ABOVE their box, while
   THINKING, LEARN, MEMORY and SELF HEALING are captioned below. Matching it means
   the numbers sit where he already expects to read them — and when his own file is
   installed, the overlay lands on the same nine boxes with the same captions. */
const CAP_MAP_SLOTS = [
  // MEASURED FROM THE OWNER'S OWN FILE, not estimated from a screenshot. The nine
  // dark squares were found by flood-filling the image (960x1102) for near-black
  // regions and keeping the square ones ~112-119px; these are their centres as a
  // percentage of the image box, so the numbers stay on their boxes at any width.
  // `cap` is his wording, used only by the drawn stand-in — his artwork carries
  // its own captions. Names stay keyed to the SCORECARD so the data cannot drift.
  { name: 'Authorized Action',      left: 50.4, top: 13.6, above: true,  cap: 'ACTION' },
  { name: 'Accurate Communication', left: 21.5, top: 24.6, above: true,  cap: 'COMMUNICATES' },
  { name: 'Self Follow-Up',         left: 80.0, top: 24.5, above: true,  cap: 'SELF FOLLOW-UP' },
  { name: 'Thinking',               left: 10.6, top: 44.6, above: false, cap: 'THINKING' },
  { name: 'Learn',                  left: 90.3, top: 44.6, above: false, cap: 'LEARN' },
  { name: 'Memory',                 left: 13.0, top: 66.6, above: false, cap: 'MEMORY' },
  { name: 'Self-Healing',           left: 88.2, top: 66.6, above: false, cap: 'SELF HEALING' },
  { name: 'Simple & Smart',         left: 25.0, top: 85.6, above: true,  cap: 'SIMPLE & SMART' },
  { name: 'Self-Pruning',           left: 75.6, top: 85.6, above: true,  cap: 'SELF PRUNING' },
];

const CAP_MAP_SRC = '/nexeo-capability-map.jpg';

function CapabilityMap({ data }) {
  const [failed, setFailed] = useState(false);
  const byName = new Map((data.capabilities || []).map((c) => [c.name, c]));

  /* THE OWNER'S OWN ARTWORK IS NOT ON THIS BOX AND CANNOT BE PUT THERE FROM A
     CHAT PASTE. Rather than leave the card showing an instruction — which is what
     he saw, twice — Nexeo draws the diagram itself in the same arrangement, with
     the live scores in the boxes. It is deliberately NOT presented as his file:
     it is labelled as drawn here, and the instant
     client/public/nexeo-capability-map.png exists the component uses HIS image
     instead and this drawing steps aside. A generated lookalike filed under his
     name would read as the original to whoever came next; a clearly-labelled
     stand-in that does the job does not.

     Same slot coordinates either way, so the numbers land on the same nine
     positions whichever background is showing. */
  if (failed) {
    return (
      <div className="orch-capmap">
        <svg viewBox="0 0 960 1120" className="orch-capmap-svg" role="img"
             aria-label="Nexeo capability map: nine capabilities and their current scores">
          <defs>
            <radialGradient id="capHead" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stopColor="#31557a" />
              <stop offset="55%" stopColor="#1d2f45" />
              <stop offset="100%" stopColor="#11161f" />
            </radialGradient>
            {/* One ribbon gradient, cool at the head warming outward — it reads as
                a connection, not as nine different categories. Colour still
                carries no value here; the number is the mark. */}
            <linearGradient id="capRibbon" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#5aa9e6" />
              <stop offset="100%" stopColor="#e0a43c" />
            </linearGradient>
            <filter id="capGlow" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow dx="0" dy="0" stdDeviation="7" floodColor="#5aa9e6" floodOpacity="0.35" />
            </filter>
          </defs>
          {/* Sweeping ribbons, not straight spokes — his artwork connects each box
              to the head with a curve that bows AWAY from centre. The control
              point is pushed perpendicular to the centre-to-box line so every
              ribbon bows the same way regardless of which quadrant it is in. */}
          {CAP_MAP_SLOTS.map((sl) => {
            const x = sl.left * 9.6, y = sl.top * 11.2;
            const mx = (480 + x) / 2, my = (560 + y) / 2;
            const dx = x - 480, dy = y - 560;
            const len = Math.hypot(dx, dy) || 1;
            const bow = 62;
            return (
              <path key={`c-${sl.name}`} className="orch-capmap-link"
                    d={`M480,560 Q${mx - (dy / len) * bow},${my + (dx / len) * bow} ${x},${y}`} />
            );
          })}
          <ellipse cx="480" cy="560" rx="152" ry="198" className="orch-capmap-head" />
          <ellipse cx="480" cy="470" rx="96" ry="76" className="orch-capmap-ring" />
          <text x="480" y="452" className="orch-capmap-core">NEXEO</text>
          <text x="480" y="500" className="orch-capmap-corenum">
            {data.brain ? `${data.brain.nexeo}%` : ''}
          </text>
          <text x="480" y="526" className="orch-capmap-corelbl">
            {data.brain ? `of ${data.brain.professional} professional` : ''}
          </text>
          {CAP_MAP_SLOTS.map((sl) => {
            const c = byName.get(sl.name);
            const x = sl.left * 9.6, y = sl.top * 11.2;
            return (
              <g key={`b-${sl.name}`}>
                <rect x={x - 64} y={y - 64} width="128" height="128" rx="16"
                      className="orch-capmap-box" />
                <text x={x} y={y + 2} className="orch-capmap-boxnum">{c ? `${c.nexeo}%` : '—'}</text>
                {c && <text x={x} y={y + 30} className="orch-capmap-boxpro">of {c.professional}</text>}
                <text x={x} y={sl.above ? y - 82 : y + 96} className="orch-capmap-boxlbl">{sl.cap}</text>
              </g>
            );
          })}
        </svg>
        <div className="orch-section-note orch-capmap-note">
          Drawn by Nexeo in the owner's arrangement — his own artwork replaces it automatically
          if dropped at <code>client/public/nexeo-capability-map.png</code>.
        </div>
      </div>
    );
  }

  return (
    <div className="orch-capmap">
      {/* THE FRAME IS THE IMAGE'S OWN BOX, and the numbers are positioned against
          IT rather than against the card. Whenever the picture is height-limited the
          card is wider than it is, so percentages taken from the card push every
          number outward — measured at up to 39px of drift on the outer boxes,
          growing with distance from centre, while the vertical was exact. An
          inline-block frame shrink-wraps the image so the overlay and the picture
          share one coordinate system. */}
      <div className="orch-capmap-frame">
        <img src={CAP_MAP_SRC} alt="Nexeo capability map" onError={() => setFailed(true)} />
        {CAP_MAP_SLOTS.map((s) => {
          const c = byName.get(s.name);
          return (
            <div
              className="orch-capmap-slot"
              key={s.name}
              style={{ left: `${s.left}%`, top: `${s.top}%` }}
              title={c
                ? `${s.name}: Nexeo ${c.nexeo} · professional ${c.professional} · gap ${Math.round((c.professional - c.nexeo) * 10) / 10}`
                : `${s.name}: not scored`}
            >
              {/* An unscored capability shows a dash, never a zero. A zero is a
                  measurement; a missing card is not, and the two must not look the
                  same on a wall display. */}
              <span className="orch-capmap-pct">{c ? `${c.nexeo}%` : '—'}</span>
              {c && <span className="orch-capmap-pro">of {c.professional}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── the scorer's own words, carried with its numbers ──────────────────────────
   Owner, 2026-08-14: "dashboard will remain same where information should be
   provided by the grok by either means". The deck showed Grok's numbers and none
   of Grok's findings, so a page could read 94.9 (a benchmark judge's figure, not
   Grok's) while capability sat at 50.3 and nobody could see why.

   `code-read` vs `live-evidence` is stated rather than blended: a score derived
   from reading source is an opinion about what the code ought to do, and it must
   not look identical to one derived from production. */
/* GrokFindings was removed 2026-08-14 — owner: "remove this", of the prose block
   under the capability card. Grok still supplies every number on this card; what
   came out is its commentary, which crowded the figure it was explaining. Deleted
   rather than hidden behind a flag. */

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
/* ── BRAIN INTEGRITY — the nine capabilities as one picture ────────────────────
 *
 * Owner, 2026-08-13, with a reference image of a brain at "PHASE 1: 47% INTEGRITY"
 * ringed by labelled repair zones: *"can u show this kind of brain progress in
 * your deck easily?"*
 *
 * Yes, and it carries more than the render can. The reference is a static
 * illustration; every zone here is a real capability with its real score, tinted
 * by how far it is from professional, and the "repair zone" marker means
 * something specific — that capability is the ACTIVE CAMPAIGN, so it is the one
 * being worked this week. Zones move when Grok's card moves and only then.
 *
 * Drawn as inline SVG on purpose: no image asset, no external request, and the
 * numbers cannot drift out of step with the rest of the panel because they come
 * from the same collector call.
 *
 * The integrity number is Grok's overall (47.4), NOT the benchmark's 95. Those
 * two have been confused all week and they measure different things — the
 * benchmark scores twelve conversational replies and cannot see seven of the nine
 * capabilities below.
 */
const BRAIN_ZONES = [
  // Stylised lobes. Position is layout, not neuroanatomy — each blob is one
  // capability, arranged so the label ring around the outside stays readable.
  { name: 'Simple & Smart',        d: 'M96,54 C118,40 150,42 164,58 C150,74 118,78 96,70 Z', lx: 130, ly: 26, anchor: 'middle' },
  { name: 'Thinking',              d: 'M168,58 C190,44 218,50 226,70 C210,84 182,84 168,74 Z', lx: 236, ly: 46, anchor: 'start' },
  { name: 'Memory',                d: 'M62,78 C84,66 112,72 120,88 C104,102 76,100 62,92 Z',  lx: 24,  ly: 66, anchor: 'end' },
  { name: 'Accurate Communication',d: 'M124,86 C150,74 180,80 190,98 C172,114 142,112 124,100 Z', lx: 158, ly: 128, anchor: 'middle' },
  { name: 'Authorized Action',     d: 'M194,92 C216,82 238,90 242,108 C226,120 202,118 194,106 Z', lx: 252, ly: 100, anchor: 'start' },
  { name: 'Self Follow-Up',        d: 'M58,106 C82,96 108,102 116,118 C100,132 72,130 58,120 Z', lx: 20,  ly: 116, anchor: 'end' },
  { name: 'Learn',                 d: 'M120,116 C146,106 174,112 184,128 C166,142 136,142 120,130 Z', lx: 150, ly: 160, anchor: 'middle' },
  { name: 'Self-Healing',          d: 'M188,124 C210,114 232,122 236,138 C220,150 196,150 188,138 Z', lx: 248, ly: 142, anchor: 'start' },
  { name: 'Self-Pruning',          d: 'M84,136 C108,126 138,132 148,148 C130,162 100,160 84,150 Z', lx: 46,  ly: 168, anchor: 'end' },
];

/* BrainIntegrity was removed 2026-08-14 with its card — owner: "Remove brain
   integrity which is being duplicated". It rendered the same capability figure
   the nine-box map now shows directly. Deleted rather than left defined-but-
   unrendered, which is how this project once reported a card as live that was
   never on screen. */

/* ── WHAT THE LAST TEN ITERATIONS ACTUALLY PRODUCED ────────────────────────────
 *
 * Owner, 2026-08-13: *"this should show last 10 iterations and make it more
 * meaningful"* — about a card titled "BRAIN OVERALL · ITERATION 1→18" whose line
 * climbed convincingly across a y-range of 46.7 to 47.4.
 *
 * The line was the problem. It auto-scaled to a 0.7-point band, so seven flat
 * iterations and one +0.1 drew the same reassuring rise that real progress would.
 * A caption underneath said 1.7% of the way; captions lose to shapes.
 *
 * This replaces "did the number move?" with "what did each iteration give me?",
 * which is the question that was actually being asked. Per iteration: the
 * capability movement, what the reviewer ruled, and whether it reached
 * production — because the capability contract is explicit that undeployed work
 * has changed nothing for him, however good it is.
 *
 * The summary line is the part that earns the card: N shipped, N ruled
 * WEAK/WRONG, total movement, what it cost in money and hours. Those five
 * numbers together are what tells him whether to change approach, and no
 * arrangement of a rising line can convey them.
 */
function IterationOutcomes({ data, window: win = 10 }) {
  const pts = data.capability_series?.points || [];
  const recs = data.iterations || [];
  const cur = data.iteration;
  if (!recs.length) return null;

  const top = cur || Math.max(...recs.map((r) => r.iteration || 0));
  const from = Math.max(1, top - win + 1);
  const nums = [];
  for (let i = from; i <= top; i += 1) nums.push(i);

  const cells = nums.map((n) => {
    const rec = recs.find((r) => r.iteration === n) || {};
    const pt = pts.find((p) => p.iteration === n) || null;
    const rv = rec.reviewer?.verdict || pt?.reviewer_verdict || null;
    const shipped = rec.deploy?.shipped === true;
    const held = rec.deploy?.shipped === false;
    return {
      n, rec, pt, rv, shipped, held,
      move: pt ? pt.movement : null,
      inFlight: cur === n && !rec.finished_at,
      aborted: (rec.note || '').startsWith('RESTART'),
    };
  });

  const shippedN = cells.filter((c) => c.shipped).length;
  const weakN = cells.filter((c) => c.rv === 'WEAK' || c.rv === 'WRONG').length;
  const soundN = cells.filter((c) => c.rv === 'SOUND').length;
  const moveSum = Math.round(
    cells.reduce((a, c) => a + (c.move || 0), 0) * 10) / 10;
  const costSum = Math.round(cells.reduce((a, c) => a + (c.rec.cost_usd || 0), 0));
  const timeSum = cells.reduce((a, c) => a + (c.rec.duration_seconds || 0), 0);

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 3, alignItems: 'stretch' }}>
        {cells.map((c) => {
          /* Colour carries the REVIEWER's verdict, not the score movement. An
             iteration that raised a number in a turn the reviewer ruled WEAK is
             not a good iteration, and colouring by movement would say it was. */
          const bar = c.inFlight ? 'var(--op-build)'
            : c.aborted ? 'var(--text-dim)'
            : VERDICT_COLOR[c.rv] || 'var(--text-dim)';
          const tip = [
            `#${c.n}`,
            c.inFlight ? 'in flight' : (c.aborted ? 'aborted — loop restarted' : null),
            c.rv ? `reviewer: ${c.rv}` : 'not reviewed',
            c.move == null ? 'not scored'
              : `capability ${c.move > 0 ? `+${c.move}` : c.move}`,
            c.shipped ? 'SHIPPED to production'
              : (c.held ? `held: ${c.rec.deploy?.reason || 'not shipped'}` : null),
            c.rec.duration_seconds ? fmtDur(c.rec.duration_seconds) : null,
            c.rec.cost_usd ? `$${c.rec.cost_usd}` : null,
          ].filter(Boolean).join(' · ');
          return (
            <div key={c.n} title={tip}
                 style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: 10 }}>
              <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>#{c.n}</div>
              {/* movement, which is 0 for most iterations and should look like 0 */}
              <div style={{
                color: c.move == null ? 'var(--text-dim)'
                  : c.move > 0 ? 'var(--op-score)' : 'var(--text-dim)',
                fontWeight: c.move ? 700 : 400,
              }}>
                {c.move == null ? '·' : (c.move > 0 ? `+${c.move}` : c.move)}
              </div>
              <div style={{ height: 4, background: bar, borderRadius: 2, margin: '3px 0' }} />
              {/* the ship marker — the only mark that means the owner received it */}
              <div style={{ color: c.shipped ? 'var(--op-score)' : 'var(--text-dim)' }}>
                {c.shipped ? '▲' : (c.inFlight ? '…' : (c.aborted ? '×' : '·'))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="orch-section-note" style={{ marginTop: 6 }}>
        <b>{nums.length} iterations</b> · {shippedN} shipped ▲ · {weakN} ruled
        WEAK/WRONG · {soundN} SOUND · capability {moveSum > 0 ? `+${moveSum}` : moveSum}
        {costSum ? ` · $${costSum}` : ''}{timeSum ? ` · ${fmtDur(timeSum)}` : ''}
      </div>
    </div>
  );
}

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
  /* Three views behind one hint, because the owner asked for his diagram ON the
     dashboard and the deck is fixed at three cards in one column — so the map
     lives INSIDE the capability card rather than becoming a fourth row. It leads,
     since it is the view he asked for; bars and table stay one click away. */
  const [capView, setCapView] = useState('map');
  const CAP_VIEWS = ['map', 'bars', 'table'];
  const CAP_VIEW_HINT = { map: 'show bars', bars: 'show table', table: 'show diagram' };
  /* The owner's deck is 2x2 — four cards, no scroll ("health deck should look like
     this", twice). Brain integrity and the ten-iteration trend both want the
     top-right slot, so they share it and the card's hint swaps them. That keeps his
     layout exact without deleting the outcome strip, which is the one view that
     shows what each iteration produced. */

  /* ── IS THE PAGE STILL RUNNING THE BUILD THAT IS DEPLOYED? ──────────────────
     Owner, 2026-08-13: *"when u deployed are u reloading page by yourself?"* — no,
     and that is why he had been hard-refreshing after every change I shipped. The
     deck polls its DATA every five seconds and never once checked whether its own
     CODE was current, so a fix could be live on disk for an hour while he looked at
     the old bundle and reasonably concluded I had not done it.

     Detected without a build step: fetch the served index.html and compare the
     module bundle it points at with the one this component was loaded from. Vite
     content-hashes those filenames, so a differing hash IS a new deploy.

     It offers a reload rather than taking one. An unannounced reload during a live
     build would throw away whatever he was reading. */
  const [newBuild, setNewBuild] = useState(false);
  useEffect(() => {
    /* The entry bundle THIS page actually loaded, read from its own script tag
       rather than from import.meta.url. That distinction matters: this component
       currently lives in index-*.js so the two agree, but the day it gets
       code-split into its own chunk, import.meta.url would stop matching the
       served entry and the pill would show permanently. Reading the DOM is exact
       whatever the chunking does. */
    const entry = document.querySelector('script[type="module"][src*="/assets/"]');
    const mine = entry?.getAttribute('src')?.split('/').pop() || null;
    let live = true;
    const check = async () => {
      try {
        const html = await fetch('/index.html', { cache: 'no-store' }).then((r) => r.text());
        const m = html.match(/src="([^"]*\/assets\/[^"]+\.js)"/);
        if (!live || !m) return;
        const served = m[1].split('/').pop();
        if (served && mine && served !== mine) setNewBuild(true);
      } catch { /* offline or blocked — say nothing rather than nag */ }
    };
    check();
    const t = setInterval(check, 30_000);
    return () => { live = false; clearInterval(t); };
  }, []);
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
          <h2 className="orch-pulse-title">Build Pulse</h2>
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
  // From the collector — never recomputed in the browser. The same arithmetic in two
  // places is how a dashboard starts quietly disagreeing with the terminal window it
  // is meant to mirror, and this file's own header says one detector, two renderers.
  const interp = data.capability_series?.interpretation || null;
  const axisObjective = data.capability_series?.axis?.objective_line ?? null;
  const bench = data.benchmark;
  /* The last ten SCORED iterations for the line, kept in lockstep with its own
     iteration labels — slicing the values without slicing the labels is how a
     chart starts captioning the wrong turns. */
  const winIters = (trend?.iterations || []).slice(-10);
  const winSeries = (overall?.series || []).slice(-10);

  return (
    <Card className={`orch-pulse${stale ? ' is-stale' : ''}${paused ? ' is-paused' : ''}`}>
      <div className="orch-pulse-head">
        <h2 className="orch-pulse-title">
          Build Pulse
          <span className="orch-section-note">the orchestrator loop, live</span>
        </h2>
        <div className="orch-pulse-meta">
          <span className="orch-pulse-live">
            <span className="orch-pulse-live-dot" />
            {paused ? 'paused' : stale ? 'not live' : 'live'}
          </span>
          <span>· frame {frameAge}s old</span>
          <span>· {pkt(liveNow, data.pkt_offset)}</span>
          {newBuild && (
            <Button variant="primary" size="sm" onClick={() => window.location.reload()}
                    title="A newer build of this dashboard is deployed — this tab is running the previous one">
              <Icon name="refresh" size={14} /> New build — reload
            </Button>
          )}
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
          {/* The hero moved INSIDE the deck, 2026-08-14 — owner: "Brain Pulse,
              Iteration Phase, Benchmark Iteration, Brain Overall all above should
              be in left column (Parallel); Capability would be in right column".
              It used to span the full width above both columns, which pushed the
              capability column down and broke the parallel he asked for. */}
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
          {/* aspect 1 — what is happening right now, and for how long */}
          <PulseCard
            className="orch-deck-phases"
            title={`Iteration #${data.iteration} · phases`}
            hint={`bar = time spent · ${data.iterations_built} recorded`}
          >
            <PhaseTimeline data={data} liveNow={liveNow} />
            {/* The Progress line is gone — owner, 2026-08-13: "remove this", of a
                row reading `← ok ## Iteration 25 ### 1. Verdict **WEAK** — the diff
                adds a safely read-only, tenant/user-sco`. It printed the newest raw
                line from whichever seat was working, so what it showed was a tool
                result truncated mid-word: markdown, shell echoes and half sentences.
                The phase rows above already carry state, seat, model and elapsed —
                the part that was actually readable. The collector still emits
                `progress`; nothing else consumes it, and it stays available for a
                future surface that can render it properly. */}
          </PulseCard>

          {/* Brain integrity REMOVED — owner, 2026-08-14: "Remove brain integrity
              which is being duplicated". It restated the capability picture that
              the nine-box map in the right column now shows directly, and a second
              rendering of the same figure is how a dashboard starts disagreeing
              with itself. The ten-iteration trend keeps this slot: movement over
              time is the one thing neither the map nor the bars can show, so it is
              not a duplicate. The toggle between the two goes with it. */}

          {/* aspect 2 — how far Brain is from a professional assistant */}
          {data.capabilities.length > 0 && (
            <PulseCard
              className="orch-deck-caps"
              title="Brain Capability"
              hint={CAP_VIEW_HINT[capView]}
              onHintClick={() => setCapView((v) => CAP_VIEWS[(CAP_VIEWS.indexOf(v) + 1) % CAP_VIEWS.length])}
            >
              {capView === 'table' ? <PulseTable data={data} />
                : capView === 'bars' ? <CapabilityBars data={data} />
                : <CapabilityMap data={data} />}
            </PulseCard>
          )}

          {/* aspect 3 — whether any of it is moving, iteration by iteration */}
          {/* interpretation comes from the collector, not recomputed here: the same
              arithmetic in two places is how a dashboard starts disagreeing with the
              terminal it mirrors. */}
          {overall && (
            <PulseCard
              className="orch-deck-brain"
              /* Owner, 2026-08-13: "this should show last 10 iterations". It spanned
                 1→18, which averages away the recent turns — the only ones a decision
                 can still affect. */
              title={`BRAIN overall · last 10 iterations${winIters.length ? ` (#${winIters[0]}→#${winIters[winIters.length - 1]})` : ''}`}
            >
              {/* THE SCALE, STATED. Owner, 2026-08-13: "I couldnt understand this
                  make it meaningfull for me". The chart auto-scales to the series'
                  own range — deliberately, since the movement is fractions of a
                  point and a 0→100 axis would draw ten iterations as a flat line —
                  but that means +0.6 fills the full height and reads as a climb.
                  The caption is what makes the shape honest: it names the y-range
                  and states the share of the journey actually covered. Without it
                  the panel flatters the work, which removes the reason to change
                  approach. */}
              {interp && (
                <div className="orch-section-note" style={{ marginBottom: 4 }}>
                  {interp.movement > 0 ? '+' : ''}{interp.movement} of{' '}
                  {interp.remaining + interp.movement} needed ·{' '}
                  <b>{interp.journey_complete_pct}% of the way</b> to {axisObjective}
                  {' '}· the line below spans only {overall.first}–{overall.last}, so its
                  steepness is an artefact of a {Math.round((overall.last - overall.first) * 10) / 10}-point range
                </div>
              )}
              <TrendLine iterations={winIters} series={winSeries} height={104} />
              {/* THE JOURNEY BAR — the picture that carries the truth.
                  Owner, 2026-08-13: the caption alone did not land, and he was right.
                  A sentence under a steep line loses to the line: the chart above is
                  auto-scaled (deliberately — the movement is fractions of a point) so
                  it will always LOOK like a climb. This draws the same number on the
                  scale that matters, 0 → professional, with the objective marked. The
                  eye then gets both facts at once: real movement in the shape above,
                  and how little of the distance it covers here. */}
              {interp && axisObjective && (
                <div className="orch-journey" title={`Brain ${overall.last} · objective ${axisObjective} · professional ${data.brain?.professional}`}>
                  <div className="orch-journey-track">
                    <div className="orch-journey-done" style={{ width: `${Math.max(0.5, (overall.last / 100) * 100)}%` }} />
                    <div className="orch-journey-start" style={{ left: `${(overall.first / 100) * 100}%` }} />
                    <div className="orch-journey-obj" style={{ left: `${(axisObjective / 100) * 100}%` }} />
                  </div>
                  <div className="orch-journey-lab">
                    <span>0</span>
                    <span style={{ marginLeft: 'auto' }}>
                      <b>{overall.last}</b> now · objective <b>{axisObjective}</b> · {interp.journey_complete_pct}% covered
                    </span>
                  </div>
                </div>
              )}
              {/* The per-iteration outcome strip — see IterationOutcomes. This is the
                  part that answers "make it more meaningful": movement, the reviewer's
                  ruling, and whether it reached production, per iteration. */}
              <IterationOutcomes data={data} window={10} />
              {interp && (
                <div className="orch-section-note" style={{ marginTop: 2 }}>
                  {interp.capabilities_moved} of{' '}
                  {interp.capabilities_moved + interp.capabilities_flat} capabilities have
                  ever moved · at {interp.rate_per_iteration}/iteration that is{' '}
                  {interp.iterations_at_this_rate} more iterations
                </div>
              )}
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
              /* Owner, 2026-08-13: the panel read "Benchmark · iteration 18" while
                 the loop was building iteration 20, which looks like a stalled loop
                 rather than a figure older than the current turn. The benchmark is
                 only re-measured when server/src or server/prisma changed, so it is
                 routinely a turn or two behind — say so instead of implying it is
                 current. */
              title={bench.stale
                ? `Benchmark · measured at #${bench.measured_at_iteration} · loop on #${data.iteration}`
                : `Benchmark · iteration ${bench.iteration}`}
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
              {/* WHOSE NUMBER THIS IS. Owner, 2026-08-14, wants the dashboard's
                  information to come from Grok. This card's figures do NOT: they
                  are the 12-case compose benchmark scored by an LLM judge, which
                  is why this can read 94.9 while Grok's capability picture reads
                  50.3. Two different questions — "did the answers read well" and
                  "is Brain capable" — and labelling them is what stops the larger,
                  friendlier number being mistaken for the state of the product. */}
              <span className="orch-section-note orch-bench-src">
                source: 12-case compose benchmark, LLM judge — not Grok's capability score
              </span>
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
                      {/* Owner, 2026-08-13: "i want to see iteration wise progress
                          here". Six absolute values per row gave no direction, so
                          95.5 / 96.2 / 95.5 read as unrelated numbers. */}
                      <th style={{ textAlign: 'right' }}>Δ</th>
                      {/* Owner, 2026-08-13: "provide me information iteration wise
                          brain improvement". Everything left of here is the BENCHMARK
                          — twelve conversational replies scored by the judge — which
                          is not Brain's capability and cannot see seven of the nine.
                          These two columns are the capability itself, per iteration,
                          so the panel stops implying that 95.2 is how good Brain is. */}
                      {/* Owner, 2026-08-13: "which iteration took how much time and
                          how much it improved brain" — the two questions side by side,
                          which is the only way the cost of an iteration is legible. */}
                      <th style={{ textAlign: 'right' }}>Took</th>
                      <th style={{ textAlign: 'right' }}>Brain</th>
                      <th style={{ textAlign: 'right' }}>Δ Brain</th>
                      <th>Codex</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((h) => {
                      /* `progress` is computed by the collector against the previous
                         iteration THAT HAS A BENCHMARK, and names it — iterations
                         9-11 have no capability card and one measured nothing, so
                         differencing against a missing row would invent movement. */
                      const p = (data.iterations || []).find(
                        (r) => r.iteration === h.iteration && r.progress)?.progress;
                      const d = p?.overall_delta;
                      /* NOT green-for-up. C4 has read 90.0, 87.9, 88.3 and 87.3 on
                         barely-changed code, so a +0.9 coloured as improvement would
                         manufacture a trend the instrument cannot support. Anything
                         the collector calls flat is drawn as dim, whatever its sign. */
                      const noisy = (p?.direction || '').startsWith('flat');
                      /* The capability point for the SAME iteration, from the scorer.
                         Absent for iterations 9-11 (the scoring seat was stopped during
                         the restructure) and for any iteration not yet scored — shown as
                         "not scored" rather than blank or interpolated, because a missing
                         capability reading is a fact about the loop, not a gap to fill. */
                      const rec = (data.iterations || []).find((r) => r.iteration === h.iteration);
                      const cap = (data.capability_series?.points || [])
                        .find((q) => q.iteration === h.iteration);
                      const capMove = cap?.movement;
                      const dColor = d == null || noisy
                        ? 'var(--text-dim)'
                        : d > 0 ? 'var(--op-score)' : 'var(--op-stalled)';
                      return (
                      /* An iteration with no benchmark of its own is dimmed whole,
                         so "aborted" and "in flight" cannot be misread as a measured
                         run that happened to score nothing. Owner, 2026-08-13:
                         "this should show me last 6 iterations data" — they are now
                         all present, which means the unmeasured ones have to be
                         unmistakable rather than merely blank. */
                      <tr key={`${h.iteration}-${h.label}`}
                          style={h.measured === false ? { opacity: 0.55 } : undefined}>
                        <td>#{h.iteration}</td>
                        <td>{h.label}</td>
                        <td className="num">{h.overall ?? '—'}</td>
                        <td className="num">{h.weakest ?? '—'}</td>
                        <td>{h.criterion ?? '—'}</td>
                        <td className="num" style={{ color: dColor }}
                            title={p ? `${p.direction}${p.since ? ` · vs #${p.since}` : ''}` : ''}>
                          {d == null ? '—' : (d > 0 ? `+${d}` : d)}
                          {noisy && d != null && (
                            <span className="orch-section-note" style={{ marginLeft: 4 }}>noise</span>
                          )}
                        </td>
                        <td className="num" style={{ color: 'var(--text-dim)' }}
                            title={rec?.cost_usd ? `build turn cost $${rec.cost_usd}${rec.agent_turns ? ` · ${rec.agent_turns} agent turns` : ''}` : ''}>
                          {rec?.duration_seconds
                            ? (rec.duration_seconds >= 3600
                                ? `${Math.floor(rec.duration_seconds / 3600)}h${String(Math.round((rec.duration_seconds % 3600) / 60)).padStart(2, '0')}m`
                                : `${Math.floor(rec.duration_seconds / 60)}m${String(rec.duration_seconds % 60).padStart(2, '0')}s`)
                            : '—'}
                        </td>
                        <td className="num" style={{ color: cap ? 'var(--text)' : 'var(--text-dim)' }}
                            title={cap ? `scored by ${cap.scored_by}${cap.what_moved ? ` · ${cap.what_moved}` : ''}` : 'not scored — no capability card for this iteration'}>
                          {cap ? cap.overall : '—'}
                        </td>
                        <td className="num"
                            title={cap?.disputed ? 'DISPUTED — the scorer raised a capability in an iteration the reviewer ruled WEAK or WRONG' : (cap?.what_moved || '')}>
                          {capMove == null ? (
                            <span style={{ color: 'var(--text-dim)' }}>—</span>
                          ) : capMove === 0 ? (
                            <span style={{ color: 'var(--text-dim)' }}>0</span>
                          ) : (
                            <span style={{ color: capMove > 0 ? 'var(--op-score)' : 'var(--op-stalled)' }}>
                              {capMove > 0 ? `+${capMove}` : capMove}
                              {cap?.disputed && <span className="orch-section-note" style={{ marginLeft: 3 }}>disputed</span>}
                            </span>
                          )}
                        </td>
                        <td style={{ color: VERDICT_COLOR[h.verdict] || 'var(--text-dim)' }}>{h.verdict}</td>
                      </tr>
                      );
                    })}
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
