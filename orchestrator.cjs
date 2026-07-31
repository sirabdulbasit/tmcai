#!/usr/bin/env node
/*
 Multi-agent workflow orchestrator (version in ORCH_VERSION constant below)
 Polls crs/CR-*.md, reads Status, fires the right gate, appends verdicts,
 advances status. Narrates continuously so you can see who is working.
 Pauses at human states (DEPLOY_WAIT etc.); stops on ESCALATED.
*/

const ORCH_VERSION = "v107-kit";  // Test gate applies TESTING_MODEL.md (P1 requirement fidelity / P2 assertions / P3 security-in-harness); post-deploy smoke is required evidence for Sign-off.
// codex.auto (orch.config.json): when true, Codex gates run AUTOMATICALLY via `codex exec`
// (recorded directly, retries on infra errors) instead of pausing for the human to relay
// the IDE review — the owner's original full-automation ask (2026-07-26). Reversible:
// set {"codex":{"auto":false}} (or delete the config) to restore the relay + IDE visibility.
let CODEX_AUTO = false;
try { CODEX_AUTO = !!((JSON.parse(require("fs").readFileSync(require("path").join(process.cwd(), "orch.config.json"), "utf8")).codex || {}).auto); } catch { /* no config → manual relay */ }
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync, spawnSync, spawn } = require("child_process");

const CR_DIR = path.join(process.cwd(), "crs");
const HARNESS_DIR = (ORCH_CFG_EARLY().harness || {}).dir || "server";
const HARNESS_PORT = (ORCH_CFG_EARLY().harness || {}).port || 4400;
const HARNESS_TIMEOUT_MIN = (ORCH_CFG_EARLY().harness || {}).timeoutMin || 5;
function ORCH_CFG_EARLY(){ try { return JSON.parse(require("fs").readFileSync(require("path").join(process.cwd(), "orch.config.json"), "utf8")); } catch { return {}; } }
const ORCH_CFG = (()=>{ try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "orch.config.json"), "utf8")); } catch { return {}; } })();
const SELF_BYTES = (()=>{ try { return fs.readFileSync(__filename); } catch { return Buffer.alloc(0); } })();   // for byte-exact hot-reload detection
// v104: REAL Claude usage measurement (orch/claude-usage.cjs reads the Claude Code
// session transcripts). Optional at runtime — a project missing the module simply
// records tokens=? (honest unknown), never a fabricated number.
const CU = (()=>{ try { return require(path.join(__dirname, "orch", "claude-usage.cjs")); } catch { return null; } })();
// Spend class per gate (v104): what a solo agent would also pay (build/spec) vs
// pipeline-only cost (rework/ceremony). Report-side logic reclassifies runs 2..n of
// any gate as rework; this is the NATURAL class written at record time.
function gateClass(gate){
    if (/^(Building|Fast build)/i.test(gate)) return "build";
    if (/^(Requirement|Prepare deploy)/i.test(gate)) return "spec";
    if (/^(Revise|Root cause)/i.test(gate)) return "rework";
    if (/^(Sign-off|Fast close|Retrospective)/i.test(gate)) return "ceremony";
    if (/^Solo baseline/i.test(gate)) return "solo";
    return "review";   // codex clearances/tests/security
}
const POLL_MS = 3000;

// ---- one-shot CLI commands (verified working) ----
// Model policy (OWNER DIRECTIVE): Claude uses OPUS for EVERYTHING by default. Fable is
// NOT used automatically anywhere — only when the owner explicitly asks for it on a
// specific run. (The earlier "fable for design+build" default was retracted.)
// Codex pinned to gpt-5.6-sol. Grok uses SuperGrok subscription default (no flag).
function claudeModel(_gate){ return "opus"; }
// argv arrays (NOT shell strings) → invoked via execFileSync, so the prompt is passed
// as ONE literal argument with NO shell involved. Critical: CR prompts are full of
// backticks and $-expressions (`req.body.position_id`, WHERE id=$1) which, in a
// shell double-quoted string, trigger command substitution / var expansion and make
// the command fail to parse. execFileSync sidesteps the shell entirely.
const AGENT_ARGV = {
  claude: (p, model) => ["claude", ["-p", p, "--model", model||"opus", "--dangerously-skip-permissions"]],
  codex:  (p) => ["codex", ["exec", "-m", "gpt-5.6-sol", p]],
  grok:   (p) => ["grok", ["--no-auto-update", "-p", p]],
};
const DEPLOY_CMDS = {
  staging: "echo 'staging: no environment yet - skipped'",
  production: "",
};
// ---------------------------------------------------

// ---- tiny console helpers (color + timestamp) ----
const C = { dim:"\x1b[2m", reset:"\x1b[0m", cyan:"\x1b[36m", green:"\x1b[32m",
            yellow:"\x1b[33m", red:"\x1b[31m", bold:"\x1b[1m", mag:"\x1b[35m" };
const now = () => new Date().toLocaleTimeString();
let _laneN = 0;                       // lines the live 7-step board currently occupies
// Any other output ERASES the live board first, prints as scroll history, and lets the
// next render redraw the ONE board underneath. (v56: previously this just forgot the
// board — leaving it on screen — so every state-change log line stacked a fresh panel:
// the "multiple windows of one CR" bug.)
const _resetLane = () => {
  if (_laneN > 0){ process.stdout.write(`\x1b[${_laneN}A\x1b[0J`); _laneN = 0; }
  if (typeof _lastRender !== "undefined") _lastRender.clear();  // force the next tick to redraw the board
};
const log  = (s) => { _resetLane(); console.log(`${C.dim}${now()}${C.reset}  ${s}`); };
const banner = (s, col=C.cyan) => { _resetLane(); console.log(`\n${col}${C.bold}${s}${C.reset}`); };
const AGENT_COLOR = { claude:C.mag, codex:C.cyan, grok:C.yellow };
// ---------------------------------------------------

function q(s) { return JSON.stringify(s); }

// Robust verdict extraction. Agents (esp. Grok) narrate reasoning BEFORE the verdict
// and often bold it (`**REOPEN**`), so "first keyword in the first 3 lines" was wrong —
// it once grabbed "CLOSE" from the preamble "…issue CLOSE or REOPEN" and false-closed a
// REOPEN. Strategy: strip markdown, then take the verdict from the LAST line that BEGINS
// with a verdict keyword (the conclusion), ignoring prose and bullet lines.
const VERDICT_RE = /^(PASS|FAIL|COMPLETED|APPROVE|REJECT|CLOSE|REOPEN|REVISED|BUILT|READY|NEEDS[- ]HUMAN)\b/i;
function parseVerdict(out){
  const lines = String(out).replace(/[*`_>#]/g,"").split("\n").map(l=>l.trim()).filter(Boolean);
  let v = null;
  for (const l of lines){
    const m = l.match(VERDICT_RE); if (!m) continue;
    let tok = m[1];
    // FALSE-GREEN fix (CR-0012 Security Clearance): "PASS or FAIL decision: FAIL" BEGINS
    // with PASS but concludes FAIL. On an explicit decision/verdict line, the LAST keyword
    // is the conclusion; plain lines keep begins-with (so "FAIL: does not PASS X" stays FAIL).
    if (/decision|verdict/i.test(l)){
      const all = l.match(/\b(PASS|FAIL|COMPLETED|APPROVE|REJECT|CLOSE|REOPEN|REVISED|BUILT|READY|NEEDS[- ]HUMAN)\b/gi);
      if (all && all.length > 1) tok = all[all.length-1];
    }
    v = tok.toUpperCase().replace(/\s+/,"-");
  }
  return v; // null if none found
}
const GOOD_VERDICT = /^(PASS|COMPLETED|APPROVE|CLOSE|REVISED|BUILT|READY)$/;
const BAD_VERDICT  = /^(FAIL|REJECT|REOPEN)$/;

// The 7-step TEAM lane, printed as a live progress tracker (like the startup ✓ list).
// Each row: mark (✓ done / ▶ current / ✗ failing / · pending) + summed time + tokens,
// derived from the sidecar's METRIC lines and the CR's current status.
const LANE = [
  // Step 1 is the requirement→CR authoring the orch used to never see (a CR only becomes
  // visible once its file exists) — record it like any gate so its cost is on the board.
  { n:1, name:"Requirement -> CR",    gate:"Requirement",                               agent:"claude" },
  { n:2, name:"Classification",       tag:"classify",             agent:"auto" },
  { n:3, name:"Technical Clearance",  gate:"Technical Clearance", status:"DRAFT",       agent:"codex" },
  { n:4, name:"Security Clearance",   gate:"Security Clearance",  status:"DRAFT",       agent:"codex" },
  { n:5, name:"Building",             gate:"Building",            status:"BUILD",       agent:"claude" },
  { n:6, name:"Test",                 gate:"Test",                status:"TESTING",     agent:"codex" },
  { n:7, name:"Security (code)",      gate:"Security Review (code)", status:"TESTING",  agent:"codex" },
  { n:8, name:"Deploy",               status:"DEPLOY_WAIT",       agent:"you" },
  { n:9, name:"Sign-off",             gate:"Sign-off",            status:"SIGNOFF",     agent:"claude" },
];
// Unambiguous mm:ss so "5.0m" can't be misread; totals below are SUMMED across all
// attempts of a step (a step that failed + retried shows the combined spend).
const _fmtT = s => s>=60 ? `${Math.floor(s/60)}m${String(s%60).padStart(2,"0")}s` : `${s}s`;
const _WORD = { PASS:"PASS", APPROVE:"PASS", COMPLETED:"COMPLETED", CLOSE:"Success",
                READY:"ready", REVISED:"revised", FAIL:"FAIL", REJECT:"FAIL", REOPEN:"REOPEN" };
const _strip = s => s.replace(/\x1b\[[0-9;]*m/g, "");
// CRs parked on the HUMAN (other than the one being rendered). The board is single-CR but
// the pipeline is multi-CR: without this, an ESCALATED CR's owner-question scrolls away
// once and the window forever shows only the active CR's demand ("tell CODEX: review")
// while the operator unknowingly owes a ruling elsewhere.
function humanQueue(exceptPath){
  try {
    return fs.readdirSync(CR_DIR).filter(f=>/^CR-\d+.*\.md$/i.test(f)).sort()
      .map(f=>({ p: path.join(CR_DIR, f), id: f.replace(/\.md$/,"") }))
      .filter(x=>path.resolve(x.p)!==path.resolve(exceptPath||""))
      .map(x=>({ id:x.id, s:((fs.readFileSync(x.p,"utf8").match(/\*\*Status:\*\*\s*([A-Z_]+)/i)||[])[1]||"").toUpperCase() }))
      .filter(x=>["ESCALATED","DEPLOY_WAIT","FAST_DEPLOY"].includes(x.s))
      .map(x=>`${x.id} (${x.s==="ESCALATED"?"owner ruling needed":"deploy + paste output"})`).join(" · ");
  } catch { return ""; }
}
const _pad = (s, w) => s + " ".repeat(Math.max(0, w - _strip(s).length));
function printLane(crPath, status, running, opts){
  opts = opts || {};
  // Size the panel to the terminal so a row can NEVER exceed the width and wrap — a
  // wrapped row would break the in-place cursor-rewind and stack the board (the trail bug).
  const _W = Math.max(50, Math.min(86, (process.stdout.columns || 90) - 4));
  const gAll = readGates(crPath);
  // Row verdicts read the CURRENT review scope (after the last revision/retry/owner
  // marker) — a PREVIOUS revision's PASS must not render as this revision's ✓ (Security
  // showed green while the revised spec still owed its re-run). Metrics/fail counts stay
  // whole-file: history is additive, verdicts are scoped.
  const _scopeIdx = Math.max(gAll.lastIndexOf("## Revision"), gAll.lastIndexOf("### Build retry"),
    gAll.lastIndexOf("### Owner decision"), gAll.lastIndexOf("### Recovery"), gAll.lastIndexOf("### Status correction"));
  const g = _scopeIdx >= 0 ? gAll.slice(_scopeIdx) : gAll;
  const metrics = [...gAll.matchAll(/<!--METRIC gate="([^"]*)" agent="([^"]*)"(?: model="([^"]*)")?[^>]*?seconds=(\d+) tokens=(\S+)[^>]*-->/g)];
  const per = {};
  // Rework split: a gate's first run is development; runs 2..n of the SAME gate — plus all
  // Revise/Root-cause spend (they exist only because a gate failed) — are circulation cost.
  let allTok=0, reworkTok=0;
  for (const m of metrics){
    const k=m[1]; per[k]=per[k]||{sec:0,tok:0,unk:false,runs:0}; per[k].sec+=+m[4]; per[k].agent=m[2]; per[k].model=m[3];
    per[k].runs++;
    if(/^\d+$/.test(m[5])){ const t=+m[5]; per[k].tok+=t; allTok+=t;
      if (/^(Revise|Root cause)$/i.test(k) || per[k].runs>1) reworkTok+=t;
    } else per[k].unk=true;
  }
  const lastVerdict = (gate)=>{ const re=new RegExp("### Gate: "+gate.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+" \\([^\\n]*\\n\\n([\\s\\S]*?)(?=\\n### |\\n<!--|$)","g"); let mm,v=null; while((mm=re.exec(g))){ const pv=parseVerdict(mm[1]); if (pv) v=pv; } return v; };
  const order = ["DRAFT","BUILD","TESTING","BUILD_DEPLOY","DEPLOY_WAIT","SIGNOFF","CLOSED"];
  const curRank = order.indexOf(status);
  let totSec=0, totTok=0;
  const dots=[];
  // Only ONE row is the "active" step at a time. A pipeline stage can hold several gates that
  // share the same status (e.g. DRAFT = Technical Clearance + Security Clearance); without this
  // guard EVERY gate in the current status lit up as "▶" together. activeShown flips true once we
  // paint the active row, so later same-status gates that aren't done yet stay dim "pending".
  // A NON-lane running step (Revise/Root cause) means the pipeline is PAUSED on Claude:
  // no lane row may claim the "▶ active" fallback (else the next queued gate lights up
  // yellow and reads as in-progress), and the title carries the paused state visibly.
  const pausedOn = running && !LANE.some(s=>s.gate===running) ? String(running) : null;
  let activeShown = !!pausedOn;
  const rows = LANE.map(s=>{
    let mark="·", col=C.dim, st="", dot="·";
    delete s.__why;
    const met = s.gate && per[s.gate];
    const v = s.gate ? lastVerdict(s.gate) : null;
    const classified = s.tag==="classify" && /### Classification/.test(gAll);
    const deployDone = s.n===6 && ["SIGNOFF","CLOSED"].includes(status);
    if (running && s.gate===running && !(v&&GOOD_VERDICT.test(v))){ mark=opts.spin||"▶"; col=C.yellow; st= opts.runLabel ? opts.runLabel : opts.awaiting ? "awaiting you" : (opts.elapsed!=null?`running ${_fmtT(opts.elapsed)}`:"running…"); dot="◆"; activeShown=true; }
    else if (v && GOOD_VERDICT.test(v)){ mark="✓"; col=C.green; st=_WORD[v]||"PASS"; dot="●"; }
    else if (v && BAD_VERDICT.test(v)){ mark="✗"; col=C.red; st=(_WORD[v]||v)+" → revising"; dot="✗"; }
    else if (classified){ mark="✓"; col=C.green; st="done"; dot="●"; }
    else if (deployDone){ mark="✓"; col=C.green; st="Success"; dot="●"; }
    else if (!activeShown && s.status===status && status!=="CLOSED"){ mark="▶"; col=C.yellow; st="..."; dot="◆"; activeShown=true; }
    else if (s.status && order.indexOf(s.status) < curRank){
      if (v || met){ mark="✓"; col=C.green; st=_WORD[v]||"PASS"; dot="●"; }
      else { mark="-"; col=C.dim; st="skipped"; dot="o"; s.__why = "lean lane - reviewed at code time"; }
    }
    dots.push(`${col}${dot}${C.reset}`);
    if (met){ totSec+=met.sec; totTok+=met.tok; }
    // While a step is actively running, opts.runWho can name the TRUE runner — e.g. the
    // orch-run machine harness on the Test row, which otherwise displays as codex and
    // sends the operator to check an idle Codex session.
    const whoRunning = running && s.gate===running && !(v&&GOOD_VERDICT.test(v)) && opts.runWho;
    const who = whoRunning ? opts.runWho : met ? (met.agent + (met.model?"·"+met.model:"")) : (s.agent + (s.model?"·"+s.model:""));
    // How many times THIS step failed → how many revisions it caused (answers "which step").
    const fails = s.gate ? (gAll.match(new RegExp("### Gate: "+s.gate.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+" \\([\\s\\S]{0,400}?\\n\\n(FAIL|REJECT|REOPEN)","gi"))||[]).length : 0;
    const isRunning = running && s.gate===running && !(v&&GOOD_VERDICT.test(v));
    let meta = s.__why ? s.__why
             : s.tag==="classify" && classified ? "instant"
             : met ? `${_fmtT(met.sec)}${met.tok?" · "+met.tok.toLocaleString()+"t":""}` : "";
    if (isRunning && opts.activity) meta = opts.activity;                 // live "what it's doing"
    // ASCII only: "⟲" renders 2 columns wide in some terminals while the padding math counts 1 —
    // the row wraps, the in-place eraser under-counts, and orphaned board tops pile up.
    if (!isRunning && fails>0) meta += `${meta?" · ":""}x${fails} rev${fails>1?"s":""}`;
    // Fixed columns first; then clamp meta to whatever width remains so the row can't overflow.
    const head = `${col}${mark} ${C.dim}${s.n}${C.reset} ${col}${_pad(s.name,20)}${C.reset} ${C.dim}${_pad(who,12)}${C.reset} ${col}${_pad(st,11)}${C.reset}`;
    const budget = _W - _strip(head).length - 1;
    if (_strip(meta).length > budget) meta = budget > 2 ? meta.slice(0, budget-2) + ".." : "";
    const left = `${head} ${C.dim}${meta}${C.reset}`;
    return `${C.dim}│${C.reset} ${_pad(left,_W)} ${C.dim}│${C.reset}`;
  });
  const bcol = status==="ESCALATED"?C.red : status==="CLOSED"?C.green : pausedOn ? C.mag : C.cyan;
  const crText = fs.readFileSync(crPath,"utf8");
  const rc = getRevisions(crText);
  // Meaningful title from the CR's H1: "CR-0004: <title>", truncated to fit, [STATUS] right.
  // While paused on Claude the tag says so: [DRAFT · REVISING] instead of a bare [DRAFT].
  const dispStatus = pausedOn ? `${status} · ${/revise/i.test(pausedOn)?"REVISING":pausedOn.toUpperCase().replace(/\s+/g,"-")}` : status;
  const statusTag = `${C.bold}${bcol}[${dispStatus}]${C.reset}`;
  const avail = _W - _strip(statusTag).length - 1;
  let h1 = (crText.match(/^#\s+(.+)/m)||[])[1] || path.basename(crPath).replace(/\.md$/,"");
  if (h1.length > avail) h1 = h1.slice(0, avail-2).trimEnd() + "..";
  const title = `${C.bold}${bcol}${h1}${C.reset}`;
  const top = `${bcol}╭${"─".repeat(_W+2)}╮${C.reset}`;
  const bot = `${bcol}╰${"─".repeat(_W+2)}╯${C.reset}`;
  const mid = `${bcol}├${"─".repeat(_W+2)}┤${C.reset}`;
  const titleRow = `${C.dim}│${C.reset} ${_pad(title,avail)} ${statusTag} ${C.dim}│${C.reset}`;
  const bar = dots.join("");
  const rw = reworkTok>0 ? ` · ${C.mag}rework ${(reworkTok/1000).toFixed(1)}k/${allTok?Math.round(reworkTok/allTok*100):0}%${C.reset}${C.dim}` : "";
  const footer = `${C.dim}│${C.reset} ${_pad(`${bar}   ${C.dim}Σ ${_fmtT(totSec)} · ${totTok.toLocaleString()}t${rw} · CR revisions ${rc}/3${C.reset}`,_W)} ${C.dim}│${C.reset}`;
  // The action prompt (if any) is the LAST line of the SAME block — counted in _laneN — so the
  // next state-change redraws board+prompt together in place. Printing it via banner() instead
  // would _resetLane() and stack a fresh panel on every change (the "multiple windows" bug).
  let block = [top, titleRow, mid, ...rows, mid, footer, bot].join("\n");
  if (opts.prompt) block += "\n" + opts.prompt;
  const hq = humanQueue(crPath);
  if (hq) block += "\n" + _fitLine(`${C.red}${C.bold}⏸ also waiting on YOU:${C.reset} ${C.red}${hq}${C.reset}`);
  const n = block.split("\n").length;
  if (_laneN > 0) process.stdout.write(`\x1b[${_laneN}A\x1b[0J`);
  process.stdout.write(block + "\n");
  _laneN = n;
}

// ─── NEXT line: ONE line under the board saying who to poke and the exact word to say —
// `▶ NEXT — tell CLAUDE: revise`. All detail (findings file, record command) lives in
// `node orchestrator.cjs now`. Clamped to terminal width so it can never wrap (a wrapped
// line would desync the in-place cursor-rewind and stack panels).
function _fitLine(s){
  const w = Math.max(46, (process.stdout.columns || 90) - 2);
  const raw = _strip(s); return raw.length <= w ? s : raw.slice(0, w-2) + "..";
}
function nextLine(col, agent, say, note){
  const tail = note ? `${C.dim}  · ${note}${C.reset}` : "";
  return _fitLine(`${col}${C.bold}▶ NEXT — tell ${String(agent).toUpperCase()}:  ${say}${C.reset}${tail}`);
}
// Busy state: a STATUS, not an instruction — "▶ CODEX is testing…". Verb derived from the gate.
function busyLine(col, agent, gate, note){
  const verb = /test/i.test(gate) ? "testing" : /revis|root/i.test(gate) ? "revising"
             : /clearance|review|sign/i.test(gate) ? "reviewing"
             : /deploy/i.test(gate) ? "preparing deploy" : /build/i.test(gate) ? "building" : "working";
  const tail = note ? `${C.dim}  · ${note}${C.reset}` : "";
  return _fitLine(`${col}${C.bold}▶ ${String(agent).toUpperCase()} is ${verb}…${C.reset}${tail}`);
}

// Render the board ONLY when the CR's state changed since the last render — otherwise the
// tick would reprint the same board every poll (3s) while paused at an in-session gate,
// stacking panels. Signature = status + running gate + sidecar size (grows on record/revise).
const _lastRender = new Map();
function renderIfChanged(crPath, status, running, opts){
  const sig = status + "|" + (running||"") + "|" + (opts&&opts.awaiting?"A":"") + "|" + (opts&&opts.runLabel?"R:"+opts.runLabel:"") + "|" + (opts&&opts.prompt?opts.prompt:"") + "|" + readGates(crPath).length + "|" + humanQueue(crPath);
  if (_lastRender.get(crPath) === sig) return false;
  _lastRender.set(crPath, sig);
  printLane(crPath, status, running, opts);
  return true;
}

// Shared decision-boundary rule injected into every agent prompt.
// The human is scarce: agents resolve ALL technical/implementation choices
// themselves and record them; they escalate ONLY genuine business/policy or
// scope questions.
const DECISION_POLICY =
  "DECISION BOUNDARY (critical, read carefully): You resolve EVERY technical, " +
  "implementation, AND testing decision yourself. This explicitly includes: file " +
  "locations, dependency wiring, code structure, naming, refactors, library choices, " +
  "query shape, AND how to test or verify something (test design, harness approach, " +
  "white-box vs black-box, what to assert, whether a case is worth an automated test " +
  "vs code review). For ANY such question, pick the best/Recommended option, state " +
  "your choice + one-line rationale, and PROCEED. Do NOT ask the human. " +
  "You may escalate ONLY when the decision is genuinely one of these two: " +
  "(a) BUSINESS/POLICY — how the product should behave for its users: who is allowed " +
  "to do something, what a permission or role should be, pricing, data retention, " +
  "user-facing rules; or (b) SCOPE — something beyond what the CR actually asked for. " +
  "Test methodology, verification approach, and 'how do we prove X in code' are NEVER " +
  "escalation-worthy — they are yours to decide. Litmus test: if a competent engineer " +
  "could answer it without asking the product owner, YOU answer it. Only if it truly " +
  "requires the product owner's business judgment do you escalate, prefixed " +
  "'ESCALATE-TO-HUMAN:' on the FIRST line. The owner is NOT technical: an escalated " +
  "question must be pure product/process language — zero code identifiers, file names, or " +
  "jargon — and must carry a recommendation plus the plain consequence of each option.";

// Deterministic FAST/TEAM classification from the CR's declared file list.
// Returns "FAST" (bypass review) or "TEAM" (full review). Safe default: TEAM.
function classifyCR(crText){
  // Pull the "expected files" the CR declares. Convention: a line list under
  // "Files/components expected to change:" or a fenced ```files block```.
  let files = [];
  const fb = crText.match(/```files\s*([\s\S]*?)```/i);
  if (fb) files = fb[1].split("\n").map(x=>x.trim()).filter(Boolean);
  if (!files.length){
    const sec = crText.match(/expected to change:?\s*([\s\S]*?)(\n\s*\n|##|$)/i);
    if (sec) files = sec[1].split("\n").map(x=>x.replace(/^[-*\s]+/,"").trim()).filter(Boolean);
  }
  const COSMETIC = [/\.css$/i,/\.scss$/i,/\.less$/i,/\.md$/i,/\.txt$/i,/\.(png|jpe?g|gif|svg|webp|ico)$/i];
  const SUBSTANTIVE = [/\.jsx?$/i,/\.tsx?$/i,/\.mjs$/i,/\.cjs$/i,/\.sql$/i,/migrat/i,/route/i,/auth/i,/middleware/i,/\.env/i,/config/i,/package(-lock)?\.json$/i,/\.ya?ml$/i,/server\//i,/api\//i];
  if (!files.length) return { tier:"TEAM", reason:"no declared file list — cannot prove trivial" };
  const sub = files.filter(f=>SUBSTANTIVE.some(re=>re.test(f)));
  if (sub.length) return { tier:"TEAM", reason:`touches substantive files: ${sub.slice(0,4).join(", ")}` };
  if (files.every(f=>COSMETIC.some(re=>re.test(f)))) return { tier:"FAST", reason:`cosmetic only: ${files.join(", ")}` };
  return { tier:"TEAM", reason:"unrecognized files — defaulting to review" };
}

// ---- multi-CR dependency awareness -----------------------------------------
// A CR must not run while another still-open CR it depends on — or shares files
// with — is in flight (parallel edits to the same file race the working tree, the
// exact hazard that produced the CR-0003 revert mess). Detection is deterministic:
//  · explicit "Depends on CR-XXXX" in the CR text
//  · file-path overlap between the two CRs' declared files
// Over-matching is the SAFE direction here (queue rather than race).
const PARKED = s => ["ESCALATED","DEPLOY_WAIT","FAST_DEPLOY","PRODUCTION"].includes(s);
function filesOf(text){
  const set = new Set();
  const re = /([\w./-]+\.(?:jsx?|tsx?|mjs|cjs|sql|json|css|scss|md))/g;
  let m; while ((m = re.exec(text))) set.add(m[1].replace(/^\.?\//,""));
  return set;
}
function dependsOn(text){
  const ids = new Set(); let m;
  const re = /depends?\s+on[^\n]*?\b(CR-\d{3,})/gi;
  while ((m = re.exec(text))) ids.add(m[1]);
  return [...ids];
}
function overlaps(a, b){ for (const x of a) if (b.has(x)) return x; return null; }
// Pull the exact shell from the CR's "### Deploy commands" section (fenced blocks) so the
// orch can print copy-paste-ready Ubuntu commands at DEPLOY_WAIT instead of a file pointer.
function deployCommands(crText){
  const sec = crText.match(/###\s*Deploy commands([\s\S]*?)(?=\n##\s|\n###\s|$)/i);
  if (!sec) return null;
  const blocks = [...sec[1].matchAll(/```(?:bash|sh)?\s*\n([\s\S]*?)```/g)].map(b=>b[1].replace(/\s+$/,""));
  return blocks.length ? blocks.join("\n\n") : null;
}

// Track which CRs we've already prompted for, so we don't re-ask every poll.
const awaitingAt = new Map();  // CR file -> last WAITING print time
const lastGate = new Map();
const _noVerdictAt = new Map();   // "cr|gate" → ts of last verdict-less agent run (backoff)    // CR path -> {agent, gate, secs, tokens} of the previous gate (console telemetry)

// ---- per-CR event log (future reference / analysis) -----------------------
// One JSONL file per CR under logs/: every gate run (agent, verdict, secs, tokens),
// every status transition, classification, rejection routing and escalation — with
// timestamps. Grep-able and trivially loadable for analysis. The CR file stays the
// human audit trail; this is the machine one.
const LOG_DIR = path.join(__dirname, "logs");
function crLog(crPath, event){
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive:true });
    const id = path.basename(crPath).replace(/\.md$/i, "");
    fs.appendFileSync(path.join(LOG_DIR, `${id}.jsonl`),
      JSON.stringify({ ts:new Date().toISOString(), ...event }) + "\n");
  } catch(e){ log(`${C.yellow}crLog failed (non-fatal): ${e.message}${C.reset}`); }
}

// ---- gates sidecar --------------------------------------------------------
// The CR file is FROZEN after DRAFT (small, stable, cache-friendly: every gate
// reads the same text). All orchestrator output — gate verdicts, METRIC lines,
// classification, retry/revision markers, deploy runs, the close report — goes
// to crs/.gates/CR-XXXX.md instead. Human-readable audit trail; tracked in git.
const GATES_DIR = path.join(CR_DIR, ".gates");
function gatesPath(crPath){
  return path.join(GATES_DIR, path.basename(crPath));
}
function readGates(crPath){
  try { return fs.readFileSync(gatesPath(crPath), "utf8"); } catch { return ""; }
}
function appendGates(crPath, chunk){
  if (!fs.existsSync(GATES_DIR)) fs.mkdirSync(GATES_DIR, { recursive:true });
  fs.appendFileSync(gatesPath(crPath), chunk);
}

// A REJECT/FAIL/REOPEN never escalates by itself: it routes straight back to Claude,
// who revises the CR per its best expertise. Only Claude escalates, and only when a
// genuine OWNER decision is required.
const REVISE_ROLE =
  "You are the builder. A clearance/test did NOT pass (Technical Clearance, Security " +
  "Clearance, or Test returned FAIL) — its remarks are in the latest gate-log entry " +
  "(also quoted below). Fix every observation yourself, to your best " +
  "knowledge, capability and expertise, keeping the product requirement and quality " +
  "intact — honestly: address the substance, never game the wording. Edit the CR " +
  "file directly: revise the affected sections IN PLACE, keeping the CR lean. Do NOT " +
  "append revision headings, gate logs, or history to the CR — the orchestrator " +
  "tracks all of that in a separate gates file. Do NOT change Status.\n" +
  "Escalate ONLY if a remark genuinely requires the product owner's BUSINESS/POLICY " +
  "or SCOPE decision (who may do what, permissions/pricing/retention, user-facing " +
  "behavior changes beyond the request). Never escalate technical/implementation/" +
  "testing questions — decide those yourself and record the decision.\n" +
  "FIRST line of your reply: 'REVISED' (all remarks handled) or " +
  "'NEEDS-HUMAN: <the specific owner question, plain language, one line>'.";

// Injected into every REVIEW role so a reviewer never false-rejects a CR for infra
// this project deliberately doesn't have yet. Mirrors WORKFLOW.md "Infrastructure reality".
const INFRA_REALITY =
  "INFRASTRUCTURE REALITY (binding): this project has NO CI, NO staging, NO artifact " +
  "pipeline, NO test runner, and NO browser/visual-regression tooling — accepted, by " +
  "design (see WORKFLOW.md 'Infrastructure reality'). Do NOT reject or fail a CR merely " +
  "because it lacks SAST/DAST, immutable artifacts, staging verification, automated " +
  "visual-regression, or an automated test suite, and do NOT demand the automated form " +
  "of these. The accepted SUBSTITUTES are the standard: `node --check` for build " +
  "validation; one executable `verify-*.mjs` harness (node+pg+fetch, HTTP+DB assertions) " +
  "for tests; human-attached before/after screenshots + your own review for UI/visual; " +
  "the separate security session's adversarial pass + code-level review for security. Reject ONLY if the " +
  "substitute itself is missing, wrong, or insufficient — never for the absent automation.";

// v105: the security gates apply SECURITY_MODEL.md (repo root) — ten buckets, a
// product-specific severity ranking (cross-tenant first), an applicability routing
// table, and a binding honesty contract (explicit ten-bucket triage; absence of
// evidence is a finding; a CR's own claim is never evidence). The document is read
// ON DEMAND by path; only this ~300-token pointer rides in the prompt.
const SECURITY_STANDARD =
  "SECURITY STANDARD: apply SECURITY_MODEL.md (repo root) — read it now if you have not. " +
  "It defines ten buckets (identity, authorization, tenancy, input handling, data protection, " +
  "business-logic abuse, supply chain, observability, transport/response hygiene, client-side " +
  "trust), a product-specific severity ranking, and an applicability routing table keyed to " +
  "the files this CR declares.\n" +
  "TRIAGE IS MANDATORY AND EXPLICIT: list ALL TEN buckets, each marked APPLIES / N/A (with a " +
  "one-line reason) / COVERED (with where). A bucket you omit counts as an unexamined APPLIES. " +
  "Do NOT mark N/A because the CR asserts it — a CR's claim is under review, not evidence. Do " +
  "NOT mark a harness-assertable bucket COVERED by code review alone.\n" +
  "THE CLIENT IS NOT A TRUST BOUNDARY: anything the browser receives is visible in DevTools. " +
  "A UI filter, a hidden button, or a client-side export is never access control. For any " +
  "data-returning route, the question is what the ENDPOINT returned, not what the UI displayed.\n" +
  "HONESTY: absence of evidence is a finding, not a pass — say what you could not verify and " +
  "what would settle it. If you find yourself building an argument for why something needn't " +
  "be checked, report that tension instead of resolving it toward PASS. Under-declared risk is " +
  "itself a finding; higher class wins on the RISK line.\n" +
  "OUTPUT: FIRST line PASS or FAIL. SECOND line RISK=<Low|Moderate|Material|Critical>. THEN " +
  "the ten-bucket triage, one line each. THEN findings with bucket, file:line, impact, fix.";

// v106: the Test gate applies TESTING_MODEL.md — three proof obligations (P1 requirement
// fidelity vs the owner's VERBATIM words, P2 functional correctness, P3 harness-asserted
// security buckets), the self-verification rules (mutation check, no tautologies), and
// the judgement that a green harness with weak assertions is a FAIL with reasons.
const TESTING_STANDARD =
  "TESTING STANDARD: apply TESTING_MODEL.md (repo root) — read it now if you have not. " +
  "The orchestrator ALREADY ran the harness on the host and its output is in the gate file; do " +
  "NOT try to run it. 'Did it pass' is settled. Your question is whether PASSING MEANS ANYTHING, " +
  "across THREE obligations.\n" +
  "P1 REQUIREMENT FIDELITY: read the VERBATIM owner requirement in CR section 1, not just the " +
  "ACs. Every distinct phrase must appear in the CR's requirement trace table. Any owner-specified " +
  "literal string that was renamed, reordered, or dropped without a named deviation and rationale " +
  "is a FINDING — the ACs are an interpretation, and drift between them and the owner's words is " +
  "invisible to any test that starts from the ACs.\n" +
  "P2 FUNCTIONAL: (a) AC coverage — every AC mapped to a named assertion, list any that is not; " +
  "(b) assertion strength — would it pass on wrong behaviour? (c) class balance — anything beyond " +
  "happy path (negative, regression, boundary)? (d) tautology — does any assertion compare the " +
  "code against itself rather than the CR's specified value? (e) mutation evidence — did the " +
  "builder record that critical assertions FAIL when the change is reverted?\n" +
  "P3 SECURITY: for every SECURITY_MODEL.md bucket the security triage marked APPLIES and that is " +
  "marked [H] harness-assertable, there must be an assertion. A bucket that is applicable AND " +
  "assertable but only code-reviewed is a downgrade — report it.\n" +
  "A green harness with weak assertions is a FAIL WITH REASONS, not a PASS. A declared gap is " +
  "honest and judged on its merits; a silently untested AC is a finding. Absence of evidence is a " +
  "finding — say what you could not verify and what would settle it.\n" +
  "OUTPUT: FIRST line PASS or FAIL. THEN P1 trace result. THEN P2 AC coverage, one line each. " +
  "THEN P3 bucket coverage. THEN findings.";

// v25 squeezed TEAM lane — ONE review pass (v24 ran feasibility+risk at DRAFT and then
// tech+security again at APPROVED: 4 review gates per CR; halved to 2). Human stays in
// the loop at deploy: nothing ships until they run the commands and paste output.
const PIPELINE = [
  { status:"DRAFT", gates:[
      { agent:"codex", gate:"Technical Clearance", inSession:true,
        role:"(in-session) You are Codex, the independent technical reviewer. Run the review in your Codex session, then record the verdict." },
      { agent:"codex", gate:"Security Clearance",
        role:"You are the independent security/risk reviewer per WORKFLOW.md (single combined pass, PRE-BUILD: you review the CR's design). "+SECURITY_STANDARD+" "+INFRA_REALITY },
    ], next:()=>"BUILD" },

  // ---- FAST lane (cosmetic-only CRs, verified by classify.cjs) ----
  { status:"FAST_BUILD", gates:[
      { agent:"claude", gate:"Fast build + self-test", inSession:true,
        role:"(in-session) Claude builds + self-tests the FAST CR in this session, then records." },
    ], next:()=>"FAST_DEPLOY" },

  { status:"FAST_DEPLOY", gates:[], next:()=>null },   // human deploys, pastes output, sets FAST_CLOSE

  { status:"FAST_CLOSE", gates:[
      { agent:"claude", gate:"Fast close report", inSession:true,
        role:"(in-session) Claude writes the FAST closure note in this session, then records." },
    ], next:()=>"CLOSED" },

  // ---- Squeezed TEAM lane (7 steps) ----
  // 1 CR (DRAFT+classify) → 2 Codex tech review → 3 Grok security review (both above)
  //   → BUILD → 4 Codex test → 5 Claude prepare deploy (push + pull cmd)
  //   → 6 human runs pull on Ubuntu, pastes output → 7 Grok signoff+close
  { status:"BUILD", gates:[
      { agent:"claude", gate:"Building", inSession:true,
        role:"(in-session) Claude implements the CR in this session, commits, then records." },
    ], next:()=>"TESTING" },

  { status:"TESTING", gates:[
      { agent:"codex", gate:"Test", inSession:true,
        role:"You are the independent Test reviewer: judge the committed diff AND whether the harness's green run proves the CR. "+TESTING_STANDARD },
      { agent:"codex", gate:"Security Review (code)",
        role:"You are the independent security reviewer. LEAN LANE: you review the COMMITTED CODE of this change (harness output + gate history are in the gate file) — attack THE ACTUAL DIFF, not the prose. On the lean lane this is the ONLY security review a Low/Moderate CR receives. "+SECURITY_STANDARD+" "+INFRA_REALITY },
    ], next:()=>"BUILD_DEPLOY" },

  { status:"BUILD_DEPLOY", gates:[
      { agent:"claude", gate:"Prepare deploy", inSession:true,
        role:"(in-session) Claude pushes + writes the '### Deploy commands' into the CR in this session, then records READY." },
    ], next:()=>"DEPLOY_WAIT" },

  { status:"DEPLOY_WAIT", gates:[], next:()=>null },

  { status:"SIGNOFF", gates:[
      // Owner instruction (2026-07-27): the closer is Claude, not Codex. Independence is
      // preserved MECHANICALLY instead of by a second agent: `record … "Sign-off" … CLOSE`
      // refuses unless the ledger proves the deployed commit IS the tested commit, the deploy
      // output shows success, and any declared migration was verified (see the record guard).
      { agent:"claude", gate:"Sign-off", inSession:true,
        role:"You are the closer per WORKFLOW.md. Review the deploy output pasted into the CR and the change as a whole. Confirm the deployment succeeded and acceptance criteria are met. "+INFRA_REALITY+" FIRST line: CLOSE (success) or REOPEN (problem, back to builder), then reasons." },
    ], next:()=>"CLOSED" },
];

function getCycle(text){
  const m = text.match(/build→test cycles:\s*(\d+)/i);
  return m ? parseInt(m[1],10) : 0;
}
function bumpCycle(crPath){
  let t = fs.readFileSync(crPath,"utf8");
  const c = getCycle(t) + 1;
  t = t.replace(/(build→test cycles:\s*)\d+/i, `$1${c}`);
  fs.writeFileSync(crPath, t);
  return c;
}
function getRevisions(text){
  const m = text.match(/CR revisions:\s*(\d+)/i);
  return m ? parseInt(m[1],10) : 0;
}
function bumpRevisions(crPath){
  let t = fs.readFileSync(crPath,"utf8");
  const r = getRevisions(t) + 1;
  t = t.replace(/(CR revisions:\s*)\d+/i, `$1${r}`);
  fs.writeFileSync(crPath, t);
  return r;
}
// Last recorded verdict for a gate in the current scope (after the latest revision/retry
// marker). Used to decide whether an in-session gate is done (PASS), failed (→revise), or
// still awaiting the human to run + record it (no verdict).
function lastGateVerdict(crPath, gateName){
  const text = readGates(crPath);
  const idx = Math.max(text.lastIndexOf("## Revision"), text.lastIndexOf("### Build retry"),
    text.lastIndexOf("### Owner decision"), text.lastIndexOf("### Recovery"), text.lastIndexOf("### Status correction"));
  const scope = idx>=0 ? text.slice(idx) : text;
  const esc = gateName.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  // Robust: parse the WHOLE entry body with parseVerdict — the old first-token regex read
  // "NOT REVIEWED" as verdict "NOT" (neither good nor bad), so the gate looked runnable
  // forever and auto-codex spawned in a refusal loop (3 wasted invocations on CR-0012).
  const re = new RegExp("### Gate: "+esc+" \\([^\\n]*\\n\\n([\\s\\S]*?)(?=\\n### |\\n<!--|$)","g");
  let m,v=null; while((m=re.exec(scope))){ const pv=parseVerdict(m[1]); if (pv) v=pv; } return v;
}
// Reconstruct the FULL CR lifecycle from the JSONL event log: from the requirement
// becoming a CR (file birth) through classification, every review iteration, build,
// test, the human deploy wait, and sign-off — so the close report accounts for
// everything, not just agent gate time.
function lifecycleFromLog(crPath){
  const id = path.basename(crPath).replace(/\.md$/i,"");
  let all;
  try { all = fs.readFileSync(path.join(LOG_DIR, `${id}.jsonl`),"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); }
  catch { return null; }
  if (!all.length) return null;
  const T = s => new Date(s).getTime();
  // Anchor to the CURRENT pipeline run: events at/after the LAST classification (a fresh
  // CR is classified once when first seen at DRAFT). This ignores stale events from any
  // earlier incarnation of the same CR number, so the timeline is always clean.
  let anchorIdx = 0;
  for (let i=all.length-1;i>=0;i--){ if(all[i].type==="classify"){ anchorIdx=i; break; } }
  const events = all.slice(anchorIdx);
  const startTs = T(events[0].ts), closeTs = Date.now();
  const fmt = ms => ms>=60000 ? `${(ms/60000).toFixed(1)}m` : `${Math.round(ms/1000)}s`;
  const statuses = events.filter(e=>e.type==="status");
  const at = to => { const e = statuses.find(s=>s.to===to); return e?T(e.ts):null; };
  const phases = [];
  const gap = (label, a, b) => { if(a!=null && b!=null && b>=a) phases.push(`| ${label} | ${fmt(b-a)} |`); };
  const firstBuild = at("BUILD"), testing=at("TESTING"), bdeploy=at("BUILD_DEPLOY"), dwait=at("DEPLOY_WAIT"), signoff=at("SIGNOFF"), closed=at("CLOSED")||closeTs;
  gap("Classify + Review (DRAFT: all iterations)", startTs, firstBuild || testing || closed);
  gap("Build", firstBuild, testing);
  gap("Test", testing, bdeploy);
  gap("Prepare deploy", bdeploy, dwait);
  gap("Human deploy (wait for you)", dwait, signoff);
  gap("Sign-off → close", signoff, closed);
  return { rows: phases.join("\n"), total: fmt(closed-startTs), startISO: new Date(startTs).toISOString() };
}

// v107: attribute wall-clock so a slow human answer counts as HUMAN latency, not pipeline
// cost. Owner-wait = time the CR sat in a human-gated state (ESCALATED / DEPLOY_WAIT /
// FAST_DEPLOY). Active = agent gate-seconds. System = the remainder (transitions/polling).
function timeAttribution(crPath, byAgent){
  const id = path.basename(crPath).replace(/\.md$/i,"");
  let all;
  try { all = fs.readFileSync(path.join(LOG_DIR, `${id}.jsonl`),"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); }
  catch { return null; }
  if (!all.length) return null;
  let anchor=0; for(let i=all.length-1;i>=0;i--){ if(all[i].type==="classify"){anchor=i;break;} }
  const ev = all.slice(anchor);
  const T = s=>new Date(s).getTime();
  const start=T(ev[0].ts), end=T(ev[ev.length-1].ts), wall=Math.max(0,end-start);
  const statuses = ev.filter(e=>e.type==="status");
  const HUMAN = new Set(["ESCALATED","DEPLOY_WAIT","FAST_DEPLOY"]);
  let ownerWait=0;
  for(let i=0;i<statuses.length;i++){
    if(HUMAN.has(statuses[i].to)){
      const nextTs = i+1<statuses.length ? T(statuses[i+1].ts) : end;
      ownerWait += Math.max(0, nextTs - T(statuses[i].ts));
    }
  }
  const claudeSec=(byAgent.claude&&byAgent.claude.sec)||0, codexSec=(byAgent.codex&&byAgent.codex.sec)||0;
  const activeMs=(claudeSec+codexSec)*1000;
  const systemMs=Math.max(0, wall - activeMs - ownerWait);
  return { wall, ownerWait, claudeSec, codexSec, activeMs, systemMs };
}

function writeConsumptionReport(crPath){
  const text = readGates(crPath);   // metrics + verdicts live in the sidecar now
  // rev= is optional so reports still parse metrics written before this field existed.
  const metrics = [...text.matchAll(/<!--METRIC gate="([^"]*)" agent="([^"]*)"(?: model="([^"]*)")?(?: rev=(\d+))?(?: class="[^"]*")? seconds=(\d+) tokens=(\S+)[^>]*? at="([^"]*)"[^>]*-->/g)];
  if (!metrics.length) return;

  // --- per gate rows + totals, per agent-model rollup, AND per revision-iteration ---
  let totSec=0, totTok=0, tokUnknown=false;
  const byAM = {};     // "agent (model)" -> {sec, tok, calls, unk}
  const byAgent = {};  // bare agent (claude/codex/grok) -> subscription-level rollup
  const byRev = {};    // rev number -> {sec, tok, calls, unk, gates:[]}
  const gateRuns = {};              // gate -> run count (file order = chronological)
  let reworkSec=0, reworkTok=0;     // circulation cost: repeat runs + all Revise/Root cause
  const rows = metrics.map(m=>{
    const gate=m[1], agent=m[2], model=m[3]||"", rev=m[4]!=null?parseInt(m[4],10):null, sec=parseInt(m[5],10), tokRaw=m[6];
    totSec+=sec;
    let tokN=null; if(/^\d+$/.test(tokRaw)) { tokN=parseInt(tokRaw,10); totTok+=tokN; } else tokUnknown=true;
    gateRuns[gate]=(gateRuns[gate]||0)+1;
    if (/^(Revise|Root cause)$/i.test(gate) || gateRuns[gate]>1){ reworkSec+=sec; if(tokN!=null) reworkTok+=tokN; }
    const key = agent + (model?` (${model})`:"");
    byAM[key] = byAM[key] || {sec:0, tok:0, calls:0, unk:false};
    byAM[key].sec += sec; byAM[key].calls++;
    if (tokN!=null) byAM[key].tok += tokN; else byAM[key].unk = true;
    byAgent[agent] = byAgent[agent] || {sec:0, tok:0, calls:0, unk:false};
    byAgent[agent].sec += sec; byAgent[agent].calls++;
    if (tokN!=null) byAgent[agent].tok += tokN; else byAgent[agent].unk = true;
    if (rev!=null){
      byRev[rev] = byRev[rev] || {sec:0, tok:0, calls:0, unk:false, gates:[]};
      byRev[rev].sec += sec; byRev[rev].calls++; byRev[rev].gates.push(`${gate} (${key})`);
      if (tokN!=null) byRev[rev].tok += tokN; else byRev[rev].unk = true;
    }
    return `| ${rev!=null?`R${rev}`:"—"} | ${gate} | ${key} | ${sec}s | ${tokRaw} |`;
  });

  // --- revisions BY STEP: which gate FAILed (and thus caused a loop-back), how many times ---
  const failByGate = {};
  for (const m of text.matchAll(/### Gate: ([^(]+?) \((?:codex|grok|claude)\)[\s\S]{0,400}?\n\n(?:\**)(FAIL|REJECT|REOPEN)/gi)){
    const gt = m[1].trim(); failByGate[gt] = (failByGate[gt]||0)+1;
  }
  const needsHuman = [...text.matchAll(/NEEDS-HUMAN:/g)].length;
  const revStepRows = Object.entries(failByGate);

  // Integrity note: the pre-v95 token parser could read a PREVIOUS gate's tokens=NNN out of an
  // agent's echoed prompt, so an entry whose count exactly equals an adjacent entry's is suspect.
  // Surface it rather than quietly reporting a figure we know may be inflated.
  const suspect = [];
  for (let i = 1; i < metrics.length; i++) {
    const a = metrics[i - 1], b = metrics[i];
    if (a[6] === b[6] && /^[0-9]+$/.test(b[6]) && Number(b[6]) > 20000 && a[1] !== b[1])
      suspect.push(b[1] + ' (' + Number(b[6]).toLocaleString() + 't) equals the preceding ' + a[1] + ' entry');
  }
  const amRows = Object.entries(byAM).map(([k,v])=>
    `| ${k} | ${v.calls} | ${v.sec}s | ${v.tok.toLocaleString()}${v.unk?" +unk":""} |`).join("\n");
  const agentRows = Object.entries(byAgent).map(([k,v])=>
    `| ${k} | ${v.calls} | ${_fmtT(v.sec)} | ${v.tok.toLocaleString()}${v.unk?" +unk":""} |`).join("\n");

  // Per revision-iteration: Rev 0 = initial DRAFT review; Rev N = the cycle after the
  // Nth revise. Shows how much each reiteration cost in time + tokens.
  const revRows = Object.keys(byRev).map(Number).sort((a,b)=>a-b).map(r=>{
    const v = byRev[r];
    const label = r===0 ? "Rev 0 (initial)" : `Rev ${r}`;
    return `| ${label} | ${v.calls} | ${v.sec}s | ${v.tok.toLocaleString()}${v.unk?" +unk":""} | ${v.gates.join(", ")} |`;
  }).join("\n");

  const life = lifecycleFromLog(crPath);
  const activeMin = (totSec/60).toFixed(1);

  // === v107: real-work token separation, time attribution, solo baseline ===
  const _blobs = [...text.matchAll(/<!--METRIC ([^>]*?)-->/g)].map(x=>x[1]);
  const _f = (a,k)=>{ const m = a.match(new RegExp(k+'="([^"]*)"')) || a.match(new RegExp(k+'=([^\\s]+)')); return m?m[1]:null; };
  const _n = v => (v!=null && /^\d+$/.test(v)) ? +v : 0;
  let clWorkIn=0, clWorkOut=0, clCacheR=0, clCacheW=0, clTeq=0, clUnmeasured=0, cxTok=0, cxPasses=0;
  for(const a of _blobs){
    const ag=_f(a,"agent"), t=_f(a,"tokens");
    if(ag==="claude"){
      clWorkIn+=_n(_f(a,"tokens_in")); clWorkOut+=_n(_f(a,"tokens_out"));
      clCacheR+=_n(_f(a,"cache_read")); clCacheW+=_n(_f(a,"cache_write"));
      if(/^\d+$/.test(t||"")) clTeq+=+t; else clUnmeasured++;
    } else if(ag==="codex" && /^\d+$/.test(t||"")){ cxTok+=+t; cxPasses++; }
  }
  const clWork = clWorkIn + clWorkOut;
  const attr = timeAttribution(crPath, byAgent);
  const fmM = ms => ms>=3600000 ? `${(ms/3600000).toFixed(1)}h` : ms>=60000 ? `${(ms/60000).toFixed(1)}m` : `${Math.round(ms/1000)}s`;
  // solo baseline: one clean build pass (max single Building work), no Codex, no laps
  const _bw = _blobs.filter(a=>_f(a,"agent")==="claude" && /Building/.test(_f(a,"gate")||"")).map(a=>_n(_f(a,"tokens_in"))+_n(_f(a,"tokens_out"))).filter(x=>x>0);
  const soloWork = _bw.length ? Math.max(..._bw) : clWork;
  const _bs = metrics.filter(m=>m[2]==="claude" && /Building/.test(m[1])).map(m=>+m[5]);
  const soloSec = _bs.length ? Math.max(..._bs) : Math.round(totSec/2);
  const reviewFails = [...text.matchAll(/### Gate: [^\n]*\((?:codex|grok)\)[\s\S]{0,400}?\n\n\**?(FAIL|REJECT)/gi)].length;
  const laps = gateRuns["Building"]||0;
  const timeSection = attr ? `### Time (attributed)\n`+
    `- **Total wall-clock:** ${fmM(attr.wall)}\n`+
    `- **Active agent work:** ${fmM(attr.activeMs)} — Claude ${fmM(attr.claudeSec*1000)} · Codex ${fmM(attr.codexSec*1000)}\n`+
    `- **Waiting on owner** (human latency — NOT pipeline cost): ${fmM(attr.ownerWait)}\n`+
    `- **System / transitions:** ${fmM(attr.systemMs)}\n`+
    `_Owner-wait = time the CR sat at an escalation or the deploy handoff waiting for you; tagged to the human. A large value here is human latency, not agent spend._\n\n` : "";
  const tokenSection = `### Actual Claude tokens (own subscription — never summed with Codex)\n`+
    `- **Real work (input + output): ${clWork.toLocaleString()}** ← the true build cost\n`+
    `- Context re-read (cache-read, billed 0.1×): ${clCacheR.toLocaleString()} — session-length overhead, NOT work\n`+
    `- Cache-write: ${clCacheW.toLocaleString()} · weighted TEQ (incl. cache): ${clTeq.toLocaleString()}\n`+
    (clUnmeasured?`- ⚠ ${clUnmeasured} Claude gate(s) unmeasured (transcript race) — true work is at least the above\n`:``)+`\n`+
    `### Codex tokens (separate subscription)\n`+
    `- ${cxTok.toLocaleString()} across ${cxPasses} review pass(es) (~${cxPasses?Math.round(cxTok/cxPasses).toLocaleString():0}/pass) — total is driven by LAP COUNT, not per-review cost\n\n`;
  const soloSection = `### Solo-Claude baseline (estimate — one Claude, no pipeline)\n`+
    `| | Solo Claude (est.) | This pipeline (actual) |\n|---|---|---|\n`+
    `| Claude work tokens | ~${soloWork.toLocaleString()} (1 build pass) | ${clWork.toLocaleString()} |\n`+
    `| Codex tokens | 0 | ${cxTok.toLocaleString()} |\n`+
    `| Active time | ~${fmM(soloSec*1000)} | ${fmM(attr?attr.activeMs:totSec*1000)} |\n`+
    `| Build laps | 1 | ${laps} |\n`+
    `| Independent defects caught | 0 (self-review) | ${reviewFails} — issues solo would risk shipping |\n`+
    `_Solo is cheaper & faster but self-reviews; the pipeline's extra cost buys the ${reviewFails} independent catch(es). Use solo/FAST lane for low-risk changes, the pipeline for auth/data/money._\n\n`;

  const report = `\n\n## Consumption Report — ${new Date().toISOString()}\n\n`+
    (life ? `### Lifecycle (pipeline entry → close)\n`+
      `Entered pipeline: ${life.startISO} · **total wall-clock: ${life.total}** · active agent time: ${totSec}s (${activeMin} min)\n`+
      `_(The requirement→CR authoring happens in the Claude session before pipeline entry and is not metered here.)_\n\n`+
      `| Phase | Duration |\n|---|---|\n${life.rows}\n\n` : "")+
    timeSection + tokenSection + soloSection +
    `### Per-gate\n`+
    `| Rev | Gate | Agent (model) | Time | Tokens |\n|---|---|---|---|---|\n`+
    rows.join("\n")+
    `\n| | **TOTAL** | | **${totSec}s (${(totSec/60).toFixed(1)} min)** | **${totTok.toLocaleString()}${tokUnknown?" +unknown":""}** |\n`+
    `| | **↳ rework** (repeat gate runs + revise/root-cause — the Claude↔Codex circulation cost) | | **${reworkSec}s (${(reworkSec/60).toFixed(1)} min)** | **${reworkTok.toLocaleString()} (${totTok?Math.round(reworkTok/totTok*100):0}%)** |\n\n`+
    (suspect.length ? `> WARNING - token figures to treat with care (pre-v95 parser misattribution): ${suspect.join('; ')}.\n\n` : '')+
    (revRows ? `### Per revision-iteration (DRAFT review cycles + their reiterations)\n`+
      `| Iteration | Gates | Time | Tokens | Detail |\n|---|---|---|---|---|\n`+
      revRows+`\n\n` : "")+
    `### Per agent (subscription rollup)\n`+
    `| Agent | Calls | Time | Tokens |\n|---|---|---|---|\n`+
    agentRows+`\n\n`+
    `### Per agent-model\n`+
    `| Agent (model) | Calls | Time | Tokens |\n|---|---|---|---|\n`+
    amRows+`\n\n`+
    `### Revisions by step (where the CR looped back)\n`+
    (revStepRows.length ? revStepRows.map(([g,n])=>`- **${g}** — ${n} revision${n>1?"s":""}`).join("\n")
                        : "- none — clean first pass")+
    (needsHuman?`\n- Escalated to owner: **${needsHuman}**`:"")+`\n`;
  appendGates(crPath, report);
  // Console close summary: totals + PER-AGENT (map to your subscriptions) + revisions-by-step.
  log(`${C.green}${C.bold}✓ CLOSED${C.reset} ${C.dim}· ${_fmtT(totSec)} · ${totTok.toLocaleString()} tokens${C.reset}`);
  for (const [a,v] of Object.entries(byAgent))
    log(`   ${C.cyan}${a.padEnd(7)}${C.reset} ${v.calls} calls · ${_fmtT(v.sec)} · ${C.bold}${v.tok.toLocaleString()}${C.reset} tok${v.unk?" +unk":""}`);
  log(`   ${C.dim}revisions by step:${C.reset} ${revStepRows.length? revStepRows.map(([g,n])=>`${g} ×${n}`).join(", ") : "none (clean first pass)"}`);
}
// LOOP-BREAKER telemetry: lifetime FAIL positions of a gate across the WHOLE sidecar.
// Caps count cycles per scope, and authorize/revise legitimately reset scope — so a
// circling CR can burn laps forever without tripping any counter. Lifetime same-gate
// FAILs are the un-resettable signal.
function gateFailHistory(crPath, gateName){
  const gAll = readGates(crPath);
  // Row verdicts read the CURRENT review scope (after the last revision/retry/owner
  // marker) — a PREVIOUS revision's PASS must not render as this revision's ✓ (Security
  // showed green while the revised spec still owed its re-run). Metrics/fail counts stay
  // whole-file: history is additive, verdicts are scoped.
  const _scopeIdx = Math.max(gAll.lastIndexOf("## Revision"), gAll.lastIndexOf("### Build retry"),
    gAll.lastIndexOf("### Owner decision"), gAll.lastIndexOf("### Recovery"), gAll.lastIndexOf("### Status correction"));
  const g = _scopeIdx >= 0 ? gAll.slice(_scopeIdx) : gAll;
  const esc = gateName.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re = new RegExp("### Gate: "+esc+" \\([\\s\\S]{0,400}?\\n\\n(?:\\**)(FAIL|REJECT|REOPEN)","gi");
  const idx = []; let m; while((m=re.exec(g))) idx.push(m.index);
  return { count: idx.length,
           lastIdx: idx.length ? idx[idx.length-1] : -1,
           prevIdx: idx.length > 1 ? idx[idx.length-2] : -1,
           rcIdx: g.lastIndexOf("### Root cause") };
}
function gateDone(crPath, gateName){
  // Reads the SIDECAR (gate entries live there now, not in the frozen CR).
  // Scope resets at the latest of any of these markers, so a looped-back build OR a
  // human re-submit (owner decision / recovery / status correction after a REOPEN)
  // re-runs its gates instead of being skipped as "already logged". Without the
  // human-re-submit markers, a stale REOPEN sign-off would satisfy gateDone and the CR
  // would auto-advance to CLOSED without a fresh sign-off.
  const text = readGates(crPath);
  const idx = Math.max(
    text.lastIndexOf("## Revision"), text.lastIndexOf("### Build retry"),
    text.lastIndexOf("### Owner decision"), text.lastIndexOf("### Recovery"),
    text.lastIndexOf("### Status correction"));
  const scope = idx >= 0 ? text.slice(idx) : text;
  // Anchor on the exact entry header runGate writes ("### Gate: <name> ("). The old
  // pattern matched the gate name ANYWHERE in prose (case-insensitive), so e.g.
  // "buildability … APPROVE" inside a review could mark the "Build" gate done.
  // "Done" = the gate's actual VERDICT LINE (the token right after the header) is a PASSING
  // one. Delegating to lastGateVerdict fixes a false-match Codex found: the old regex matched
  // any GOOD keyword within 400 chars of the header, so `FAIL — does not PASS…` matched "PASS"
  // and wrongly marked the gate done. lastGateVerdict reads the leading verdict token only.
  void scope; // scope kept above only for the marker documentation; verdict comes from the line
  const v = lastGateVerdict(crPath, gateName);
  return v != null && GOOD_VERDICT.test(v);
}

// Live in-session status: an agent calls `begin` when it STARTS a gate, writing an invisible
// <!--RUNNING …--> marker. This returns the latest start-timestamp for the gate in the current
// scope (null if none), so the board can show "in review"/"working" instead of "awaiting you"
// while the agent is mid-task. The marker is an HTML comment → invisible to gateDone/verdict
// parsing; `record` (the verdict) is what actually advances the gate.
function runStartedAt(crPath, gateName){
  const text = readGates(crPath);
  const idx = Math.max(
    text.lastIndexOf("## Revision"), text.lastIndexOf("### Build retry"),
    text.lastIndexOf("### Owner decision"), text.lastIndexOf("### Recovery"),
    text.lastIndexOf("### Status correction"));
  const scope = idx >= 0 ? text.slice(idx) : text;
  const esc = gateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp('<!--RUNNING gate="' + esc + '"[^>]*?at="([^"]+)"', "g");
  let m, last = null; while ((m = re.exec(scope))) last = m[1];
  return last;
}

// ---- auth preflight -------------------------------------------------------
// Grok's device-login token is short-lived (~6h: auth.json create_time -> expires_at)
// and the non-interactive `grok -p` path does not reliably refresh it. Checking the
// expiry BEFORE spending a gate turns a mid-review crash into an upfront, actionable
// message. Fails OPEN: if the file is missing/unparseable/format-changed we return ok
// and let the normal invocation + auth handling deal with it.
// Durable fix (no expiry at all): export XAI_API_KEY in the shell that runs this.
function authPreflight(agent){
  if (agent !== "grok") return { ok:true };
  if (process.env.XAI_API_KEY) return { ok:true };          // API key never expires
  try {
    const p = require("path").join(require("os").homedir(), ".grok", "auth.json");
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    let exp = null;
    const scan = (o)=>{ for (const [k,v] of Object.entries(o||{})){
      if (v && typeof v === "object") scan(v);
      else if (/expires_at/i.test(k) && v) exp = v;
    }};
    scan(raw);
    if (!exp) return { ok:true };
    const ms = new Date(exp).getTime();
    if (!Number.isFinite(ms)) return { ok:true };
    if (ms - Date.now() < 5*60*1000){                        // expired or <5 min left
      return { ok:false, msg:`grok token expires ${new Date(ms).toISOString()} (<5 min or already lapsed)` };
    }
  } catch { /* fail open */ }
  return { ok:true };
}

// ---- token diet -----------------------------------------------------------
// v24 inlined the ENTIRE CR into every gate prompt. Gate outputs are appended to
// the CR, so each gate's prompt was bigger than the last (CR-0002 grew past 1,300
// lines and every gate re-read all of it). The trimmed view keeps: the authored
// body (up to the first gate-log/classification marker), the latest "## Revision"
// section (current spec deltas + its gate log), and drops METRIC comments and
// older history. Agents have file access — the full trail stays on disk.
// The CR is frozen and lean, so it goes in whole; this cap is only a guard rail.
function crView(text){
  const CAP = 16000;                    // guard ≈ 4k tokens; lean CRs never hit it
  if (text.length > CAP) return text.slice(0, CAP/2) + "\n\n[…truncated — read the CR file for full detail…]\n\n" + text.slice(-CAP/2);
  return text;
}

// One-line state header: replaces re-reading history.
function stateHeader(crText, crPath){
  const status = (crText.match(/\*\*Status:\*\*\s*([A-Z_]+)/i)||[])[1] || "?";
  const prev = lastGate.get(crPath);
  return `STATE: ${status} · build-cycle ${getCycle(crText)}/2 · revision ${getRevisions(crText)}/3` +
         (prev ? ` · last gate: ${prev.agent.toUpperCase()} ${prev.gate} (${prev.secs}s)` : "");
}

// Keep reviews cheap on both sides: reviewers get a terse-output contract, so their
// verdicts stay small AND the CR file (which future gates re-read) grows slowly.
const TERSE_RULE =
  "OUTPUT CONTRACT: be terse. Verdict line(s) first, then at most ~250 words of " +
  "bullet-point reasons. No restating the CR, no code quotes unless essential, no praise.";

async function runGate(crPath, crText, g, status){
  // Detect an existing per-CR Codex session BEFORE building the prompt: a resumed session
  // already holds the CR from round 1, so re-inlining it re-buys the same tokens each lap.
  let _codexSid = null, _sessionMarker = null;
  if (g.agent === "codex"){
    _sessionMarker = /security|sign-off/i.test(g.gate) ? "CODEX-SEC-SESSION" : "CODEX-SESSION";
    _codexSid = (readGates(crPath).match(new RegExp('<!--' + _sessionMarker + ' id="([0-9a-f-]{36})"-->', "i")) || [])[1] || null;
  }
  const crPart = _codexSid
    ? `The CR file (${crPath}) may have been REVISED since your last round in this session. ` +
      `Re-read it from disk and review the CURRENT text against your prior findings — points ` +
      `you already accepted stay accepted; judge only what changed or remains open.`
    : `The CR (at ${crPath}):\n\n${crView(crText)}`;
  const prompt = `${DECISION_POLICY}\n\n${g.role}\n\n${TERSE_RULE}\n\n` +
    `${stateHeader(crText, crPath)}\n` +
    `Context files (read ON DEMAND only — do not read them unless you need them): ` +
    `app architecture ${path.join(__dirname,"APP_MENTAL_MODEL.md")} · ` +
    `gate history ${gatesPath(crPath)} · rules WORKFLOW.md\n\n` + crPart;
  const model = g.agent === "claude" ? claudeModel(g.gate) : null;
  // PROMPT AUDIT (owner ask, 2026-07-27): every prompt the orch dispatches to an agent is
  // saved verbatim — see them with:  node orchestrator.cjs prompts <CR> [last]
  try {
    const _pdir = path.join("logs", "prompts", path.basename(crPath).replace(/\.md$/i, ""));
    fs.mkdirSync(_pdir, { recursive: true });
    const _pfile = path.join(_pdir, new Date().toISOString().replace(/[:.]/g, "-") + "-" + g.agent + "-" + g.gate.replace(/[^A-Za-z0-9]+/g, "_") + ".txt");
    fs.writeFileSync(_pfile, prompt);
    crLog(crPath, { type: "prompt", agent: g.agent, gate: g.gate, chars: prompt.length, file: _pfile });
  } catch { /* audit is best-effort */ }
  const t0 = Date.now();
  // ASYNC spawn (not spawnSync) so the event loop stays free to ANIMATE the board while
  // the agent works — a live braille spinner + ticking elapsed on the running step, so a
  // long gate feels alive instead of frozen. Still no shell (argv array) → backtick/$-safe.
  const { out, tokSource } = await new Promise(resolve=>{
    let [bin, argv] = AGENT_ARGV[g.agent](prompt, model);
    // PER-CR REVIEWER MEMORY (owner request, 2026-07-27): codex gates resume ONE session
    // per CR — it remembers its own prior rounds on this change (accepted points stay
    // accepted), while a new CR starts a fresh session (independence preserved).
    // (_codexSid was resolved above, before the prompt was built, so resumed rounds get
    // the slim re-review prompt instead of the full CR again.)
    if (g.agent === "codex"){
      g.__sessionMarker = _sessionMarker;
      argv = _codexSid ? ["exec", "resume", _codexSid, "--json", prompt]
                       : [...argv.slice(0, argv.length - 1), "--json", prompt];
    }
    let so="", se="", i=0, timedOut=false;
    const FR = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
    const child = spawn(bin, argv, { stdio:["ignore","pipe","pipe"] });
    child.stdout.on("data", d=> so+=d);
    child.stderr.on("data", d=> se+=d);
    // Live activity: the tail of what the agent is streaming, MINUS startup/noise lines
    // (claude's "Ignoring N permissions" warning, update notices, dashes). claude -p does
    // not stream mid-work, so for it this stays "working…" — the ticking timer is the real
    // alive signal; codex/grok do stream steps, so their tail shows real activity.
    const NOISE = /ignoring \d+ |permission|not signed|update available|skip-permission|deprecat|^[-─=\s]+$|node_modules|npm warn/i;
    const activity = () => { const t=(so+se).split("\n").map(l=>_strip(l).replace(/[*`>#]/g,"").trim()).filter(l=>l.length>2 && !NOISE.test(l)).pop(); return t ? t.slice(0,28) : "working…"; };
    const anim = LANE.some(s=>s.gate===g.gate)
      ? setInterval(()=>printLane(crPath, status, g.gate, { spin:FR[i++%FR.length], elapsed:Math.floor((Date.now()-t0)/1000), activity:activity() }), 250)
      : null;
    const to = setTimeout(()=>{ timedOut=true; try{child.kill("SIGKILL")}catch{} }, 30*60*1000);
    const fin = r => { if (anim) clearInterval(anim); clearTimeout(to); resolve(r); };
    child.on("error", e=> fin({ out:"__INFRA_ERROR__ "+((e&&e.message)||"spawn error"), tokSource:"" }));
    child.on("close", code=>{
      if (timedOut) return fin({ out:"__INFRA_ERROR__ timeout after 30m", tokSource:"" });
      if (code!==0) return fin({ out:"__INFRA_ERROR__ exit "+code+" "+se.trim().slice(-260), tokSource:"" });
      // codex --json emits JSONL events: reconstruct the agent's final text from message
      // events; fall back to raw stdout when not JSONL (grok, or plain output).
      let textOut = so;
      if (g.agent === "codex" && /^\s*\{/.test(so)){
        try {
          const msgs = so.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const parts = [];
          for (const m of msgs){
            const t = m?.msg?.message || m?.message?.content || m?.text || m?.content || (m?.item && m.item.text);
            if (typeof t === "string" && t.trim()) parts.push(t);
            else if (Array.isArray(t)) for (const c of t) if (typeof c?.text === "string") parts.push(c.text);
          }
          if (parts.length) textOut = parts.join("\n");
        } catch { /* keep raw */ }
      }
      fin({ out: textOut, tokSource: so+"\n"+se });
    });
  });
  const secs = ((Date.now()-t0)/1000).toFixed(0);
  if (g.agent === "codex" && !out.startsWith("__INFRA_ERROR__")){
    try {
      const sid = (tokSource.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i) || [])[1];
      const _mk = g.__sessionMarker || "CODEX-SESSION";
      if (sid && !readGates(crPath).match(new RegExp('<!--' + _mk + ' id="[0-9a-f-]{36}"-->', "i"))){
        appendGates(crPath, '\n\n<!--' + _mk + ' id="' + sid + '"-->');
      }
    } catch { /* memory is best-effort; fresh runs still work */ }
  }
  // ---- parse tokens (from stdout+stderr; "?" if not reported) ----
  let tokens = "?";
  const clean = String(tokSource)
    .replace(/<!--[\s\S]*?-->/g, " ")          // our METRIC/RUNNING ledger comments
    .replace(/^.*tokens=\d+.*$/gm, " ")         // any echoed "tokens=NNN" ledger text
    .replace(/^.*(?:CR revisions|build→test cycles).*$/gm, " ");
  const codexTok = clean.match(/tokens used\s*[\n:]?\s*([\d,]+)/i);
  const jsonTok  = clean.match(/"(?:total_)?tokens"\s*:\s*(\d+)/i);   // real JSON only
  // v104: the old fallback (\b(\d[\d,]{2,})\s*tokens?\b) matched an agent WRITING about
  // tokens in prose ("this saves about 4,000 tokens"). Require line start or an explicit
  // used/total prefix.
  const genTok   = clean.match(/(?:^|\b(?:used|total)\b[^\S\n]*:?[^\S\n]*)(\d[\d,]{2,})\s*tokens?\b/im);
  if (codexTok) tokens = codexTok[1].replace(/,/g,"");
  else if (jsonTok) tokens = jsonTok[1];
  else if (genTok) tokens = genTok[1].replace(/,/g,"");
  // v104: a RESUMED codex session reports CUMULATIVE session tokens, not this round's —
  // summing rounds counted earlier rounds triangularly (the report's `suspect` heuristic
  // was patching this symptom). Record the per-round DELTA and persist the running
  // cumulative on the session marker; a counter that went BACKWARDS means a fresh
  // counter (session restarted) and is taken as-is.
  if (g.agent === "codex" && /^\d+$/.test(tokens)){
    const _mk = g.__sessionMarker || "CODEX-SESSION";
    const cur = Number(tokens);
    if (_codexSid){
      const last = [...readGates(crPath).matchAll(new RegExp('<!--' + _mk + ' id="' + _codexSid + '"(?: cumulative="(\\d+)")?-->', "gi"))].pop();
      const prev = last && last[1] ? Number(last[1]) : 0;
      if (cur >= prev && prev > 0) tokens = String(cur - prev);
      appendGates(crPath, `\n\n<!--${_mk} id="${_codexSid}" cumulative="${cur}"-->`);
    } else {
      // fresh session this round: the sid was captured just above (marker without a
      // cumulative). Stamp the baseline now so ROUND 2 subtracts round 1 correctly.
      const justSid = (readGates(crPath).match(new RegExp('<!--' + _mk + ' id="([0-9a-f-]{36})"', "i")) || [])[1];
      if (justSid) appendGates(crPath, `\n\n<!--${_mk} id="${justSid}" cumulative="${cur}"-->`);
    }
  }
  const verdict = parseVerdict(out) || (out.trim().split("\n")[0]||"").slice(0,40);
  // NO per-gate console line, NO remark dump — the 7-step lane (in the caller) is the
  // whole display. Only a genuine escalation breaks through the board.
  if (/^NEEDS-HUMAN/i.test(verdict) || /^NEEDS-HUMAN:/im.test(out)){
    const qq = (out.match(/^NEEDS-HUMAN:\s*(.+)/im)||[])[1] || "(see CR gate log)";
    banner(`ESCALATION — owner decision needed`, C.red);
    console.log(`   ${C.bold}${qq}${C.reset}\n   ${C.dim}(paste into Claude to decide)${C.reset}`);
    crLog(crPath, { type:"escalation", question:qq });
  }
  if (!out.startsWith("__INFRA_ERROR__")) lastGate.set(crPath, { agent:g.agent, gate:g.gate, secs, tokens });
  crLog(crPath, { type: out.startsWith("__INFRA_ERROR__") ? "infra_error" : "gate",
    agent:g.agent, gate:g.gate, model: model||undefined, rev: getRevisions(crText), verdict, secs:Number(secs),
    tokens: tokens==="?" ? null : Number(tokens), chars: out.length,
    remarks: /^(REJECT|FAIL|REOPEN)$/.test(verdict) ? out.trim().split("\n").slice(1).filter(l=>l.trim()).slice(0,8).join(" | ").slice(0,600) : undefined });
  // ---- structured metrics line for the end-of-CR report ----
  // An infra/auth error is NOT a review verdict: never write it into the CR. Doing so
  // polluted the audit trail and (via gateDone) could permanently skip the real review.
  // Status is left untouched by the caller, so the gate simply re-runs once the CLI works.
  if (out.startsWith("__INFRA_ERROR__")){
    log(`${C.red}${g.agent} ${g.gate}: infra/auth error — nothing written to the CR; gate will re-run.${C.reset}`);
    return out;
  }
  // A run that produced NO verdict (agent died mid-stream — e.g. grok emitting only its
  // opening line) must not pollute the ledger: record nothing, back off, retry later.
  if (!parseVerdict(out)){
    log(`${C.yellow}${g.agent} ${g.gate}: run ended with NO verdict — nothing recorded; retrying in 5min.${C.reset}`);
    _noVerdictAt.set(path.basename(crPath) + "|" + g.gate, Date.now());
    return "__INFRA_ERROR__ no-verdict (agent output had no PASS/FAIL conclusion)";
  }
  // Someone recorded this gate (PASS **or FAIL**) while our auto-review ran → discard the
  // duplicate: a second identical FAIL costs a real cycle and can escalate the CR.
  if (lastGateVerdict(crPath, g.gate)){
    log(`${C.dim}${g.agent} ${g.gate}: recorded in-session while the auto-review ran — duplicate discarded.${C.reset}`);
    return out;
  }
  // Frozen-CR rule: verdicts go to the sidecar, never the CR.
  // rev = the CR's revision counter at this moment → lets the report break the DRAFT
  // review phase down per reiteration (Rev 0 = initial, Rev 1 = after first revise, …).
  const rev = getRevisions(crText);
  // Normalize: the body's FIRST line must be the bare verdict — CLI reviewers narrate
  // before concluding, the scoped parsers can't read prose-first entries, and an
  // "unfinished-looking" gate re-ran the ENTIRE review (2x tokens, duplicate entries).
  let body = out.trim();
  { const pv = parseVerdict(body);
    if (pv && !VERDICT_RE.test((body.split("\n")[0]||"").trim())) body = pv + "\n\n" + body; }
  appendGates(crPath, `\n\n<!--METRIC gate="${g.gate}" agent="${g.agent}"${model?` model="${model}"`:""} rev=${rev} class="${gateClass(g.gate)}" seconds=${secs} tokens=${tokens} at="${new Date().toISOString()}" orch="${ORCH_VERSION}"-->\n### Gate: ${g.gate} (${g.agent}) — rev ${rev} — ${new Date().toISOString()}\n\n${body}\n`);
  return out;
}

function setStatus(crPath, text, status){
  const from = (text.match(/\*\*Status:\*\*\s*([A-Z_]+)/i)||[])[1] || "?";
  fs.writeFileSync(crPath, text.replace(/(\*\*Status:\*\*).*/i, `$1 ${status}`));
  crLog(crPath, { type:"status", from, to:status });
  // No console line: the status is shown in the board's title, and printing here would
  // "commit" the board and spawn a second panel. ONE panel per request → the board is the
  // single display; transitions are conveyed by the board redrawing in place.
}

// Commit of the code UNDER TEST (app paths only): an orch/doc/CR commit must not
// invalidate build/harness evidence — it did (HEAD moved → redundant harness re-run).
function appCommit(){
  try { const h = execSync("git log -1 --format=%h -- server src", { encoding:"utf8" }).trim(); if (h) return h; } catch { /* */ }
  try { return execSync("git rev-parse --short HEAD", { encoding:"utf8" }).trim(); } catch { return ""; }
}
function runCmd(crPath, label, cmd, quiet, opts){
  if (!quiet) log(`${C.dim}running ${label}: ${cmd}${C.reset}`);
  let out, ok=true;
  const timeoutMs = (opts && opts.timeoutMs) || 30*60*1000;
  try { out = execSync(cmd, { encoding:"utf8", timeout:timeoutMs, killSignal:"SIGKILL" }); }
  catch(e){ ok=false; out=(e.stdout||"")+(e.message||"");
    // execSync's kill hits only the direct child — grandchildren (a harness-spawned app
    // server) survive, hold ports/pipes, and wedge the NEXT run too. Best-effort sweep.
    if (opts && opts.cleanup){ try { execSync(opts.cleanup, { timeout:10000 }); } catch { /* */ } }
  }
  // Stamp the exact commit the command ran against, so a harness/deploy result in the ledger is
  // verifiably tied to a specific committed source (audit-trail: no ambiguity about staleness).
  const _ac = appCommit();
  const commit = _ac ? ` @ ${_ac}` : "";
  appendGates(crPath, `\n\n### ${label} — ${new Date().toISOString()}${commit} — ${ok?"OK":"FAILED"}\n\n\`\`\`\n${String(out).slice(-3000)}\n\`\`\`\n`);
  if (!quiet) log(ok ? `${C.green}${label} OK${C.reset}` : `${C.red}${label} FAILED${C.reset}`);
  return ok;
}

let lastIdle = "";
async function tick(){
  if (!fs.existsSync(CR_DIR)) return;
  const files = fs.readdirSync(CR_DIR).filter(f=>/^CR-\d+.*\.md$/i.test(f)).sort();
  let didSomething = false;

  // DEPENDENCY-AWARE SINGLE LANE: one CR advances at a time, but (a) a CR parked on the
  // human (ESCALATED/DEPLOY_WAIT/FAST_DEPLOY) steps ASIDE so the next eligible CR starts,
  // and (b) a CR is skipped ("queued") while it depends on — or shares a declared file
  // with — another still-open CR (prevents concurrent edits to the same file). The active
  // CR is the lowest-numbered one that is workable AND unblocked.
  const infos = files.map(f=>{ const t=fs.readFileSync(path.join(CR_DIR,f),"utf8");
    const s=(t.match(/\*\*Status:\*\*\s*([A-Z_]+)/i)||[])[1]; return { f, s:s?s.toUpperCase():null, files:filesOf(t), deps:dependsOn(t) }; });
  const statusOf = id => { const i=infos.find(x=>x.f.replace(/\.md$/,"")===id); return i?i.s:"CLOSED"; };
  const blockReason = info => {
    for (const d of info.deps){ if (statusOf(d) !== "CLOSED") return `depends on ${d} (${statusOf(d)})`; }
    for (const j of infos){ if (j.f < info.f && j.s && j.s!=="CLOSED"){ const o=overlaps(info.files, j.files); if (o) return `shares ${o} with ${j.f.replace(/\.md$/,"")}`; } }
    return null;
  };
  const active = (infos.find(i => i.s && i.s!=="CLOSED" && !PARKED(i.s) && !blockReason(i)) || {}).f;

  for (const f of files){
    const crPath = path.join(CR_DIR, f);
    let text = fs.readFileSync(crPath, "utf8");
    const m = text.match(/\*\*Status:\*\*\s*([A-Z_]+)/i);
    if (!m) continue;
    const status = m[1].toUpperCase();

    // Clear the WAITING flag once the CR has moved off a human-owned state.
    if (!PARKED(status)) awaitingAt.delete(f);

    if (status==="CLOSED") continue;

    // Human-owned states surface their prompt EVERY tick regardless of the lane, so a CR
    // waiting on you never goes silent — but they don't hold the lane (they stepped aside).
    if (["ESCALATED","FAST_DEPLOY","DEPLOY_WAIT"].includes(status)){
      const crId = f.replace(/\.md$/,"");
      // The NEXT one-liner lives on the board and re-renders EVERY tick via renderIfChanged —
      // so when any log line (e.g. "CR-0009 queued") erases the board, the next tick redraws
      // it. (Previously the board printed once and a later log erased it forever.)
      const nprompt = (status==="FAST_DEPLOY" || status==="DEPLOY_WAIT")
        ? nextLine(C.yellow, "claude", `Here is the deploy output for ${crId}: <paste>`, "after the Ubuntu commands above")
        : nextLine(C.red, "claude", `For ${crId}, my decision is: <answer>`, `or: node orchestrator.cjs authorize ${crId} "<decision>"`);
      if (!awaitingAt.get(f)){
        awaitingAt.set(f, true);
        // One-shot preamble (scroll history): the banner erases any live board first.
        if (status==="FAST_DEPLOY" || status==="DEPLOY_WAIT"){
          // Print the EXACT Ubuntu commands from the CR's "### Deploy commands" block, so
          // you copy-paste straight from here — no hunting in the CR file.
          const cmds = deployCommands(text);
          banner(`[${f}] WAITING at ${status} — run these on Ubuntu, then paste the output back:`, C.yellow);
          if (cmds){ console.log(`\n${C.cyan}${cmds}${C.reset}\n`); }
          else { console.log(`\n${C.dim}(no '### Deploy commands' block found in the CR — check crs/${f})${C.reset}\n`); }
          console.log(`${C.dim}Claude records the output and sets ${status==="DEPLOY_WAIT"?"SIGNOFF":"FAST_CLOSE"} (success) or ESCALATED (failed).${C.reset}`);
        } else {
          // ESCALATED: surface Claude's distilled policy question from the gate log. Cap
          // escalations (test/revision limit) record no NEEDS-HUMAN line — say so usefully.
          const nh = readGates(crPath).match(/NEEDS-HUMAN:\s*(.+)/i) || text.match(/NEEDS-HUMAN:\s*(.+)/i);
          const qn = nh ? nh[1].trim()
                        : `a WORKFLOW cap was hit (test cycles or CR revisions) — latest FAIL findings: crs/.gates/${crId}.md`;
          banner(`[${f}] WAITING at ESCALATED — owner decision needed:`, C.red);
          console.log(`\n${C.bold}${qn}${C.reset}\n`);
          console.log(`${C.dim}Resume with: ${C.reset}${C.bold}node orchestrator.cjs authorize ${crId} "<decision>"${C.reset}${C.dim} — resets the scope + cycle counter and re-arms BUILD (a bare \`set\` cannot).${C.reset}`);
        }
      }
      renderIfChanged(crPath, status, null, { prompt: nprompt });
      didSomething = true;
      continue;
    }

    // Lane gate: only the active CR advances. A queued CR (blocked by a dependency or a
    // shared file with another open CR) shows a one-time "queued" note, then waits.
    if (f !== active){
      const info = infos.find(x=>x.f===f);
      const why = info && blockReason(info);
      if (why && awaitingAt.get("q:"+f) !== why){
        awaitingAt.set("q:"+f, why);
        log(`${C.dim}${f.replace(/\.md$/,"")} queued — ${why}${C.reset}`);
      }
      continue;
    }
    awaitingAt.delete("q:"+f);

    const stage = PIPELINE.find(s=>s.status===status);
    if (!stage) continue;

    // GLOBAL SPEND WALL (the outermost ring — catches runaway modes NOT invented yet):
    // no CR may consume more than CR_WINDOW tokens beyond the last owner decision without
    // STOPPING and asking the owner in plain language. Deterministic ledger arithmetic —
    // immune to agent persuasion, survives every reset; each owner consent buys exactly
    // one more window, so unbounded spend without a human touch is impossible.
    {
      const CR_WINDOW = 400000;   // budget of REAL WORK tokens (constant unchanged; v107)
      const gW = readGates(crPath);
      const od = gW.lastIndexOf("### Owner decision");
      const win = od >= 0 ? gW.slice(od) : gW;
      // v107 FIX: measure REAL WORK (input+output), NOT the TEQ `tokens=` figure — which
      // includes cache-read (the whole session context re-fed on every tool call) and so
      // inflated the wall in long sessions, tripping a 12h false park on CR-0021. For a
      // measured Claude gate, work = tokens_in + tokens_out (cache-read EXCLUDED). Codex
      // self-reports work tokens directly. Unmeasured gates contribute 0.
      let tok = 0;
      for (const m of win.matchAll(/<!--METRIC ([^>]*?)-->/g)) {
        const a = m[1];
        const inM = a.match(/tokens_in=(\d+)/), outM = a.match(/tokens_out=(\d+)/);
        if (inM || outM) tok += (inM?+inM[1]:0) + (outM?+outM[1]:0);
        else { const tM = a.match(/ tokens=(\d+)/); if (tM) tok += +tM[1]; }
      }
      if (tok > CR_WINDOW){
        banner(`[${f}] real-work spend ${Math.round(tok/1000)}k tokens (input+output; cache-read excluded) since last owner decision exceeds the ${Math.round(CR_WINDOW/1000)}k window → owner decides`, C.red);
        appendGates(crPath, `\n\nNEEDS-HUMAN: This change has consumed ${Math.round(tok/1000)}k WORK tokens (real input+output, not session context re-reads) since your last decision. Continue (one more budget window), re-file smaller, or park it?\n`);
        setStatus(crPath, text, "ESCALATED");
        didSomething = true;
        continue;
      }
    }

    if (status==="CLOSED") continue;

    // FAST/TEAM classification happens once, when a fresh CR is first seen at DRAFT.
    if (status === "DRAFT" && !readGates(crPath).includes("### Classification")){
      const cls = classifyCR(text);
      appendGates(crPath, `\n\n### Classification — ${new Date().toISOString()}\n\ntier: ${cls.tier}\nreason: ${cls.reason}\n`);
      crLog(crPath, { type:"classify", tier:cls.tier, reason:cls.reason });
      if (cls.tier === "FAST"){
        banner(`[${f}] classified FAST — ${cls.reason}. Fast lane: Claude builds, tests, deploys, closes.`, C.green);
        setStatus(crPath, fs.readFileSync(crPath,"utf8"), "FAST_BUILD");
        didSomething = true;
        continue;
      } else {
        // TEAM: no banner — the board's Classification row shows "done · TEAM". (FAST keeps
        // its banner since the FAST lane has no 7-step board.)
        text = fs.readFileSync(crPath,"utf8");
      }
    }

    // LEAN LANE (owner Decision A, 2026-07-27): build-first. Pre-build (prose) review runs
    // ONLY for dangerous risk classes — Material/Critical (permissions, tenancy, money,
    // irreversible). Everything else goes straight to BUILD; security reviews the REAL
    // CODE at Test time; reviewer notes ride along instead of blocking.
    if (status === "DRAFT" && readGates(crPath).includes("### Classification")){
      const dangerous = /Risk class \(proposed[^)]*\):\*\*\s*(Material|Critical)/i.test(text);
      if (!dangerous){
        banner(`[${f}] lean lane: risk Low/Moderate → building directly (security reviews the code at Test)`, C.green);
        setStatus(crPath, text, "BUILD");
        didSomething = true;
        continue;
      }
    }

    didSomething = true;   // board is rendered by the gate paths below (on state change only)

    if (stage.deploy){
      if (!readGates(crPath).includes(`### Deploy ${stage.deploy}`) && DEPLOY_CMDS[stage.deploy]){
        if (!runCmd(crPath, `Deploy ${stage.deploy}`, DEPLOY_CMDS[stage.deploy])){
          setStatus(crPath, fs.readFileSync(crPath,"utf8"), "ESCALATED"); continue;
        }
        text = fs.readFileSync(crPath,"utf8");
      }
    }

    let rejected=false, failVerb="", failGate="", infraFail=false;

    // MACHINE VALIDATION (WORKFLOW safety rule 2: machine before AI). The Test agent's
    // sandbox can't reach the DB, so the orch runs the CR's deterministic harness on the
    // HOST first. Convention: server/scripts/verify-<crid>.mjs (CR-0003 → verify-cr0003.mjs).
    // A harness FAIL is a real code failure → build retry. On PASS, the Test agent reviews
    // its output (in the gates file) + the diff, and does NOT try to run it.
    if (status==="TESTING"){
      const crid = f.replace(/\.md$/i,"").toLowerCase().replace(/-/g,"");
      const harnessRel = `scripts/verify-${crid}.mjs`;
      if (fs.existsSync(path.join(process.cwd(), HARNESS_DIR, harnessRel))){
        const gtext = readGates(crPath);
        // Use the SAME scope-reset markers as gateDone — including Owner decision (authorize),
        // Recovery and Status correction. Otherwise an `authorize` re-arm leaves a stale
        // "Machine validation OK" in scope and the harness never re-runs on the new commit.
        const resetIdx = Math.max(
          gtext.lastIndexOf("## Revision"), gtext.lastIndexOf("### Build retry"),
          gtext.lastIndexOf("### Owner decision"), gtext.lastIndexOf("### Recovery"),
          gtext.lastIndexOf("### Status correction"));
        const scope = resetIdx>=0 ? gtext.slice(resetIdx) : gtext;
        // Harness evidence is valid ONLY for the exact commit under test: stale "— OK"
        // entries from an older commit caused two full procedural FAIL laps on CR-0009.
        // Entries are stamped "@ <short-sha>" (runCmd); demand the stamp match HEAD, so
        // any new commit automatically invalidates old evidence and the harness re-runs.
        const head = appCommit();
        const okRe = head
          ? new RegExp("### Machine validation \\(harness\\) — [^\\n]*@ " + head.replace(/[.*+?^${}()|[\]\\]/g,"\\$&") + " — OK")
          : /### Machine validation \(harness\) —[\s\S]*?— OK/;
        const alreadyPassed = okRe.test(scope);
        if (!alreadyPassed){
          // Honest label: this is the ORCH-RUN harness, not Codex — "Test running…" here
          // misled the operator into checking an idle Codex. Blocks ≤5min (was 30), then
          // sweeps harness orphans (spawned app server) so the next run isn't wedged too.
          printLane(crPath, status, "Test", { runLabel: "harness (auto)…", runWho: "orch·harness",
            prompt: `${C.yellow}${C.bold}▶ ORCH is running the machine harness…${C.reset}${C.dim}  · auto, ≤${HARNESS_TIMEOUT_MIN}min — Codex reviews only after it passes${C.reset}` });
          const ok = runCmd(crPath, "Machine validation (harness)", `cd ${HARNESS_DIR} && node ${harnessRel}`, true /*quiet: keep one panel*/,
            { timeoutMs: HARNESS_TIMEOUT_MIN*60*1000, cleanup: `pkill -9 -f "${harnessRel}" ; lsof -ti tcp:${HARNESS_PORT} | xargs kill -9` });
          if (!ok){ rejected=true; failVerb="FAIL"; failGate="Machine validation (harness)"; }
          text = fs.readFileSync(crPath,"utf8");
          printLane(crPath, status);            // board reflects harness pass/fail
        }
      }
    }

    let awaitInSession = null;
    if (!rejected) for (const g of stage.gates){
      text = fs.readFileSync(crPath,"utf8");
      if (gateDone(crPath, g.gate)){ continue; }   // PASS already recorded → done
      // A recorded FAIL routes to revise BEFORE anything else. This check used to live only
      // on the in-session branch, so in codex.auto mode a failed gate re-spawned a full
      // fresh review EVERY TICK (each result then discarded as a duplicate) — pure token
      // burn in the exact place the pipeline promises to prevent it.
      { const v0 = lastGateVerdict(crPath, g.gate);
        if (v0 && BAD_VERDICT.test(v0)){ rejected=true; failVerb=v0; failGate=g.gate; break; } }
      // IN-SESSION gates (Claude build/revise/deploy, Codex review/test): the orch does NOT
      // spawn them — YOU run them in your Claude/Codex session and record the verdict. The
      // orch reads the recorded result and advances (or routes a FAIL to revise).
      if (g.inSession && !(g.agent === "codex" && CODEX_AUTO)){
        const v = lastGateVerdict(crPath, g.gate);
        if (v && GOOD_VERDICT.test(v)) continue;                       // recorded PASS/COMPLETED/READY → advance
        if (v && BAD_VERDICT.test(v)){ rejected=true; failVerb=v; failGate=g.gate; break; }  // recorded FAIL → revise
        awaitInSession = g; break;                                     // no verdict yet → pause for you
      }
      // AUTO gates (codex.auto): the orch runs Codex itself and records the verdict.
      // Don't RACE an in-session actor: if someone began this gate and hasn't recorded,
      // wait for their record instead of spawning a duplicate review (stale after 30min).
      {
        const startedAt = runStartedAt(crPath, g.gate);
        if (startedAt && !lastGateVerdict(crPath, g.gate) && (Date.now() - new Date(startedAt).getTime()) < 30*60*1000){
          renderIfChanged(crPath, status, g.gate, { runLabel: "in-session", prompt: busyLine(C.yellow, g.agent, g.gate, "begun in-session — awaiting its record") });
          didSomething = true; break;
        }
      }
      // Back off after a verdict-less run (agent died mid-stream): retry in 5min, not every poll.
      {
        const bk = _noVerdictAt.get(path.basename(crPath) + "|" + g.gate);
        if (bk && Date.now() - bk < 5*60*1000){ didSomething = true; break; }
      }
      const pf = authPreflight(g.agent);
      if (!pf.ok){ banner(`[${f}] grok session expired — run:  grok login  (CR resumes automatically)`, C.red); infraFail = true; break; }
      printLane(crPath, status, g.gate);
      let out = await runGate(crPath, text, g, status);
      printLane(crPath, status);
      let tries = 0;
      while (out.includes("__INFRA_ERROR__") && tries < 3){
        tries++; log(`${C.yellow}${g.agent} invocation failed (transient) — retry ${tries}/3${C.reset}`);
        require("child_process").execSync(`sleep ${tries*5}`);
        out = await runGate(crPath, fs.readFileSync(crPath,"utf8"), g, status);
      }
      if (out.includes("__INFRA_ERROR__")){ banner(`[${f}] ${g.agent} unavailable — check its CLI/login/network; retries next poll.`, C.red); infraFail = true; break; }
      const v = parseVerdict(out);
      if (v && BAD_VERDICT.test(v)){ rejected=true; failVerb=v; failGate=g.gate; break; }
    }
    if (awaitInSession){
      // Pause: ONE line at the bottom of the panel (inside the block → no stacking), rendered
      // only on state change. Two states: not-started → "tell <agent>: <trigger>"; after `begin`
      // → "<AGENT> working…". The prompt lives IN the block so re-renders overwrite it in place.
      const g = awaitInSession;
      const startedAt = runStartedAt(crPath, g.gate);
      let opts;
      if (startedAt){
        const _el = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime())/1000));
        opts = { runLabel: (g.agent==="codex" ? "in review " : "working ") + _fmtT(_el),
                 prompt: busyLine(C.yellow, g.agent, g.gate, "awaiting its recorded verdict") };
      } else if (g.agent === "claude") {
        // ALWAYS AUTO (owner rule 2026-07-28): Claude gates are picked up by the session
        // monitor — the board must not read as a demand on the human. Label it truthfully.
        opts = { runLabel: "queued (auto)",
                 prompt: _fitLine(`${C.dim}▶ CLAUDE picks this up automatically — nothing needed from you${C.reset}`) };
      } else {
        const trigger = g.agent==="codex" ? "review" : (/deploy/i.test(g.gate) ? "deploy" : "build");
        opts = { awaiting:true,
                 prompt: nextLine(C.yellow, g.agent, trigger, g.gate) };
      }
      renderIfChanged(crPath, status, g.gate, opts);
      didSomething = true; continue;
    }
    if (infraFail){ didSomething=true; continue; }  // agent CLI down; retries next poll

    text = fs.readFileSync(crPath,"utf8");
    if (rejected){
      // A test FAIL is a code defect: loop back to build (bump cycle), up to the cap.
      if (status==="TESTING" && failVerb==="FAIL"){
        // LOOP-BREAKER: at 3+ lifetime Test FAILs the quick lap is refused. Claude must
        // first RECORD a root-cause analysis (defect class + class-complete fix plan) via
        // `rootcause` — then exactly one class-complete retry unlocks. If Test fails AGAIN
        // after that, the class analysis didn't hold → decompose the CR; no more re-arming.
        const LOOP_BREAK = 3;
        const h = gateFailHistory(crPath, "Test");
        if (h.count >= LOOP_BREAK){
          if (h.rcIdx > h.lastIdx){
            // root cause recorded for THIS fail → fall through to the normal retry below
          } else if (h.rcIdx > h.prevIdx){
            banner(`[${f}] Test failed AGAIN after a root-cause fix (${h.count} lifetime FAILs) → owner: decompose this CR`, C.red);
            appendGates(crPath, `\n\nNEEDS-HUMAN: Test failed ${h.count}x lifetime, including after a recorded root-cause fix — decompose ${f.replace(/\.md$/,"")} into smaller CRs instead of re-arming it.\n`);
            setStatus(crPath, text, "ESCALATED");
            continue;
          } else {
            const prompt = nextLine(C.red, "claude", "rootcause", `Test FAILed ${h.count}x lifetime — class analysis required before any retry`);
            renderIfChanged(crPath, status, "Test", { prompt });
            didSomething = true; continue;
          }
        }
        const cap = 2;
        const c = getCycle(text);
        if (c + 1 < cap){
          const nc = bumpCycle(crPath);
          banner(`[${f}] test failed → back to Building (in-session) — cycle ${nc}/${cap}`, C.yellow);
          // Scope-reset marker (sidecar) so the in-session Building gate re-runs on the retry.
          appendGates(crPath, `\n\n### Build retry (cycle ${nc}) — ${new Date().toISOString()}\n`);
          setStatus(crPath, fs.readFileSync(crPath,"utf8"), "BUILD"); // back to build only (reviews stand)
        } else {
          banner(`[${f}] test failed and loop cap (${cap}) reached → human`, C.red);
          setStatus(crPath, text, "ESCALATED");
        }
        continue;
      }
      // DRAFT-SPEND BREAKER (lifetime, survives every reset): reviewing a PLAN must
      // converge. When Technical Clearance + Revise spend exceeds the cap, no more
      // review laps — the owner decides build-with-notes / re-file / abandon.
      // (CR-0012: 1.15M tokens of DRAFT churn prompted this.)
      {
        const DRAFT_CAP = 150000;
        const gAllB = readGates(crPath);
        let draftTok = 0;
        for (const m of gAllB.matchAll(/<!--METRIC gate="(Technical Clearance|Revise)"[^>]*? tokens=(\d+)/g)) draftTok += +m[2];
        if (draftTok > DRAFT_CAP){
          banner(`[${f}] review spend ${Math.round(draftTok/1000)}k tokens exceeds the ${Math.round(DRAFT_CAP/1000)}k DRAFT budget → owner decides (build with reviewer notes / re-file / abandon)`, C.red);
          appendGates(crPath, `\n\nNEEDS-HUMAN: Review of this plan has cost ${Math.round(draftTok/1000)}k tokens across many rounds. Options: BUILD NOW treating remaining review remarks as builder notes (recommended — the build's own tests judge real code), re-file smaller, or abandon.\n`);
          setStatus(crPath, text, "ESCALATED");
          continue;
        }
      }
      // Any other REJECT/REOPEN → revise IN-SESSION (Claude, this session). The orch pauses
      // and prompts; you fix the CR + run `revise`, which resets the scope so review re-runs.
      const revCap = 3;
      const revs = getRevisions(text);
      // LEAN LANE: pre-build review gets ONE revision; after that, remaining findings
      // become builder notes and the CR builds regardless — Test judges real code.
      if (status === "DRAFT" && revs >= 1){
        banner(`[${f}] lean cap: pre-build review done (1 round + 1 revision) → building with reviewer notes attached`, C.yellow);
        appendGates(crPath, `\n\n### Owner decision — ${new Date().toISOString()}\n\nLEAN LANE (structural, owner Decision A 2026-07-27): pre-build cap reached — remaining review findings ride as builder notes; the build and Test gate judge the real code.\n`);
        setStatus(crPath, fs.readFileSync(crPath,"utf8"), "BUILD");
        continue;
      }
      if (revs >= revCap){
        banner(`[${f}] revision cap ${revs}/${revCap} exhausted → owner decides (authorize more, re-file, or abandon)`, C.red);
        setStatus(crPath, text, "ESCALATED");
        continue;
      }
      // FAIL pause: ONE line under the SAME panel (no banner → no stacking). Two distinct
      // states: not-started → "tell CLAUDE: revise"; after `begin CR "Revise" claude` →
      // "▶ CLAUDE is revising…" and the title shows [<STATUS> · REVISING].
      const crId = f.replace(/\.md$/,"");
      const revNote = `${failGate||"gate"} ${failVerb} · rev ${revs}/${revCap}`;
      const prompt = runStartedAt(crPath, "Revise")
        ? busyLine(C.mag, "claude", "Revise", revNote)
        : nextLine(C.mag, "claude", "revise", revNote);
      renderIfChanged(crPath, status, "Revise", { prompt });
      didSomething = true; continue;
    }
    // Re-validate before advancing: a long in-tick await (a grok/codex run) can straddle
    // a revise/scope-reset — advancing on pre-await state once promoted a CR to BUILD
    // whose revised spec had NO Technical Clearance. Every gate must be done in the
    // CURRENT scope at this instant, or the CR stays put and re-evaluates next tick.
    const _allDone = (stage.gates || []).every(g2 => gateDone(crPath, g2.gate));
    const nx = _allDone ? stage.next(text) : null;
    if (nx){ setStatus(crPath, text, nx); if (stage.onAdvance) stage.onAdvance(crPath);
      if (nx==="CLOSED"){ writeConsumptionReport(crPath);
        // Learning loop (owner rule, 2026-07-26): every closed CR owes a pipeline
        // retrospective — the orch engineer analyzes the ledger, improves the orch, pushes.
        appendGates(crPath, `\n\n<!--RETRO-PENDING at="${new Date().toISOString()}"-->\n`);
        log(`${C.mag}${C.bold}▶ NEXT — tell CLAUDE:  retro${C.reset}${C.dim}  · analyze the closed CR, improve the pipeline, push to git${C.reset}`);
      } }
  }

  if (!didSomething){
    const idleMsg = files.length ? "watching — all CRs idle/waiting" : "watching crs/ — no CRs yet";
    if (idleMsg !== lastIdle){ log(`${C.dim}${idleMsg}${C.reset}`); lastIdle = idleMsg; }
  } else { lastIdle = ""; }
}

function checkAuth(){
  banner("Ready — Claude builds and closes (in-session); Codex reviews, tests and attacks the code.", C.green);
}
// ─── SELF-UPDATE: follow the kit repo and upgrade the engine in place ────────
// OPT-IN via orch.config.json {"selfUpdate":{"enabled":true}} — deliberately off by
// default, because the repo where the engine is DEVELOPED must never be overwritten
// by its own published copy (that would silently discard work in progress).
//
// Three rules make an automatic engine swap safe rather than reckless:
//   1. NEVER mid-gate. A gate that was begun without a recorded verdict means an agent
//      is working under the current rules; changing them underneath it would make the
//      verdict answer a question nobody asked. The update waits for a quiet board.
//   2. NEVER on faith. A candidate must parse AND survive a real one-shot run in this
//      project before it is kept; if it does not, the previous engine is restored and
//      that candidate is not retried until the kit changes again.
//   3. NEVER destructive to the kit. Only a fast-forward pull; a kit with local commits
//      or uncommitted work is left completely alone and reported.
const SU = Object.assign(
  { enabled:false, kitDir:"~/orch-kit", remote:"origin", branch:"main", checkEveryMin:60, channel:"release" },
  ORCH_CFG.selfUpdate || {});
// CHANNEL — how far ahead of "proven" a project is willing to run:
//   "release" (default): only versions the maintainer has TAGGED release-* in the kit.
//       A tag is a deliberate statement that the version was exercised on real work; an
//       ordinary push (including a half-finished idea) reaches nobody.
//   "main": every commit on the tracked branch — for the maintainer's own canary project.
// A project on "release" with no tags in the kit updates to NOTHING, and says so once:
// silence would be worse than staleness, so it is reported rather than assumed fine.
const suKitDir = () => String(SU.kitDir||"").replace(/^~(?=$|[\\/])/, require("os").homedir());
let suNextCheck = 0;                 // epoch ms of the next allowed check
const suSaid = new Set();            // one-time notices (don't nag every poll)
const suRejected = new Set();        // candidates that failed verification
let suPending = null;                // {version, why} shown on the board while waiting
const suOnce = (key, msg, colour) => { if (suSaid.has(key)) return; suSaid.add(key); log(colour + msg + C.reset); };

// A gate begun with no verdict recorded AFTER it = an agent is mid-work.
function suGateInFlight(){
  let files = [];
  try { files = fs.readdirSync(CR_DIR).filter(x=>/^CR-\d+\.md$/.test(x)); } catch { return null; }
  for (const file of files){
    const g = readGates(path.join(CR_DIR, file));
    const marks = [...g.matchAll(/<!--RUNNING gate="([^"]+)"/g)];
    if (!marks.length) continue;
    const last = marks[marks.length-1];
    // a verdict entry appearing after the marker means that run finished
    if (g.indexOf("### Gate:", last.index) < 0) return file.replace(/\.md$/,"") + " · " + last[1];
  }
  return null;
}

function suGit(kit, args, timeout){
  return spawnSync("git", ["-C", kit, ...args], { encoding:"utf8", timeout: timeout||60000 });
}

// Returns a short human line describing what happened (or null if nothing did).
function suCheck(opts){
  const force = !!(opts && opts.force), dry = !!(opts && opts.dry);
  if (!SU.enabled && !force) return null;
  const kit = suKitDir();
  if (!fs.existsSync(path.join(kit, ".git"))){
    suOnce("nokit", "self-update: no kit repo at " + kit + " — set selfUpdate.kitDir (or clone it) to receive engine updates", C.yellow);
    return null;
  }
  if (suGit(kit, ["status","--porcelain"]).stdout.trim()){
    suOnce("dirtykit", "self-update: the kit at " + kit + " has uncommitted changes — leaving it untouched", C.yellow);
    return null;
  }
  const fe = suGit(kit, ["fetch","--quiet",SU.remote,SU.branch]);
  if (fe.status !== 0){
    suOnce("nofetch", "self-update: cannot reach the kit remote (offline or no credentials) — retrying later", C.dim);
    return null;
  }
  suSaid.delete("nofetch");
  const behind = (suGit(kit, ["rev-list","--count","HEAD..FETCH_HEAD"]).stdout||"").trim();
  if (behind && behind !== "0"){
    if (suGit(kit, ["merge","--ff-only","FETCH_HEAD"]).status !== 0){
      suOnce("diverged", "self-update: the kit has diverged from its remote — fix it by hand; nothing was changed", C.yellow);
      return null;
    }
    log(C.green + "self-update: pulled " + behind + " new kit commit(s)" + C.reset);
  }

  // Which commit are we allowed to run? On the release channel, the newest release-* tag —
  // NOT the branch head. Candidate files are read out of that exact ref with `git show`,
  // so the kit's working tree is never checked out or otherwise disturbed.
  let ref = "FETCH_HEAD", refLabel = SU.branch;
  if (SU.channel === "release"){
    suGit(kit, ["fetch","--tags","--quiet",SU.remote]);
    const tags = (suGit(kit, ["tag","-l","release-*","--sort=-v:refname"]).stdout||"").trim().split("\n").filter(Boolean);
    if (!tags.length){
      suOnce("notags", "self-update: no release-* tag in the kit yet — staying on " + ORCH_VERSION + " (set selfUpdate.channel to \"main\" to follow every commit)", C.yellow);
      return null;
    }
    ref = tags[0]; refLabel = tags[0];
  }
  const showFile = (name) => {
    const r = suGit(kit, ["show", ref + ":" + name]);
    return r.status === 0 ? Buffer.from(r.stdout, "utf8") : null;
  };

  // What actually differs? Compare bytes, not versions: a version string can be
  // forgotten, and an unchanged file must never trigger a restart.
  const files = ["orchestrator.cjs","classify.cjs"]
    .map((n)=>({ n, bytes:showFile(n), dst:path.join(process.cwd(),n) }))
    .filter((x)=>x.bytes)
    .filter((x)=>!fs.existsSync(x.dst) || Buffer.compare(x.bytes, fs.readFileSync(x.dst)) !== 0);
  if (!files.length){ suPending = null; return force ? ("already up to date (engine identical to kit " + refLabel + ")") : null; }

  const engineBytes = files.find((x)=>x.n === "orchestrator.cjs");
  const kitVer = engineBytes
    ? ((engineBytes.bytes.toString("utf8").match(/ORCH_VERSION = "([^"]+)"/)||[])[1] || "?")
    : ORCH_VERSION;
  const kitSha = (suGit(kit, ["rev-parse","--short",ref]).stdout||"").trim();
  const tag = kitVer + "@" + kitSha;
  if (suRejected.has(tag)) return null;   // already proven broken — wait for a newer kit
  if (dry) return "update available: " + tag + " (" + files.map(x=>x.n).join(", ") + ")";

  // Rule 1: never mid-gate.
  const busy = suGateInFlight();
  if (busy){
    suPending = { version: tag, why: busy };
    suOnce("busy:"+tag, "self-update: " + tag + " ready — holding until the board is quiet (" + busy + " is mid-gate)", C.cyan);
    return null;
  }

  // Rule 2: never on faith. Stage → parse-check → back up → install → prove by running.
  const stage = path.join(process.cwd(), ".orch-update");
  fs.mkdirSync(stage, { recursive:true });
  for (const x of files){
    const st = path.join(stage, x.n);
    fs.writeFileSync(st, x.bytes);
    if (spawnSync(process.execPath, ["--check", st], { stdio:"pipe" }).status !== 0){
      suRejected.add(tag);
      log(C.red + "self-update REFUSED: candidate " + tag + " does not parse (" + x.n + ") — keeping " + ORCH_VERSION + C.reset);
      return null;
    }
  }
  const backup = path.join(process.cwd(), ".orch-backup");
  fs.mkdirSync(backup, { recursive:true });
  const restore = [];
  for (const x of files){
    if (fs.existsSync(x.dst)){ const b = path.join(backup, x.n + "." + ORCH_VERSION); fs.copyFileSync(x.dst, b); restore.push([b, x.dst]); }
    fs.copyFileSync(path.join(stage, x.n), x.dst);
  }
  const smoke = spawnSync(process.execPath, ["orchestrator.cjs","now"], { cwd:process.cwd(), encoding:"utf8", timeout:30000 });
  if (smoke.status !== 0){
    for (const [b, dst] of restore) fs.copyFileSync(b, dst);
    suRejected.add(tag);
    log(C.red + "self-update ROLLED BACK: " + tag + " failed to run here (" + String(smoke.stderr||"").trim().split("\n")[0].slice(0,120) + ") — restored " + ORCH_VERSION + C.reset);
    return null;
  }

  try {
    fs.appendFileSync(path.join(process.cwd(),"logs","orch-updates.jsonl"),
      JSON.stringify({ at:new Date().toISOString(), from:ORCH_VERSION, to:kitVer, kitCommit:kitSha, files:files.map(x=>x.n) })+"\n");
  } catch { /* logs/ may not exist yet — the update itself still happened */ }
  suPending = null;
  log(C.green + C.bold + "self-update APPLIED: " + ORCH_VERSION + " → " + kitVer + " (" + refLabel + " @ " + kitSha + ") — verified, restarting the watch…" + C.reset);
  log(C.dim + "(engine only — the agent instruction docs are NOT overwritten, your edits win. To take the kit's newer docs: node " + path.join(kit,"setup.cjs") + " --force)" + C.reset);
  return "applied " + tag;
}

// ─── Command mode: feed the ledger from in-session work, then exit (no watch loop) ───
// record <CR> "<gate>" <agent[:model]> <VERDICT> <secs> [tokens]
//        [--remarks-file <path>]                                  — log an in-session gate result
// revise <CR> <secs> [tokens]                                     — you revised the CR: bump + reset scope
// set    <CR> <STATUS>                                            — manual status set (e.g. ESCALATED)
{
  const cliArgs = process.argv.slice(2);
  const [rawCmd, a1, a2, a3, a4, a5, a6] = cliArgs;
  // A leading --flag (e.g. --until-idle) is NOT a command — it's a watch option. Treat it
  // as "no command" so it falls through to the board/watch instead of "unknown command".
  const cmd = (rawCmd && rawCmd.startsWith("--")) ? undefined : rawCmd;
  // Confine the resolved CR inside CR_DIR — reject anything that escapes it (`../`, absolute
  // paths, embedded separators). Returns null on any violation so callers print usage + exit.
  const CR_ROOT = path.resolve(CR_DIR);
  const resolveCR = id => {
    if (!id || typeof id !== "string") return null;
    const base = path.basename(id);                 // strip any directory component
    if (base !== id) return null;                    // id itself contained a separator / `..`
    if (!/^CR-[0-9A-Za-z_-]+$/i.test(base.replace(/\.md$/i, ""))) return null;
    const p = path.resolve(CR_ROOT, /\.md$/i.test(base) ? base : base + ".md");
    if (p !== path.join(CR_ROOT, path.basename(p))) return null; // must sit directly in CR_DIR
    return p;
  };
  // Allowlists — the ledger only accepts known tokens (finding #3: no arbitrary input).
  const AGENTS = new Set(["claude", "codex", "grok"]);
  const VERDICTS = new Set(["PASS","FAIL","COMPLETED","APPROVE","REJECT","CLOSE","REOPEN","REVISED","BUILT","READY"]);
  const STATUSES = new Set(["DRAFT","BUILD","TESTING","BUILD_DEPLOY","DEPLOY_WAIT","SIGNOFF","CLOSED","ESCALATED","FAST_BUILD","FAST_DEPLOY","FAST_CLOSE"]);
  if (cmd === "begin"){
    // An agent marks a gate STARTED so the board shows "in review"/"working" (not "awaiting
    // you") while it works. Writes an invisible RUNNING marker; the verdict still comes via record.
    const crPath = resolveCR(a1); const gate=a2; const [agent]=(a3||"").split(":");
    if(!crPath||!fs.existsSync(crPath)||!gate||!AGENTS.has(agent)){ console.log('usage: begin <CR> "<gate>" <agent>'); console.log(`  agent ∈ {${[...AGENTS].join(", ")}}`); process.exit(1); }
    if(!/^[A-Za-z0-9 +/&().-]{1,60}$/.test(gate)){ console.log("begin: gate name has unexpected characters"); process.exit(1); }
    // ROLE OWNERSHIP (multi-session routing, 2026-07-27): claude gates belong to the
    // BUILDER session. A session may declare itself via ORCH_ROLE=builder|orch; a
    // declared non-builder session is refused claude gates by the LEDGER, not by memory
    // or convention — "which session acts" becomes machine-enforced.
    {
      const myRole = (process.env.ORCH_ROLE || "").toLowerCase();
      if (agent === "claude" && myRole && myRole !== "builder"){
        console.log(`${C.yellow}begin refused:${C.reset} claude gates belong to the BUILDER session; this session declared ORCH_ROLE=${myRole}. (The orch-engineer session alerts and maintains — it does not build.)`);
        process.exit(1);
      }
    }
    // Collision guard: two sessions can silently work the SAME gate (it happened on
    // CR-0011 Building — one session begun it, another wrote the code). A begin while an
    // unfinished begin exists in scope needs an explicit override.
    {
      const started = runStartedAt(crPath, gate);
      const v = lastGateVerdict(crPath, gate);
      if (started && !v && !cliArgs.includes("--force")){
        console.log(`${C.yellow}begin refused:${C.reset} "${gate}" was already begun at ${started} with no verdict recorded — another session may be working it. Coordinate, or re-run with --force.`);
        process.exit(1);
      }
    }
    appendGates(crPath, `\n\n<!--RUNNING gate="${gate}" agent="${agent}" at="${new Date().toISOString()}" by="${process.env.TERM_SESSION_ID || process.ppid}"-->`);
    crLog(crPath, { type:"begin", agent, gate, at:new Date().toISOString(), source:"in-session" });
    console.log(`${C.green}✓ started${C.reset} ${gate} (${agent}) — board shows in-progress until you record the verdict.`);
    process.exit(0);
  }
  if (cmd === "record"){
    const crPath = resolveCR(a1); const gate=a2; const [agent,model]=(a3||"").split(":");
    const verdict=(a4||"").toUpperCase(); const secs=Number(a5)||0; const tokRaw=a6&&/^\d+$/.test(a6)?a6:"?";
    const remarksFlag = cliArgs.indexOf("--remarks-file");
    const remarksArg = remarksFlag >= 0 ? cliArgs[remarksFlag+1] : null;
    const extraStart = a6 && /^\d+$/.test(a6) ? 7 : 6;
    const allowedTail = remarksFlag === extraStart && cliArgs.length === extraStart+2;
    const hasUnexpectedArgs = cliArgs.length > extraStart && !allowedTail;
    if(!crPath||!fs.existsSync(crPath)||!gate||!AGENTS.has(agent)||!VERDICTS.has(verdict)||hasUnexpectedArgs){
      console.log('usage: record <CR> "<gate>" <agent[:model]> <VERDICT> <secs> [tokens] [--remarks-file <path>]');
      console.log(`  agent ∈ {${[...AGENTS].join(", ")}} · verdict ∈ {${[...VERDICTS].join(", ")}}`);
      process.exit(1);
    }
    // SIGN-OFF EVIDENCE GATE (owner moved sign-off to Claude, 2026-07-27): the builder may
    // close its own change ONLY when the ledger mechanically proves the deploy. Judgment is
    // not the safeguard here — these three facts are checked in code:
    //   (a) a deploy-output entry exists and is stamped with a commit,
    //   (b) that commit matches the commit the harness/Test ran against (shipped == tested),
    //   (c) the deploy output contains a success marker (no silent half-deploy).
    // (Migration evidence is already enforced when the CR moves to SIGNOFF.)
    if (/^sign-?off$/i.test(gate) && verdict === "CLOSE"){
      const g = readGates(crPath);
      const deployStamp = [...g.matchAll(/### Deploy output[^\n]*@ ([0-9a-f]{7,40})/gi)].pop();
      const testStamp   = [...g.matchAll(/### Machine validation \(harness\)[^\n]*@ ([0-9a-f]{7,40})/gi)].pop();
      const tail = deployStamp ? g.slice(deployStamp.index, deployStamp.index + 3000) : "";
      const succeeded = /Deploy complete|pm2 reload OK|reloaded via pm2|restarted via systemd/i.test(tail);
      const problems = [];
      if (!deployStamp) problems.push("no '### Deploy output … @ <commit>' entry in the ledger (paste the deploy output first)");
      if (!testStamp) problems.push("no commit-stamped harness entry to compare against");
      if (deployStamp && testStamp && !deployStamp[1].startsWith(testStamp[1]) && !testStamp[1].startsWith(deployStamp[1]))
        problems.push(`shipped commit ${deployStamp[1]} != tested commit ${testStamp[1]} — the deployed build was never verified`);
      if (deployStamp && !succeeded) problems.push("deploy output shows no success marker (pm2 reload / Deploy complete)");
      // v106 (TESTING_MODEL.md §7): a reload proves a restart, not a working app.
      // Require a commit-stamped POST-DEPLOY smoke run — same mechanical pattern as the
      // migration evidence. Only enforced when the standing smoke script exists, so
      // pre-v106 projects (and the kit before adoption) keep closing as before.
      if (fs.existsSync(path.join(process.cwd(), "server", "scripts", "smoke.mjs"))){
        const smokeStamp = [...g.matchAll(/### Smoke test[^\n]*@ ([0-9a-f]{7,40})[^\n]*— OK/gi)].pop();
        if (!smokeStamp) problems.push("no post-deploy '### Smoke test … — OK' entry (run: node orchestrator.cjs smoke <CR> after the deploy)");
        else if (deployStamp && !smokeStamp[1].startsWith(deployStamp[1]) && !deployStamp[1].startsWith(smokeStamp[1]))
          problems.push(`smoke test ran at commit ${smokeStamp[1]} but the deploy shipped ${deployStamp[1]} — re-run smoke after the deploy`);
      }
      if (problems.length){
        console.log(`${C.yellow}record refused:${C.reset} Sign-off CLOSE requires mechanical deploy evidence.`);
        for (const pb of problems) console.log(`  · ${pb}`);
        console.log(`  ${C.dim}Fix the evidence (or record REOPEN if the deploy genuinely failed).${C.reset}`);
        process.exit(1);
      }
    }
    // Prepare-deploy READY without deploy commands stalls DEPLOY_WAIT with "(no block
    // found)" — the human sits at a board that can't tell them what to run (CR-0011).
    if (/deploy/i.test(gate) && verdict === "READY" && !/#+\s*(\d+\.\s*)?Deploy commands/i.test(fs.readFileSync(crPath, "utf8"))){
      console.log(`${C.yellow}record refused:${C.reset} Prepare deploy READY requires a "## Deploy commands" section in the CR (the DEPLOY_WAIT board prints it for the human). Add it, then record again.`);
      process.exit(1);
    }
    if(!/^[A-Za-z0-9 +/&().-]{1,60}$/.test(gate)){ console.log("record: gate name has unexpected characters"); process.exit(1); }
    if(model && !/^[A-Za-z0-9._-]{1,40}$/.test(model)){ console.log("record: model tag has unexpected characters"); process.exit(1); }
    // v105: Security Review (code) added — on the lean lane it is the ONLY security
    // review a Low/Moderate CR receives; a bare PASS with no triage/findings file must
    // not be recordable. (The ten-bucket triage from SECURITY_MODEL.md lives in the
    // remarks, so requiring remarks IS requiring the triage.)
    const remarksRequired = (agent === "codex" && ["Technical Clearance","Test","Security Review (code)","Security Clearance"].includes(gate)) || BAD_VERDICT.test(verdict);
    let remarks = "";
    let remarksVerdict = null;
    if (remarksArg){
      try {
        const real = fs.realpathSync(path.resolve(remarksArg));
        const roots = [process.cwd(), require("os").tmpdir(), "/tmp"]
          .map(root => { try { return fs.realpathSync(root); } catch { return null; } })
          .filter(Boolean);
        if (!roots.some(root => real === root || real.startsWith(root + path.sep)))
          throw new Error("file must be inside the workspace or system temporary directory");
        const st = fs.statSync(real);
        if (!st.isFile()) throw new Error("path is not a regular file");
        if (st.size > 32*1024) throw new Error("file exceeds 32 KiB");
        remarks = fs.readFileSync(real, "utf8").replace(/\0/g, "").trim();
        const lines = remarks.split("\n");
        const first = (lines[0]||"").trim().replace(/[*`_]/g,"").toUpperCase();
        if (VERDICTS.has(first)) remarksVerdict = first;
        if (remarksVerdict && remarksVerdict !== verdict)
          throw new Error(`first-line verdict ${remarksVerdict} does not match record verdict ${verdict}`);
        if (remarksVerdict === verdict)
          remarks = lines.slice(1).join("\n").trim();
      } catch(e){
        console.log(`record: cannot read --remarks-file: ${e.message}`);
        process.exit(1);
      }
    }
    if (remarksRequired && (remarksVerdict !== verdict || !remarks)){
      console.log(`record: ${gate} ${verdict} requires --remarks-file whose first line is ${verdict}, followed by non-empty findings`);
      process.exit(1);
    }
    const rev = getRevisions(fs.readFileSync(crPath,"utf8"));
    const body = remarks ? `${verdict}\n\n${remarks}` : verdict;
    // v104: for Claude gates the ledger figure is MEASURED from the session transcript
    // (begin marker -> now). The typed <tokens> argument is accepted for compatibility
    // but IGNORED — a measurement that fails records "?" (honest unknown), never the
    // self-reported guess: every prior Claude figure was fabricated by the session,
    // which cannot see its own usage counters.
    let tokensField = tokRaw, extraAttrs = "", notes = [];
    if (agent === "claude"){
      const startAt = runStartedAt(crPath, gate);
      // Claude Code flushes the transcript line for the CURRENT turn only after its tool
      // call returns — a measurement taken at that exact instant can miss the last entry
      // by ~100ms. Retry briefly before declaring the window unmeasurable.
      let m = null;
      if (CU && startAt){
        for (let t = 0; t < 3 && !m; t++){
          if (t) spawnSync("sleep", ["1"]);
          m = CU.measureWindow(startAt, new Date().toISOString());
        }
      }
      if (m){
        tokensField = String(m.teq);   // tokens= carries TEQ so budget walls stay meaningful
        extraAttrs = ` tokens_in=${m.total.input} tokens_out=${m.total.output} cache_read=${m.total.cacheRead} cache_write=${m.total.cacheWrite} teq=${m.teq} measured=1`;
        notes.push(`  measured: ${CU.fmtTok(m.total.input)} in · ${CU.fmtTok(m.total.output)} out · ${CU.fmtTok(m.total.cacheRead)} cache read · ${CU.fmtTok(m.total.cacheWrite)} cache write · ${CU.fmtTok(m.teq)} TEQ`);
        if (/^\d+$/.test(tokRaw) && Number(tokRaw) > 0 && Math.abs(m.teq - Number(tokRaw)) / Number(tokRaw) > 0.2)
          notes.push(`  ${C.yellow}⚠ self-reported ${Number(tokRaw).toLocaleString()} — ignored (measured TEQ is ${(m.teq / Number(tokRaw)).toFixed(1)}x)${C.reset}`);
      } else {
        tokensField = "?"; extraAttrs = " measured=0";
        notes.push(startAt
          ? `  ${C.yellow}⚠ unmeasured — transcript unreadable for this window; recorded tokens=?${C.reset}`
          : `  ${C.yellow}⚠ unmeasured — no begin marker for this gate (run begin first); recorded tokens=?${C.reset}`);
      }
    }
    const cls = gateClass(gate);
    appendGates(crPath, `\n\n<!--METRIC gate="${gate}" agent="${agent}"${model?` model="${model}"`:""} rev=${rev} class="${cls}" seconds=${secs} tokens=${tokensField}${extraAttrs} at="${new Date().toISOString()}" orch="${ORCH_VERSION}"-->\n### Gate: ${gate} (${agent}) — rev ${rev} — ${new Date().toISOString()}\n\n${body}\n`);
    crLog(crPath, { type:"gate", agent, gate, model:model||undefined, rev, verdict, secs,
      tokens: tokensField==="?"?null:Number(tokensField),
      measured: agent==="claude" ? tokensField !== "?" : undefined, source:"in-session", remarks:remarks||undefined });
    console.log(`${C.green}✓ recorded${C.reset} ${gate} (${agent}${model?"·"+model:""}) ${verdict} · ${secs}s${agent==="claude" ? "" : ` · ${tokRaw} tok`} → ${a1}`);
    for (const n of notes) console.log(n);
    process.exit(0);
  }
  if (cmd === "revise"){
    const crPath = resolveCR(a1); const secs=Number(a2)||0; const tokRaw=a3&&/^\d+$/.test(a3)?a3:"?";
    if(!crPath||!fs.existsSync(crPath)){ console.log("usage: revise <CR> <secs> [tokens]"); process.exit(1); }
    // Guard: revise is only meaningful when the CURRENT scope holds a failed verdict.
    // Without this, running it twice per lap double-burns the revision cap (CR-0011
    // went 0→2→4 and hit ESCALATED at half the intended budget).
    {
      const gAll = readGates(crPath);
  // Row verdicts read the CURRENT review scope (after the last revision/retry/owner
  // marker) — a PREVIOUS revision's PASS must not render as this revision's ✓ (Security
  // showed green while the revised spec still owed its re-run). Metrics/fail counts stay
  // whole-file: history is additive, verdicts are scoped.
  const _scopeIdx = Math.max(gAll.lastIndexOf("## Revision"), gAll.lastIndexOf("### Build retry"),
    gAll.lastIndexOf("### Owner decision"), gAll.lastIndexOf("### Recovery"), gAll.lastIndexOf("### Status correction"));
  const g = _scopeIdx >= 0 ? gAll.slice(_scopeIdx) : gAll;
      const idx = Math.max(g.lastIndexOf("## Revision"), g.lastIndexOf("### Build retry"),
        g.lastIndexOf("### Owner decision"), g.lastIndexOf("### Recovery"), g.lastIndexOf("### Status correction"));
      const scope = idx>=0 ? g.slice(idx) : g;
      if (!/### Gate: [^\n]+\n\n(?:\**)(FAIL|REJECT|REOPEN)/.test(scope)){
        console.log(`${C.yellow}revise refused:${C.reset} no failed verdict in the current scope — the previous revision already reset it. (Guard against double-burning the revision cap.)`);
        process.exit(1);
      }
    }
    const nr = bumpRevisions(crPath);
    appendGates(crPath, `\n\n<!--METRIC gate="Revise" agent="claude" model="in-session" rev=${nr} class="rework" seconds=${secs} tokens=${tokRaw} at="${new Date().toISOString()}" orch="${ORCH_VERSION}"-->\n### Gate: Revise (claude) — rev ${nr} — ${new Date().toISOString()}\n\nREVISED\n\n## Revision ${nr} — ${new Date().toISOString()}\n`);
    crLog(crPath, { type:"gate", agent:"claude", gate:"Revise", rev:nr, verdict:"REVISED", secs, tokens: tokRaw==="?"?null:Number(tokRaw), source:"in-session" });
    setStatus(crPath, fs.readFileSync(crPath,"utf8"), "DRAFT");
    console.log(`${C.green}✓ revision ${nr}/3 recorded${C.reset} · scope reset → review re-runs (${a1})`);
    process.exit(0);
  }
  if (cmd === "set"){
    const crPath = resolveCR(a1); const st=(a2||"").toUpperCase();
    if(!crPath||!fs.existsSync(crPath)||!STATUSES.has(st)){ console.log("usage: set <CR> <STATUS>"); console.log(`  status ∈ {${[...STATUSES].join(", ")}}`); process.exit(1); }
    // MIGRATION EVIDENCE GATE (CR-0012 retro, 2026-07-27): a CR that ships a migration
    // cannot reach SIGNOFF until the ledger records that the migration actually RAN in
    // production. CR-0012 deployed code without its schema (the deploy script replaced
    // itself mid-run) and every other gate still passed — this converts a silent omission
    // into a required, recorded, reviewer-checkable statement.
    if (st === "SIGNOFF"){
      const crid = path.basename(crPath).replace(/\.md$/i, "");
      const mig = "migrate_" + crid.toLowerCase().replace(/-/g, "") + ".js";
      if (fs.readFileSync(crPath, "utf8").includes(mig) && !readGates(crPath).includes("MIGRATION-VERIFIED: " + mig)){
        console.log(`${C.yellow}set refused:${C.reset} ${crid} ships ${mig} — the ledger has no proof it ran in production.`);
        console.log(`  Run it on the server, paste the output into crs/.gates/${crid}.md, and add the line:`);
        console.log(`  ${C.bold}MIGRATION-VERIFIED: ${mig}${C.reset}   ${C.dim}(Sign-off then verifies that claim against the pasted output.)${C.reset}`);
        process.exit(1);
      }
    }
    setStatus(crPath, fs.readFileSync(crPath,"utf8"), st);
    console.log(`${C.green}✓${C.reset} ${a1} → ${st}`);
    process.exit(0);
  }
  // authorize — the OWNER's escape hatch from a cap escalation. `set <CR> BUILD` alone can
  // never resume a capped CR: without a scope-reset marker the orch re-reads the STALE
  // recorded Building COMPLETED + Test FAIL and insta-re-escalates (the 17-second trap).
  // This appends the "### Owner decision" marker (recognized by lastGateVerdict/gateDone),
  // resets the build→test cycle counter, logs the decision, and re-arms the CR at BUILD.
  if (cmd === "authorize"){
    const crPath = resolveCR(a1); const note = (a2||"").trim();
    if(!crPath||!fs.existsSync(crPath)||!note){ console.log('usage: authorize <CR> "<owner decision — e.g. one more build→test cycle>"'); process.exit(1); }
    appendGates(crPath, `\n\n### Owner decision — ${new Date().toISOString()}\n\n${note}\n`);
    let t = fs.readFileSync(crPath,"utf8");
    // A fresh owner authorization grants a fresh budget: reset BOTH counters — a
    // revision-cap escalation (DRAFT side) is otherwise unresumable, since only the
    // cycle counter was reset and the next review FAIL would insta-re-escalate.
    t = t.replace(/(build→test cycles:\s*)\d+/i, (_, p1) => p1 + "0")
         .replace(/(CR revisions:\s*)\d+/i, (_, p1) => p1 + "0");
    fs.writeFileSync(crPath, t);
    crLog(crPath, { type:"owner-decision", note, at:new Date().toISOString(), source:"human" });
    const wasDraftSide = /### Gate: (Technical|Security) Clearance[\s\S]{0,400}?\n\n(?:\**)(FAIL|REJECT)[^]*$/.test(readGates(crPath).slice(-4000));
    setStatus(crPath, fs.readFileSync(crPath,"utf8"), wasDraftSide ? "DRAFT" : "BUILD");
    console.log(`${C.green}✓ owner decision recorded${C.reset} — scope + both counters reset, ${a1} → ${wasDraftSide?"DRAFT (review re-runs)":"BUILD (rebuild, then Test re-runs)"}.`);
    process.exit(0);
  }
  // rootcause — Claude's mandatory loop-breaker step at 3+ lifetime same-gate FAILs.
  // Recorded AFTER reading ALL prior FAIL entries in the gate log: name the defect CLASS
  // (not the instance) and the class-complete fix plan. Unlocks exactly one retry; if the
  // gate fails again after this, the orch escalates with a decompose recommendation.
  if (cmd === "rootcause"){
    const crPath = resolveCR(a1); const note=(a2||"").trim(); const secs=Number(a3)||0; const tokRaw=a4&&/^\d+$/.test(a4)?a4:"?";
    if(!crPath||!fs.existsSync(crPath)||!note){ console.log('usage: rootcause <CR> "<defect class + class-complete fix plan>" <secs> [tokens]'); process.exit(1); }
    appendGates(crPath, `\n\n<!--METRIC gate="Root cause" agent="claude" model="in-session" rev=0 class="rework" seconds=${secs} tokens=${tokRaw} at="${new Date().toISOString()}" orch="${ORCH_VERSION}"-->\n### Root cause (claude) — ${new Date().toISOString()}\n\n${note}\n`);
    crLog(crPath, { type:"rootcause", agent:"claude", note, secs, tokens: tokRaw==="?"?null:Number(tokRaw), source:"in-session" });
    console.log(`${C.green}✓ root cause recorded${C.reset} — one class-complete retry unlocks; another same-gate FAIL escalates to decompose.`);
    process.exit(0);
  }
  // ask — Claude is about to ask the OWNER a question about this CR (e.g. via an
  // AskUserQuestion dialog in its session). The ledger must know FIRST, or the board
  // keeps showing the next recorded gate (e.g. "Technical Clearance — codex") while the
  // pipeline is actually blocked on the human. One command: question → NEEDS-HUMAN +
  // ESCALATED → the board shows WHO it's really waiting on. Resume via `authorize`.
  if (cmd === "ask"){
    const crPath = resolveCR(a1); const q=(a2||"").trim();
    if(!crPath||!fs.existsSync(crPath)||!q){ console.log('usage: ask <CR> "<one-line owner question>"'); process.exit(1); }
    appendGates(crPath, `\n\nNEEDS-HUMAN: ${q}\n`);
    crLog(crPath, { type:"escalation", question:q, source:"in-session" });
    setStatus(crPath, fs.readFileSync(crPath,"utf8"), "ESCALATED");
    console.log(`${C.green}✓ owner question recorded${C.reset} — ${a1} → ESCALATED; the board now shows the pipeline is waiting on the human.`);
    process.exit(0);
  }
  // prompts — show what the orch dispatched to which agent for a CR.
  if (cmd === "prompts"){
    const crPath = resolveCR(a1);
    if(!crPath){ console.log("usage: prompts <CR> [last]"); process.exit(1); }
    const dir = path.join("logs", "prompts", path.basename(crPath).replace(/\.md$/i, ""));
    let files = [];
    try { files = fs.readdirSync(dir).sort(); } catch { /* none */ }
    if (!files.length){ console.log("no dispatched prompts recorded for " + a1 + " (recorded from orch v88 onward)."); process.exit(0); }
    if ((a2 || "").toLowerCase() === "last"){
      const f2 = files[files.length - 1];
      console.log(C.bold + "── " + f2 + " ──" + C.reset + "\n");
      console.log(fs.readFileSync(path.join(dir, f2), "utf8"));
    } else {
      for (const f2 of files){
        const st = fs.statSync(path.join(dir, f2));
        console.log(`${f2}  ${C.dim}(${(st.size/1024).toFixed(1)}kb)${C.reset}`);
      }
      console.log(`\n${C.dim}view one: node orchestrator.cjs prompts ${a1} last  (or open logs/prompts/…)${C.reset}`);
    }
    process.exit(0);
  }
  // retro — the learning loop's record step. After a CR closes, Claude (as orch engineer)
  // analyzes the ledger, improves the pipeline (quality-first), pushes, then records here.
  if (cmd === "retro"){
    if ((process.env.ORCH_ROLE || "").toLowerCase() === "builder"){
      console.log(`${C.yellow}retro refused:${C.reset} retrospectives belong to the ORCH-ENGINEER session (ORCH_ROLE=orch).`);
      process.exit(1);
    }
    const crPath = resolveCR(a1); const note=(a2||"").trim(); const secs=Number(a3)||0; const tokRaw=a4&&/^\d+$/.test(a4)?a4:"?";
    if(!crPath||!fs.existsSync(crPath)||!note){ console.log('usage: retro <CR> "<lessons + pipeline changes made>" <secs> [tokens]'); process.exit(1); }
    appendGates(crPath, `\n\n<!--METRIC gate="Retrospective" agent="claude" model="in-session" rev=0 class="ceremony" seconds=${secs} tokens=${tokRaw} at="${new Date().toISOString()}" orch="${ORCH_VERSION}"-->\n### Retrospective (claude) — ${new Date().toISOString()}\n\n${note}\n`);
    crLog(crPath, { type:"retro", note, secs, tokens: tokRaw==="?"?null:Number(tokRaw), source:"in-session" });
    console.log(`${C.green}✓ retrospective recorded${C.reset} — the pipeline learned from ${a1}.`);
    // CROSS-PROJECT LEARNING: a lesson recorded only in this project's ledger is invisible
    // to every other project. Journal it into the KIT repo (the one place all projects
    // share) and push, best-effort: the local record above already succeeded, so a journal
    // failure must degrade to a loud notice, never to a failed retro.
    {
      const kit = suKitDir();
      if (fs.existsSync(path.join(kit, ".git"))){
        try {
          const jp = path.join(kit, "RETRO_LOG.md");
          if (!fs.existsSync(jp)) fs.writeFileSync(jp,
            "# Retro journal — every project appends here via `retro`\n\n" +
            "AN INBOX, NOT AN ARCHIVE (owner rule): every entry here is an OPEN item. Acting on a\n" +
            "lesson means fixing the kit/docs AND DELETING the entry — the durable record is the\n" +
            "kit commit + the CR ledger. An empty file means a healthy pipeline, not lost history.\n");
          const project = (ORCH_CFG.projectName || path.basename(process.cwd()));
          fs.appendFileSync(jp, `\n## ${new Date().toISOString().slice(0,10)} · ${project} · ${a1} (orch ${ORCH_VERSION})\n${note}\n`);
          const gA = suGit(kit, ["add", "RETRO_LOG.md"]);
          const gC = gA.status === 0 ? suGit(kit, ["commit", "-q", "-m", `retro: ${project} ${a1}`]) : gA;
          const gP = gC.status === 0 ? suGit(kit, ["push", "-q"]) : gC;
          if (gP.status === 0) console.log(`${C.dim}lesson journaled to the kit (RETRO_LOG.md) — visible to all projects.${C.reset}`);
          else console.log(`${C.yellow}lesson written to ${jp} but NOT pushed (${String((gP.stderr||"").trim()).split("\n")[0].slice(0,80) || "git error"}) — push the kit repo so other projects can see it.${C.reset}`);
        } catch (e) {
          console.log(`${C.yellow}could not journal the lesson to the kit (${e.message}) — it exists only in this project's ledger.${C.reset}`);
        }
      } else {
        console.log(`${C.yellow}no kit repo at ${kit} — the lesson exists only in this project's ledger.${C.reset}`);
      }
    }
    process.exit(0);
  }
  // now — report the ONE active in-session task (single-lane). An agent triggered with a bare
  // "review" / "build" / "deploy" runs this to learn WHICH CR + WHICH gate is its job right now,
  // then does that gate and records it. This is what makes one-word triggers deterministic.
  if (cmd === "lessons"){
    // What is going wrong, centrally: (1) unaddressed lessons from EVERY project via the
    // kit's shared journal, (2) this project's own waste profile (rework share, loop-backs,
    // escalations) from the ledgers. Read-only; changes nothing.
    const kit = suKitDir();
    console.log(C.bold + "── Cross-project lessons (kit journal) ──" + C.reset);
    const jp = path.join(kit, "RETRO_LOG.md");
    // INBOX SEMANTICS (owner rule, 2026-07-28): the journal must never accumulate junk.
    // Every entry present IS an open item; acting on a lesson means DELETING its entry
    // (the durable record is the kit commit that implements it + the CR ledger where the
    // retro was recorded). An empty log = a healthy pipeline, not a lost history.
    if (!fs.existsSync(jp)) console.log(C.dim + "no RETRO_LOG.md at " + kit + " — inbox empty; no project has journaled a retro." + C.reset);
    else {
      suGit(kit, ["pull", "--ff-only", "--quiet"]);
      const entries = fs.readFileSync(jp, "utf8").split(/\n## /).slice(1);
      if (!entries.length) console.log(C.green + "  inbox empty — every journaled lesson has been acted on." + C.reset);
      for (const e of entries) console.log(`  ${C.yellow}○${C.reset} ${e.split("\n")[0]}`);
      if (entries.length) console.log(C.yellow + `  ${entries.length} open lesson(s) — act on each (fix the kit / the project docs), then DELETE its entry and push.` + C.reset);
    }
    console.log("\n" + C.bold + "── This project's waste profile (closed CRs) ──" + C.reset);
    let crFiles = [];
    try { crFiles = fs.readdirSync(CR_DIR).filter(x=>/^CR-\d+\.md$/.test(x)).sort(); } catch { /* none */ }
    let any = false;
    for (const cf of crFiles){
      const t = fs.readFileSync(path.join(CR_DIR, cf), "utf8");
      if (!/\*\*Status:\*\*\s*CLOSED/i.test(t)) continue;
      const gAll = readGates(path.join(CR_DIR, cf));
      let tot=0, rework=0; const runs={}; const failBy={};
      for (const m of gAll.matchAll(/<!--METRIC gate="([^"]*)"[^>]*? tokens=(\d+)/g)){
        const gt=m[1], tk=+m[2]; runs[gt]=(runs[gt]||0)+1; tot+=tk;
        if (/^(Revise|Root cause)$/i.test(gt) || runs[gt]>1) rework+=tk;
      }
      for (const m of gAll.matchAll(/### Gate: ([^(]+?) \([\s\S]{0,400}?\n\n(?:\**)(FAIL|REJECT|REOPEN)/gi))
        failBy[m[1].trim()]=(failBy[m[1].trim()]||0)+1;
      const esc = (gAll.match(/NEEDS-HUMAN:/g)||[]).length;
      const pct = tot?Math.round(rework/tot*100):0;
      const flag = pct>=30 ? C.red : pct>=15 ? C.yellow : C.green;
      console.log(`  ${cf.replace(/\.md$/,"")}  ${Math.round(tot/1000)}k tok · ${flag}rework ${pct}%${C.reset}` +
        (Object.keys(failBy).length ? ` · loop-backs: ${Object.entries(failBy).map(([g2,n])=>g2+"×"+n).join(", ")}` : " · clean") +
        (esc ? ` · escalations ${esc}` : ""));
      any = true;
    }
    if (!any) console.log(C.dim + "  no closed CRs here yet." + C.reset);
    console.log("\n" + C.dim + "read a lesson's full text: " + path.join(kit, "RETRO_LOG.md") + C.reset);
    process.exit(0);
  }
  if (cmd === "smoke"){
    // v106 (TESTING_MODEL.md §7): post-deploy smoke against the DEPLOYED host. A clean
    // pm2 reload proves a process restarted, not that the app works (CR-0012 shipped
    // without its schema and every gate passed). runCmd commit-stamps the entry; the
    // sign-off gate refuses CLOSE without a matching "### Smoke test … — OK".
    const crPath = resolveCR(a1);
    if(!crPath||!fs.existsSync(crPath)){ console.log("usage: smoke <CR>   (runs server/scripts/smoke.mjs against deploy.smokeUrl)"); process.exit(1); }
    const smokeUrl = (ORCH_CFG.deploy && ORCH_CFG.deploy.smokeUrl) || process.env.SMOKE_URL;
    if (!smokeUrl){ console.log(`${C.yellow}smoke refused:${C.reset} no deploy.smokeUrl in orch.config.json (and no SMOKE_URL env) — set it to the deployed host, e.g. "https://your-app.example".`); process.exit(1); }
    if (!fs.existsSync(path.join(process.cwd(), "server", "scripts", "smoke.mjs"))){ console.log(`${C.yellow}smoke refused:${C.reset} server/scripts/smoke.mjs not found — the standing smoke script is required (TESTING_MODEL.md §7).`); process.exit(1); }
    const ok = runCmd(crPath, "Smoke test", `SMOKE_URL=${JSON.stringify(smokeUrl)} node server/scripts/smoke.mjs`, false, { timeoutMs: 120000 });
    console.log(ok ? `${C.green}✓ smoke OK — commit-stamped in the ledger; Sign-off can now close.${C.reset}`
                   : `${C.red}✗ smoke FAILED — the deployed app is not healthy; fix before closing (the entry is recorded).${C.reset}`);
    process.exit(ok ? 0 : 1);
  }
  if (cmd === "report"){
    // On-demand (re)generation of a CR's consumption report — appends a fresh report to
    // the gate ledger and prints it. Useful after a close, or to inspect a CR's spend.
    const crPath = resolveCR(a1);
    if(!crPath||!fs.existsSync(crPath)){ console.log("usage: report <CR>"); process.exit(1); }
    const before = readGates(crPath).length;
    writeConsumptionReport(crPath);
    const g = readGates(crPath);
    const idx = g.lastIndexOf("## Consumption Report");
    console.log(idx>=0 ? g.slice(idx) : "(no metrics found for this CR)");
    process.exit(0);
  }
  if (cmd === "update"){
    // Explicit upgrade, on demand: same safety rules as the automatic path.
    const dry = cliArgs.includes("--check");
    const r = suCheck({ force:true, dry });
    if (!r) console.log(dry ? "engine is current (or the kit is unreachable — see any notice above)" : "nothing applied — see the reason above (mid-gate, unverifiable, or already current)");
    else console.log(C.green + "✓ " + r + C.reset);
    if (!dry && /^applied/.test(r||"")) console.log(C.dim + "restart the watch (or let its next poll hot-reload it) to run the new engine." + C.reset);
    process.exit(0);
  }
  if (cmd === "now"){
    if (!fs.existsSync(CR_DIR)){ console.log("no crs/ directory."); process.exit(0); }
    const files = fs.readdirSync(CR_DIR).filter(x=>/^CR-\d+.*\.md$/i.test(x)).sort();
    const infos = files.map(x=>{ const t=fs.readFileSync(path.join(CR_DIR,x),"utf8");
      const s=(t.match(/\*\*Status:\*\*\s*([A-Z_]+)/i)||[])[1]; return { f:x, s:s?s.toUpperCase():null, files:filesOf(t), deps:dependsOn(t) }; });
    const statusOf = id => { const i=infos.find(y=>y.f.replace(/\.md$/,"")===id); return i?i.s:"CLOSED"; };
    const blockReason = info => {
      for (const d of info.deps){ if (statusOf(d)!=="CLOSED") return `depends on ${d} (${statusOf(d)})`; }
      for (const j of infos){ if (j.f<info.f && j.s && j.s!=="CLOSED"){ const o=overlaps(info.files, j.files); if (o) return `shares ${o} with ${j.f.replace(/\.md$/,"")}`; } }
      return null;
    };
    const act = infos.find(i => i.s && i.s!=="CLOSED" && !PARKED(i.s) && !blockReason(i));
    if (!act){
      // Pending retrospective on a closed CR is in-session Claude work (trigger: "review CR").
      for (const i of infos){
        if (i.s!=="CLOSED") continue;
        const g = readGates(path.join(CR_DIR, i.f));
        const rp = g.lastIndexOf("<!--RETRO-PENDING");
        if (rp < 0 || g.indexOf("### Retrospective", rp) >= 0) continue;
        const id = i.f.replace(/\.md$/,"");
        console.log(`${C.bold}▶ ${id} — Retrospective${C.reset}  (owner: claude, as orch engineer)`);
        console.log(`  Claude: analyze crs/.gates/${id}.md (verdicts, consumption report, rework split) — what should the PIPELINE learn?`);
        console.log(`  Quality is the top priority: improvements make the agents smarter/more efficient, never less thorough.`);
        console.log(`  Apply orch/doc improvements, push to git, then record:`);
        console.log(`  record: ${C.bold}node orchestrator.cjs retro ${id} "<lessons + changes made>" <secs> <tokens>${C.reset}`);
        process.exit(0);
      }
      const parked = infos.find(i => i.s && PARKED(i.s));
      if (parked && parked.s==="DEPLOY_WAIT") console.log(`⏸ ${parked.f.replace(/\.md$/,"")} — DEPLOY_WAIT: human runs the deploy + pastes output; Claude then closes through the machine gate. Nothing in-session.`);
      else if (parked && parked.s==="FAST_DEPLOY") console.log(`⏸ ${parked.f.replace(/\.md$/,"")} — FAST_DEPLOY: human deploys + pastes output. Nothing in-session.`);
      else if (parked && parked.s==="ESCALATED") console.log(`⛔ ${parked.f.replace(/\.md$/,"")} — ESCALATED: waiting on a human decision. Nothing in-session.`);
      else console.log("✓ nothing awaiting in-session work — no active CR.");
      process.exit(0);
    }
    // A pending retrospective must never be masked by a busy queue (CR-0013 hid CR-0012's).
    for (const i2 of infos){
      if (i2.s !== "CLOSED") continue;
      const g2 = readGates(path.join(CR_DIR, i2.f));
      const rp = g2.lastIndexOf("<!--RETRO-PENDING");
      if (rp >= 0 && g2.indexOf("### Retrospective", rp) < 0){
        console.log(`${C.mag}${C.bold}◆ ALSO OWED — retrospective: ${i2.f.replace(/\.md$/,"")}${C.reset}${C.dim}  (say "review CR" - analyse the ledger, improve the pipeline, then record it)${C.reset}\n`);
        break;
      }
    }
    const crId = act.f.replace(/\.md$/,""); const crPath = path.join(CR_DIR, act.f);
    const stage = PIPELINE.find(s=>s.status===act.s);
    if (!stage){ console.log(`… ${crId} at ${act.s} — no pipeline stage; orch handles it next poll.`); process.exit(0); }
    // Walk the stage's gates in order; report the first not-yet-done gate.
    let pending=null;
    for (const g of stage.gates){ if (gateDone(crPath, g.gate)) continue; const v=lastGateVerdict(crPath,g.gate); if (v && BAD_VERDICT.test(v)){ pending={g, failed:true}; break; } pending={g}; break; }
    if (!pending){ console.log(`… ${crId} at ${act.s} — gates complete; orch advances it next poll.`); process.exit(0); }
    const g = pending.g;
    const rec = agent => `node orchestrator.cjs record ${crId} "${g.gate}" ${agent}`;
    const beg = agent => `node orchestrator.cjs begin ${crId} "${g.gate}" ${agent}`;
    if (pending.failed){
      const isTest = act.s === "TESTING";
      // Loop-breaker takes precedence: at 3+ lifetime Test FAILs with no root cause recorded
      // for the latest one, the task is the ROOT-CAUSE step, not another quick lap.
      if (isTest){
        const h = gateFailHistory(crPath, "Test");
        if (h.count >= 3 && h.rcIdx <= h.lastIdx){
          console.log(`${C.bold}▶ ${crId} — Root cause${C.reset}  (owner: claude)`);
          console.log(`  ${C.dim}Test has FAILed ${h.count}x lifetime — the quick retry is LOCKED until a class analysis is recorded.${C.reset}`);
          console.log(`  Claude: read ALL prior FAIL entries in crs/.gates/${crId}.md (not just the latest); name the defect CLASS,`);
          console.log(`  why prior fixes missed it, and the class-complete fix plan. Then record it:`);
          console.log(`  record: ${C.bold}node orchestrator.cjs rootcause ${crId} "<class + plan>" <secs> <tokens>${C.reset}`);
          console.log(`  ${C.dim}This unlocks ONE retry; another Test FAIL after it escalates with a decompose recommendation.${C.reset}`);
          process.exit(0);
        }
      }
      console.log(`${C.bold}▶ ${crId} — ${isTest?"Build retry":"Revise"}${C.reset}  (owner: claude)`);
      console.log(`  ${C.dim}source: failed ${g.gate} · full findings: crs/.gates/${crId}.md${C.reset}`);
      if (isTest){
        console.log("  Claude: read the latest failed gate entry and fix every finding. The orchestrator routes TESTING → BUILD on its next poll.");
      } else {
        console.log(`  ${C.dim}mark started:${C.reset} node orchestrator.cjs begin ${crId} "Revise" claude   ${C.dim}(board → "CLAUDE is revising…")${C.reset}`);
        console.log(`  Claude: read the latest failed gate entry, revise crs/${act.f} in place, then record the revision.`);
        console.log(`  record: ${C.bold}node orchestrator.cjs revise ${crId} <secs> <tokens>${C.reset}`);
      }
      process.exit(0);
    }
    console.log(`${C.bold}▶ ${crId} — ${g.gate}${C.reset}  (owner: ${g.agent})`);
    console.log(`  ${C.dim}crs/${act.f} · status ${act.s}${C.reset}`);
    if (g.agent==="codex"){
      console.log(`  ${C.dim}mark started:${C.reset} ${beg("codex")}`);
      console.log(`  Codex: review crs/${act.f} per AGENTS.md${g.gate==="Test"?" + the committed diff (harness output is in crs/.gates/"+crId+".md)":""}. FIRST line PASS or FAIL.`);
      console.log(`  record: ${C.bold}${rec("codex:gpt-5.6-sol")} <PASS|FAIL> <secs> <tokens> --remarks-file <review.md>${C.reset}`);
    } else if (g.agent==="claude"){
      const verb = /deploy/i.test(g.gate) ? "push + write '### Deploy commands' into the CR, then record READY"
                 : /close/i.test(g.gate) ? "write the closure note, then record COMPLETED"
                 : "implement crs/"+act.f+", commit, then record COMPLETED";
      console.log(`  ${C.dim}mark started:${C.reset} ${beg("claude")}`);
      console.log(`  Claude (this session): ${verb}.`);
      console.log(`  record: ${C.bold}${rec("claude:opus")} <COMPLETED|READY|FAIL> <secs>${C.reset}${C.dim}  (tokens are MEASURED from the session transcript — v104)${C.reset}`);
    } else {
      console.log(`  ${C.dim}${g.gate} belongs to ${g.agent} — nothing in-session; wait for the board.${C.reset}`);
    }
    process.exit(0);
  }
  // A mistyped command used to fall through into the WATCH LOOP — so `orchestrator.cjs updat`
  // silently started a second board instead of reporting the typo. Fail loudly instead.
  if (cmd){
    console.log(`${C.yellow}unknown command:${C.reset} ${cmd}`);
    console.log(`${C.dim}commands: now · begin · record · revise · set · authorize · ask · rootcause · prompts · retro · lessons · smoke · update [--check]`);
    console.log(`(no command at all = run the board/watch)${C.reset}`);
    process.exit(1);
  }
}



// ─── SINGLE-INSTANCE LOCK: one board per project, enforced mechanically ─────
// 2026-07-28: ~14 orphaned watches accumulated (operator restarts whose kill
// pattern missed full-path cmdlines) and EACH dispatched its own Codex review of
// the same gate — quadruplicate ledger entries, ~50k tokens burned on one CR.
// Operator discipline failed, so the engine now refuses: a second watch in the
// same project exits immediately. The lockfile carries the owner pid; a stale
// lock (dead pid, or pid that is no longer an orchestrator) is reclaimed. The
// hot-reload child inherits legitimately (its parent holds the lock).
const WATCH_LOCK = path.join(process.cwd(), ".orch.lock");
function acquireWatchLock(){
  try {
    const prev = parseInt(fs.readFileSync(WATCH_LOCK, "utf8"), 10);
    if (prev && prev !== process.pid && prev !== process.ppid){
      let alive = false;
      try { process.kill(prev, 0); alive = true; } catch { /* dead → stale */ }
      if (alive){
        const cmd = spawnSync("ps", ["-p", String(prev), "-o", "command="], { encoding:"utf8" }).stdout || "";
        if (/orchestrator\.cjs/.test(cmd)){
          banner(`another watch (pid ${prev}) is already running in this project — exiting. One board per project; stop it with: kill ${prev}`, C.red);
          process.exit(1);
        }
      }
    }
  } catch { /* no lock file → free */ }
  fs.writeFileSync(WATCH_LOCK, String(process.pid));
  const drop = () => { try { if (parseInt(fs.readFileSync(WATCH_LOCK, "utf8"), 10) === process.pid) fs.unlinkSync(WATCH_LOCK); } catch { /* */ } };
  process.on("exit", drop);
}
acquireWatchLock();

checkAuth();

banner(`Orchestrator ${ORCH_VERSION} — Claude in-session; Codex ${CODEX_AUTO?"AUTO":"in-session"} (reviews + security); Claude closes (machine-gated).`, C.green);
log(SU.enabled
  ? `${C.dim}self-update: ${SU.channel === "release" ? "released versions only" : "every commit on " + SU.branch} from ${suKitDir()}, checked every ${Math.max(5, Number(SU.checkEveryMin)||60)}min — applied only when no gate is mid-flight and only if the new engine runs here${C.reset}`
  : `${C.dim}self-update: off (enable with "selfUpdate":{"enabled":true} in orch.config.json)${C.reset}`);
if (SU.enabled) { suNextCheck = Date.now() + 5000; }   // first check shortly after boot, not during it
log(`polling every ${POLL_MS/1000}s · Ctrl+C to stop (instant when idle)`);

process.on("SIGINT", ()=>{ console.log("\n"+C.dim+"stopping."+C.reset); process.exit(0); });

// The `running` latch prevents overlapping ticks — but if a tick's await never settles
// (hung child, unresolved promise), the latch stays set FOREVER and the watch silently
// stops: alive at 0% CPU, ledger untouched, board frozen. v60: `finally` guarantees the
// reset on throw, and a watchdog abandons any tick stuck >2min so polling resumes on its
// own (worst case the abandoned tick later completes into a redundant render — harmless).
// --- v107: --until-idle — auto-start/stop lifecycle. Launched when a CR lands (e.g. via
// orch/board.command); runs the board while work exists, and when EVERY CR is CLOSED (and
// it actually did work this run) it prints the consumption report(s) for the CR(s) it
// worked and exits. It never exits while a CR is mid-build or parked at a human gate
// (DEPLOY_WAIT/ESCALATED are non-CLOSED, so the board stays up and waits). Cold start with
// nothing open just waits for the first CR to land. ---
const UNTIL_IDLE = process.argv.includes("--until-idle");
let sawOpenCR = false;
const openSeen = new Set();
function crStatusList(){
  let files=[]; try{ files=fs.readdirSync(CR_DIR).filter(f=>/^CR-\d+\.md$/.test(f)); }catch{ return []; }
  return files.map(f=>{ let s="?"; try{ const m=fs.readFileSync(path.join(CR_DIR,f),"utf8").match(/\*\*Status:\*\*\s*([A-Z_]+)/); if(m) s=m[1]; }catch{} return { f, id:f.replace(/\.md$/,""), status:s }; });
}
function maybeExitWhenIdle(){
  if (!UNTIL_IDLE) return;
  const list = crStatusList();
  const open = list.filter(c => c.status !== "CLOSED");
  for (const c of open){ openSeen.add(c.id); sawOpenCR = true; }
  if (open.length) return;                 // still building, or parked at a human gate → keep the board up
  if (!sawOpenCR) return;                   // launched cold; wait for a CR to land
  banner("All CRs closed — pipeline idle. Report(s) for this run below, then stopping.", C.green);
  for (const id of openSeen){
    try {
      const g = readGates(path.join(CR_DIR, id + ".md"));
      const idx = g.lastIndexOf("## Consumption Report");
      if (idx >= 0) console.log(`\n${C.bold}${id}${C.reset}\n` + g.slice(idx));
    } catch { /* */ }
  }
  log(`${C.dim}--until-idle: work complete; watch stopping.${C.reset}`);
  process.exit(0);
}

let running=false, tickStart=0;
setInterval(async ()=>{
  if (running){
    if (tickStart && Date.now()-tickStart > 120000){
      log(`${C.red}watchdog: tick wedged ${Math.round((Date.now()-tickStart)/1000)}s — abandoning it, polling resumes${C.reset}`);
      running=false; tickStart=0;
    }
    return;
  }
  // HOT-RELOAD (idle only): when orchestrator.cjs changes on disk, the watch replaces
  // itself IN THE SAME TERMINAL — no more manual kill+relaunch after every engine
  // upgrade (the repeated "zsh: terminated" the operator saw was exactly that chore).
  // v97: compare BYTES, not the version string. Reloading only on a version bump meant an
  // edit that forgot to bump it kept running the old code while the file on disk said
  // otherwise — the board then described behaviour it wasn't executing. Two guards keep
  // byte-triggered reload safe: the new file must PARSE (a half-written save would crash the
  // watch), and no gate may be mid-flight (an agent's rules must not change under it).
  try {
    const disk = fs.readFileSync(__filename);
    if (Buffer.compare(disk, SELF_BYTES) !== 0){
      const onDisk = (disk.toString("utf8").match(/ORCH_VERSION = "([^"]+)"/) || [])[1] || "?";
      if (spawnSync(process.execPath, ["--check", __filename], { stdio:"pipe" }).status !== 0){
        suOnce("selfparse", "orch changed on disk but does not parse yet (mid-save?) — still running " + ORCH_VERSION, C.dim);
      } else {
        suSaid.delete("selfparse");
        const busy = suGateInFlight();
        if (busy){
          suOnce("selfbusy:"+onDisk, "orch changed on disk (" + onDisk + ") — hot-reload held until the board is quiet (" + busy + " is mid-gate)", C.cyan);
        } else {
          log(`${C.green}${C.bold}orch updated on disk (${onDisk}) — hot-reloading in place…${C.reset}`);
          const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: "inherit" }); // v107: preserve flags (e.g. --until-idle)
          process.exit(r.status || 0);
        }
      }
    }
  } catch { /* unreadable self? keep running current version */ }
  // Follow the kit repo on the configured interval (opt-in). The apply path itself
  // re-execs this process via the hot-reload above, so nothing here needs to restart.
  if (SU.enabled && Date.now() >= suNextCheck){
    suNextCheck = Date.now() + Math.max(5, Number(SU.checkEveryMin)||60) * 60000;
    try { suCheck({}); } catch(e){ log(C.dim + "self-update check failed: " + e.message + C.reset); }
  }
  running=true; tickStart=Date.now();
  try { await tick(); } catch(e){ log(`${C.red}tick error: ${e.message}${C.reset}`); }
  finally { running=false; tickStart=0; }
  maybeExitWhenIdle();   // v107: --until-idle auto-stop (prints report(s), then exits)
}, POLL_MS);

// v107: ALWAYS-ON HEARTBEAT — a ticking spinner + live clock + the ACTIVE STEP (who owns it,
// what they're doing, and a per-step elapsed timer) so the board is visibly LIVE at every
// step — working / reviewing / revising / waiting-on-you (owner request). TTY only.
function _fmtE(ms){ if(ms==null) return ""; const s=Math.floor(ms/1000); if(s>=3600) return ` ${Math.floor(s/3600)}h${Math.floor(s%3600/60)}m`; if(s>=60) return ` ${Math.floor(s/60)}m${s%60}s`; return ` ${s}s`; }
function activeStepInfo(active){
  const crPath = path.join(CR_DIR, active.id + ".md");
  const status = active.status;
  let sinceMs=null, log=[];
  try { log = fs.readFileSync(path.join(LOG_DIR, active.id + ".jsonl"),"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); } catch {}
  const lastTo = [...log].reverse().find(e=>e.type==="status" && e.to===status);
  if (lastTo) sinceMs = Date.now() - new Date(lastTo.ts).getTime();
  if (status==="ESCALATED") return { who:"you", verb:"decision needed", gate:"", sinceMs };
  if (status==="DEPLOY_WAIT"||status==="FAST_DEPLOY") return { who:"you", verb:"deploy + paste output", gate:"", sinceMs };
  const stage = PIPELINE.find(s=>s.status===status);
  let who="orch", gate=status;
  if (stage && stage.gates && stage.gates.length){ const g = stage.gates.find(g2=>!gateDone(crPath, g2.gate)) || stage.gates[stage.gates.length-1]; if(g){ who=g.agent; gate=g.gate; } }
  // TRUTHFUL verb: only "working/reviewing/revising" once the gate has actually BEGUN (a
  // begin marker with no verdict yet). A gate NOT begun is QUEUED — waiting for its owner's
  // session to pick it up (a Claude gate stalls between sessions; codex.auto starts shortly).
  // Never show "working" for a step nobody has started (the "claude working 59m" confusion).
  const begun = runStartedAt(crPath, gate);
  let elapsed = sinceMs, verb;
  if (begun) {
    elapsed = Date.now() - new Date(begun).getTime();
    const failedThisScope = /verdict":"(FAIL|REJECT)/.test(readGates(crPath).split(/### (?:Build retry|Owner decision|Revision)/).pop()||"");
    verb = who==="codex" ? "reviewing" : (/build/i.test(gate) && failedThisScope ? "revising" : "working");
  } else {
    verb = who==="claude" ? "QUEUED · awaiting Claude — needs pickup" : who==="codex" ? "queued · auto-review starting" : "queued";
  }
  return { who, verb, gate, sinceMs: elapsed };
}
if (process.stdout.isTTY) {
  const HB = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let hb = 0;
  setInterval(() => {
    let line;
    try {
      const list = crStatusList();
      const active = list.find(c => c.status !== "CLOSED");
      if (!active) line = list.length ? "all CRs closed — stopping shortly" : "no CRs — waiting for one to land";
      else { const s = activeStepInfo(active); line = `${active.id} · ${s.who} ${s.verb}${s.gate?` ${s.gate}`:""}${_fmtE(s.sinceMs)}`; }
    } catch { line = "watching"; }
    const clock = new Date().toTimeString().slice(0, 8);
    process.stdout.write(`\r${C.dim}${HB[hb++ % HB.length]} ${clock} · ${C.reset}${C.cyan}${line}${C.reset}\x1b[K`);
  }, 1000);
}

