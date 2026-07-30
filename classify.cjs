#!/usr/bin/env node
/*
 classify.cjs — independent, deterministic CR classifier (zero tokens).
 Decides FAST (bypass team) vs TEAM (full review) based on WHAT FILES a CR
 touches, NOT on anyone's opinion. The builder never gets the final vote.

 Rule:
   - touches ONLY cosmetic files (.css/.scss, .md, image assets, or pure
     display-string edits) -> FAST
   - touches ANY logic/data/contract file (.js/.ts/.jsx/.sql, routes, auth,
     migrations, config, package.json) -> TEAM
   - unsure / can't tell -> TEAM (safe default)

 Usage: node classify.cjs <changed-files.txt>
        or pipe `git diff --name-only` into it.
*/
const fs = require("fs");

function readFiles(){
  const arg = process.argv[2];
  let raw = "";
  if (arg && fs.existsSync(arg)) raw = fs.readFileSync(arg, "utf8");
  else { try { raw = fs.readFileSync(0, "utf8"); } catch { raw = ""; } } // stdin
  return raw.split("\n").map(s=>s.trim()).filter(Boolean);
}

// Files that are safe-cosmetic. Everything else is treated as substantive.
const COSMETIC = [
  /\.css$/i, /\.scss$/i, /\.less$/i,
  /\.md$/i, /\.txt$/i,
  /\.(png|jpg|jpeg|gif|svg|webp|ico)$/i,
];
// Files that ALWAYS force TEAM even if they look small.
const SUBSTANTIVE = [
  /\.jsx?$/i, /\.tsx?$/i, /\.mjs$/i, /\.cjs$/i,
  /\.sql$/i, /migrat/i,
  /route/i, /auth/i, /middleware/i,
  /\.env/i, /config/i,
  /package(-lock)?\.json$/i, /\.ya?ml$/i,
  /server\//i, /api\//i,
];

function classify(files){
  if (!files.length) return { tier: "TEAM", reason: "no file list provided — cannot prove trivial, defaulting to full review" };
  const substantive = files.filter(f => SUBSTANTIVE.some(re=>re.test(f)));
  if (substantive.length)
    return { tier: "TEAM", reason: `touches substantive files: ${substantive.slice(0,5).join(", ")}${substantive.length>5?" …":""}` };
  const allCosmetic = files.every(f => COSMETIC.some(re=>re.test(f)));
  if (allCosmetic)
    return { tier: "FAST", reason: `only cosmetic files (${files.join(", ")})` };
  const unknown = files.filter(f => !COSMETIC.some(re=>re.test(f)));
  return { tier: "TEAM", reason: `unrecognized file types, defaulting to full review: ${unknown.slice(0,5).join(", ")}` };
}

const files = readFiles();
const r = classify(files);
console.log(JSON.stringify(r, null, 2));
process.exit(r.tier === "FAST" ? 0 : 1);   // exit 0 = FAST, 1 = TEAM (scriptable)
