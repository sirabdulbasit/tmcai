/**
 * Unified LLM call with automatic fallback.
 *
 * Default order: Gemini → Gemini Flash → Claude. Gemini is the primary
 * because it's the provider we have billing set up for. Claude is a
 * fallback that only kicks in if Gemini is down AND Anthropic credits are
 * available. No Anthropic credit means no effect on the system — the
 * router never calls Claude unless Gemini has failed.
 *
 *     const answer = await callLLM(systemPrompt, userMessage, { maxTokens: 512 });
 */
import { callClaude } from './claudeService';
import { callGemini } from './geminiService';
import { recordLlmSpend } from './llmSpendService';
import createLogger from '../utils/logger';

const log = createLogger('llm-router');

export type LlmProvider = 'claude' | 'gemini' | 'gemini-flash';

export interface CallLlmResult {
  text: string;
  provider: LlmProvider;
}

export interface CallLlmOpts {
  maxTokens?: number;
  /** Tokens the model may spend REASONING before answering (Gemini Pro only; Flash accepts
   *  only 0, Claude ignores it). Additive to maxTokens, so raising it never shortens the
   *  reply. Owner ruling, 2026-08-19: "LLM should be thinking model of brain" — the
   *  conversational path sets this; classifiers deliberately do not, because thinking tokens
   *  are billed and `triage` alone makes 58k Pro calls a fortnight. */
  thinkingBudget?: number;
  /** Preferred order. Default: ['gemini', 'gemini-flash', 'claude']. */
  providers?: LlmProvider[];
  /** Hard timeout per provider attempt (ms). Default 15000. */
  timeoutMs?: number;
  /** Which user / tenant this call is on behalf of — used for spend
   *  tracking. Leave undefined for system-level calls. */
  userId?: number;
  clientNumber?: string;
  /** Free-text label for analytics ('triage', 'chat', 'scribe', etc.) */
  purpose?: string;
  /** Which feed event this call was made ABOUT, when there is one.
   *
   *  `llm_spend.feed_event_id` has existed since the table was created and was
   *  NULL on all 2.6M rows: every call site passed `purpose` and none passed
   *  this. The consequence was not cosmetic — spend could be grouped by purpose
   *  but never traced to a source event, so "this optimisation removed N calls
   *  for event X" was unprovable and every cost claim had to be asserted rather
   *  than shown. Populated so a saving can be MEASURED per event. */
  feedEventId?: string | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const BACKOFF_MS = 1_000;

// ── DEF-334 (2)/(3) — a full provider outage is BOUNDED in the log and ────────
//    ANNOUNCED once, instead of 2,500 silent flood-lines an hour.
//
// Measured twice while unannounced: the 2026-09-29→10-09 billing outage ran
// ~2,500 failures/hour for DAYS (51 MB of log every ~6 h — the owner's own
// DEF-334 report) with zero owner receipts; the 10-16 compound outage (gemini
// DNS + claude credit-balance) drove 50 silent fallbacks the same way. The
// router is the ONE chokepoint every provider failure passes through, so both
// bounds live here — no call site needs to remember anything.

/** Consecutive all-provider failures before the outage is announced. One
 *  failure is a blip a retry absorbs; three in a row is an outage. */
export const OUTAGE_THRESHOLD = 3;
/** The announcement repeats at most once per this window while the outage
 *  persists (mirrors DEF-329's OUTAGE_REALERT_MS — one alarm per day, not a
 *  flood about a flood). */
export const OUTAGE_REALERT_MS = 24 * 60 * 60 * 1000;
/** DEF-334 (2): per-provider error detail is truncated to this many chars in
 *  the THROWN message. Callers log the thrown message once per call (~2,500/h
 *  during an outage), so the full provider bodies — the 403/credit-balance
 *  JSON that turned 2,500 lines into 51 MB — flood through every caller's log
 *  unless the error itself is bounded. The full bodies are still logged, by
 *  the router, once per FULL_ERROR_LOG_WINDOW_MS. */
export const ERROR_HEAD_CHARS = 160;
export const FULL_ERROR_LOG_WINDOW_MS = 60 * 60 * 1000;

export interface LlmOutageReport {
  consecutiveFailures: number;
  firstFailureAt: number;
  /** Full, untruncated provider errors from the call that tripped the latch. */
  errors: string[];
  purpose?: string;
}

/**
 * Who announces the outage. INJECTED, never imported — same separation as
 * `rawQueryObservability` (DEF-085) and for the same reason: this module is in
 * the import closure of ~every script, including the write-free operator
 * tier, so the router stays pure (count + log) and the long-running server
 * injects the writer at boot (`services/selfheal/llmOutageReporter`). A
 * one-shot script gets the bounded log line and writes nothing.
 */
export type LlmOutageReporter = (report: LlmOutageReport) => Promise<void>;
let outageReporter: LlmOutageReporter | null = null;
export function setLlmOutageReporter(fn: LlmOutageReporter | null): void {
  outageReporter = fn;
}

/** DEF-340 — the recovery half of the outage receipt. Fired once, on the
 *  first success after an ANNOUNCED outage (never on a sub-threshold blip),
 *  so the open `llm_provider_down` finding can be resolved instead of
 *  outliving the outage it describes. Injected for the same write-free
 *  reason as the outage reporter above. */
export interface LlmRecoveryReport {
  afterConsecutiveFailures: number;
  firstFailureAt: number;
  darkForMs: number;
}
export type LlmRecoveryReporter = (report: LlmRecoveryReport) => Promise<void>;
let recoveryReporter: LlmRecoveryReporter | null = null;
export function setLlmRecoveryReporter(fn: LlmRecoveryReporter | null): void {
  recoveryReporter = fn;
}

const outage = { consecutive: 0, firstAt: 0, lastAlertAt: 0, lastFullLogAt: 0 };

/** Test seam — the latch is process-global. */
export function __resetLlmOutageLatch(): void {
  outage.consecutive = 0; outage.firstAt = 0; outage.lastAlertAt = 0; outage.lastFullLogAt = 0;
}

function errorHead(message: string): string {
  const m = String(message ?? '');
  return m.length > ERROR_HEAD_CHARS ? `${m.slice(0, ERROR_HEAD_CHARS)}…` : m;
}

/** 429 detection — Gemini/Anthropic errors vary, so we match broadly. */
function isRateLimited(err: any): boolean {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('too many requests');
}

/** Abortable wrapper — resolves either with text or throws 'timeout'. */
async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callProvider(
  provider: LlmProvider,
  systemPrompt: string,
  userMessage: string,
  maxTokens?: number,
  thinkingBudget?: number,
): Promise<string> {
  switch (provider) {
    case 'claude':
      return await callClaude(systemPrompt, userMessage, { maxTokens });
    case 'gemini':
      return await callGemini(systemPrompt, userMessage, { maxTokens, thinkingBudget });
    case 'gemini-flash':
      return await callGemini(systemPrompt, userMessage, { maxTokens, flash: true });
  }
}

/** Rough token estimator when the provider doesn't return usage —
 *  ~4 chars/token is the industry heuristic for English prompts. */
function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  opts?: CallLlmOpts,
): Promise<CallLlmResult> {
  const order = opts?.providers ?? ['gemini', 'gemini-flash', 'claude'];
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const errors: string[] = [];      // heads only — this array becomes the thrown message
  const fullErrors: string[] = [];  // complete bodies — logged once per window, carried in the outage report
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userMessage);

  for (const provider of order) {
    // Up to 2 attempts per provider — retry ONCE on 429 with backoff.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await withTimeout(
          () => callProvider(provider, systemPrompt, userMessage, opts?.maxTokens,
                                 opts?.thinkingBudget),
          timeoutMs,
        );
        if (text && text.trim().length > 0) {
          const outputTokens = estimateTokens(text);
          // Fire-and-forget spend record
          void recordLlmSpend({
            provider, userId: opts?.userId, clientNumber: opts?.clientNumber,
            purpose: opts?.purpose ?? 'unknown',
            feedEventId: opts?.feedEventId ?? null,
            inputTokens, outputTokens,
          }).catch(() => {});
          // Prod fix 2026-07-10: LLM output truncated at maxTokens can
          // end in a lone surrogate (half an emoji). Every downstream
          // consumer slices/persists this text; sanitizing HERE — the
          // single chokepoint all providers return through — guarantees
          // valid UTF-8 for every DB write (PG error 22021 class).
          const { sanitizeUtf8 } = await import('../utils/utf8');
          // Recovery closes the outage latch. Logged so the dark window has a
          // visible END as well as a start — "how long was Brain on fallbacks"
          // must be answerable from the log alone.
          if (outage.consecutive >= OUTAGE_THRESHOLD) {
            const recovery: LlmRecoveryReport = {
              afterConsecutiveFailures: outage.consecutive,
              firstFailureAt: outage.firstAt,
              darkForMs: Date.now() - outage.firstAt,
            };
            log.info('llm providers recovered', {
              afterConsecutiveFailures: recovery.afterConsecutiveFailures,
              darkForMs: recovery.darkForMs,
            });
            // DEF-340: an announced death must announce its END too. Re-arm
            // the realert window BEFORE the async resolve — a NEW outage
            // after this recovery alerts at its own threshold instead of
            // waiting out the 24h cap (safe only because the open finding is
            // being resolved; while it stayed open, the un-reset window was
            // covered by the finding itself).
            outage.lastAlertAt = 0;
            if (recoveryReporter) {
              void recoveryReporter(recovery).catch((e: any) => {
                log.warn('llm recovery resolution failed', { error: String(e?.message ?? e).slice(0, 200) });
              });
            }
          }
          outage.consecutive = 0;
          outage.firstAt = 0;
          return { text: sanitizeUtf8(text), provider };
        }
        errors.push(`${provider}[try${attempt + 1}]: empty response`);
        fullErrors.push(`${provider}[try${attempt + 1}]: empty response`);
        break; // empty response, move to next provider
      } catch (err: any) {
        const rateLimited = isRateLimited(err);
        if (rateLimited && attempt === 0) {
          // Back off once, retry same provider
          errors.push(`${provider}[try${attempt + 1}]: rate-limited, backing off ${BACKOFF_MS}ms`);
          fullErrors.push(`${provider}[try${attempt + 1}]: rate-limited, backing off ${BACKOFF_MS}ms`);
          await new Promise((r) => setTimeout(r, BACKOFF_MS));
          continue;
        }
        errors.push(`${provider}[try${attempt + 1}]: ${errorHead(err.message)}`);
        fullErrors.push(`${provider}[try${attempt + 1}]: ${err.message}`);
        break;
      }
    }
  }

  // ── DEF-334 (2)/(3): bound the flood, announce the outage ─────────────────
  const now = Date.now();
  if (outage.consecutive === 0) outage.firstAt = now;
  outage.consecutive += 1;

  // The FULL provider bodies, once per window — every caller's per-call log
  // carries only the heads (via the thrown message below), so no outage can
  // turn the log into megabytes again, and the complete diagnostic is still
  // on the record here.
  if (now - outage.lastFullLogAt > FULL_ERROR_LOG_WINDOW_MS) {
    outage.lastFullLogAt = now;
    log.error('all llm providers failed — full provider errors (logged once per window)', {
      consecutiveFailures: outage.consecutive,
      purpose: opts?.purpose,
      errors: fullErrors,
    });
  }

  // The announcement: fire-and-forget, at most once per OUTAGE_REALERT_MS,
  // never on the caller's critical path, never able to turn this throw into
  // a different failure. `lastAlertAt` is set synchronously BEFORE the await
  // so the ~2,500 concurrent failures/hour of a real outage cannot double-fire.
  if (
    outage.consecutive >= OUTAGE_THRESHOLD &&
    outageReporter &&
    now - outage.lastAlertAt > OUTAGE_REALERT_MS
  ) {
    outage.lastAlertAt = now;
    void outageReporter({
      consecutiveFailures: outage.consecutive,
      firstFailureAt: outage.firstAt,
      errors: fullErrors,
      purpose: opts?.purpose,
    }).catch((e: any) => {
      log.warn('llm outage announcement failed', { error: String(e?.message ?? e).slice(0, 200) });
    });
  }

  throw new Error(`All LLM providers failed: ${errors.join(' | ')}`);
}
