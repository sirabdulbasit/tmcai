/*
 * claude-usage.cjs — measure REAL Claude Code token consumption for a time window,
 * from the session transcripts Claude Code itself writes. Never estimates: returns
 * null when the transcript cannot be found/parsed, because a missing measurement is
 * strictly better than a confident fabrication (v104, replaces self-reported tokens).
 *
 * VERIFIED EMPIRICALLY on 2026-07-29 against this project's live transcripts:
 *   PATH   ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl
 *          slug = cwd with every non-alphanumeric run replaced by '-'
 *          (e.g. /Users/tmc/SRA -> -Users-tmc-SRA)
 *   ENTRY  one JSON object per line; usage lives on entries with
 *          type === "assistant" and message.usage present:
 *            timestamp                              ISO-8601 (top level)
 *            message.id                             "msg_..." — NOT unique per line
 *            message.model                          e.g. "claude-fable-5"
 *            message.usage.input_tokens
 *            message.usage.output_tokens
 *            message.usage.cache_read_input_tokens
 *            message.usage.cache_creation_input_tokens
 *   DEDUP  parallel tool calls emit MULTIPLE assistant lines sharing one message.id
 *          with byte-identical usage (measured: 2435 lines -> 1348 unique ids, 712
 *          duplicated, ZERO with differing usage). Counting every line inflates the
 *          total by ~80% — dedup by message.id is mandatory, first occurrence wins.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// TEQ (token-equivalents): normalise the four counters to input-token cost using
// Opus 5 price ratios ($5 in / $25 out / $0.50 cache read / 1h cache write at 2x in —
// Max subscriptions get the 1h TTL automatically). One comparable scalar; the raw
// counters are always carried alongside, never replaced.
const TEQ_RATIO = { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 2.0 };
const teqOf = (c) => c.input * TEQ_RATIO.input + c.output * TEQ_RATIO.output
    + c.cacheRead * TEQ_RATIO.cacheRead + c.cacheWrite * TEQ_RATIO.cacheWrite;

function transcriptDir(cwd) {
    const slug = String(cwd || process.cwd()).replace(/[^a-zA-Z0-9]+/g, '-');
    return path.join(os.homedir(), '.claude', 'projects', slug);
}

// ---- incremental per-file cache -------------------------------------------------
// The live board polls repeatedly; a 17MB session file must not be re-parsed every
// call. Cache parsed usage events + the byte offset per file and parse only appended
// bytes on subsequent calls. A shrunken file (rotation) resets its cache entry.
//   file -> { offset, tail: '' (partial last line), events: [{ts, id, model, c:{...}}] }
const _cache = new Map();

function _parseAppended(file) {
    let st;
    try { st = fs.statSync(file); } catch { _cache.delete(file); return null; }
    let entry = _cache.get(file);
    if (!entry || st.size < entry.offset) entry = { offset: 0, tail: '', events: [] };
    if (st.size > entry.offset) {
        const fd = fs.openSync(file, 'r');
        try {
            const len = st.size - entry.offset;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, entry.offset);
            entry.offset = st.size;
            const chunk = entry.tail + buf.toString('utf8');
            const lines = chunk.split('\n');
            entry.tail = lines.pop() || '';           // last piece may be a partial line
            for (const line of lines) {
                if (!line || line.charCodeAt(0) !== 123 /* '{' */) continue;
                if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
                let e;
                try { e = JSON.parse(line); } catch { continue; }
                if (e.type !== 'assistant' || !e.message || !e.message.usage || !e.timestamp) continue;
                const u = e.message.usage;
                entry.events.push({
                    ts: Date.parse(e.timestamp),
                    id: e.message.id || null,
                    model: e.message.model || 'unknown',
                    c: {
                        input: u.input_tokens || 0,
                        output: u.output_tokens || 0,
                        cacheRead: u.cache_read_input_tokens || 0,
                        cacheWrite: u.cache_creation_input_tokens || 0,
                    },
                });
            }
        } finally { fs.closeSync(fd); }
    }
    _cache.set(file, entry);
    return entry;
}

/**
 * Measure real Claude usage between two instants for THIS project's sessions.
 * @returns {{byModel: Object, total: Object, teq: number, byModelTeq: Object,
 *            messages: number, measured: true} | null}
 * null on ANY failure — never an estimate.
 */
function measureWindow(startISO, endISO, cwd) {
    try {
        const start = Date.parse(startISO), end = Date.parse(endISO || new Date().toISOString());
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
        const dir = transcriptDir(cwd);
        let files;
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
        if (!files.length) return null;

        const byModel = {};
        const seen = new Set();          // dedup by message.id ACROSS files
        let messages = 0;
        for (const f of files) {
            const full = path.join(dir, f);
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            // a file whose last write predates the window start cannot contain window
            // events (timestamps are append-ordered) — but files already cached are
            // cheap, so the mtime gate only skips never-read cold files.
            if (!_cache.has(full) && st.mtimeMs < start) continue;
            const entry = _parseAppended(full);
            if (!entry) continue;
            for (const ev of entry.events) {
                if (ev.ts < start || ev.ts > end) continue;
                const key = ev.id || `${f}:${ev.ts}:${ev.c.output}`;
                if (seen.has(key)) continue;
                seen.add(key);
                messages++;
                const m = (byModel[ev.model] = byModel[ev.model] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
                m.input += ev.c.input; m.output += ev.c.output;
                m.cacheRead += ev.c.cacheRead; m.cacheWrite += ev.c.cacheWrite;
                m.messages++;
            }
        }
        if (!messages) return null;      // nothing in window = no measurement, not zero
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const byModelTeq = {};
        for (const [model, c] of Object.entries(byModel)) {
            total.input += c.input; total.output += c.output;
            total.cacheRead += c.cacheRead; total.cacheWrite += c.cacheWrite;
            byModelTeq[model] = Math.round(teqOf(c));
        }
        return { byModel, byModelTeq, total, teq: Math.round(teqOf(total)), messages, measured: true };
    } catch { return null; }
}

// human formatting shared by record/board/report
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
    : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);

module.exports = { measureWindow, teqOf, TEQ_RATIO, fmtTok, transcriptDir };
