#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// orch-health — the watchdog that watches the orchestration (orch-engineer tool).
// Emits ONE line per NEW anomaly (quiet otherwise); designed to run under a
// persistent session Monitor. Owner's purpose (2026-07-27): gates raise QUALITY
// PER HOUR — a CR should flow in hours, never consume a whole day.
//
// Detects the failure patterns actually observed in this project:
//   WATCH-DOWN   the board/watch process died
//   CIRCLING     same CR gaining FAILs rapidly (review/build ping-pong starting)
//   SPEND        a CR approaching the 400k global wall (alert at 300k)
//   ESCALATED    a CR newly parked on the owner
//   DAY-BURNER   a CR open >6h wall-clock and still not closed
//   DUPLICATES   two gate entries for one gate within 60s (multi-actor race)
// ─────────────────────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ROOT = process.cwd();
const POLL = 60000;

const state = { watchUp: null, perCr: {} };
const say = (s) => console.log(`[orch-health] ${s}`);

function crIds() {
  try { return fs.readdirSync(path.join(ROOT, "crs")).filter(f => /^CR-\d+.*\.md$/i.test(f)).map(f => f.replace(/\.md$/i, "")); }
  catch { return []; }
}
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

function tick() {
  // WATCH-DOWN
  let up = false;
  try { execSync("pgrep -f 'node orchestrator\\.cjs$'", { stdio: "pipe" }); up = true; } catch { /* down */ }
  if (state.watchUp === true && !up) say("WATCH-DOWN: the orchestrator watch process died — relaunch `node orchestrator.cjs`");
  state.watchUp = up;

  for (const id of crIds()) {
    const cr = read(path.join(ROOT, "crs", id + ".md"));
    const status = (cr.match(/\*\*Status:\*\*\s*([A-Z_]+)/i) || [])[1] || "?";
    const g = read(path.join(ROOT, "crs", ".gates", id + ".md"));
    const st = state.perCr[id] = state.perCr[id] || { fails: null, spendWarned: false, escalated: false, slow: false, dupWarned: 0 };
    if (status === "CLOSED") continue;

    // CIRCLING: FAIL count growth ≥2 between polls
    const fails = (g.match(/\n\nFAIL/g) || []).length;
    if (st.fails != null && fails - st.fails >= 2)
      say(`CIRCLING: ${id} gained ${fails - st.fails} FAILs in ${POLL / 1000}s (total ${fails}) — ping-pong starting; check the board`);
    st.fails = fails;

    // SPEND: tokens since last owner decision
    const od = g.lastIndexOf("### Owner decision");
    const win = od >= 0 ? g.slice(od) : g;
    let tok = 0;
    for (const m of win.matchAll(/<!--METRIC [^>]*? tokens=(\d+)/g)) tok += +m[1];
    if (tok > 300000 && !st.spendWarned) { st.spendWarned = true; say(`SPEND: ${id} at ${Math.round(tok / 1000)}k tokens since last owner decision (wall at 400k)`); }
    if (tok <= 300000) st.spendWarned = false;

    // ESCALATED: newly parked on the owner
    if (status === "ESCALATED" && !st.escalated) { st.escalated = true; say(`ESCALATED: ${id} is waiting on the owner — see the board's question`); }
    if (status !== "ESCALATED") st.escalated = false;

    // DAY-BURNER: open >6h wall-clock
    try {
      const first = read(path.join(ROOT, "logs", id + ".jsonl")).split("\n")[0];
      const t0 = new Date(JSON.parse(first).ts).getTime();
      if (Date.now() - t0 > 6 * 3600e3 && !st.slow) { st.slow = true; say(`DAY-BURNER: ${id} has been in the pipeline >6h — gates exist to raise quality per HOUR; consider decompose/authorize`); }
    } catch { /* no log yet */ }

    // DUPLICATES: two entries for the same gate within 60s (multi-actor race)
    const times = {};
    for (const m of g.matchAll(/### Gate: ([^(]+)\([^)]*\) — rev \d+ — ([0-9T:.Z-]+)/g)) (times[m[1].trim()] = times[m[1].trim()] || []).push(new Date(m[2]).getTime());
    let dups = 0;
    for (const arr of Object.values(times)) { arr.sort(); for (let i = 1; i < arr.length; i++) if (arr[i] - arr[i - 1] < 60e3) dups++; }
    if (dups > st.dupWarned) { say(`DUPLICATES: ${id} has ${dups} near-simultaneous gate entries (multi-actor race) — ensure ONE watch + one actor per role`); st.dupWarned = dups; }
  }
}

tick();
setInterval(tick, POLL);
