/**
 * FeedbackButtons — a shared 👍 / 👎 row for any Brain-produced surface.
 *
 * Props:
 *   subjectType — 'chat_answer' | 'brain_action' | 'draft' | 'observation' |
 *                 'attention_card' | 'criticality_score' | 'other'
 *   subjectId   — stable id of the rated thing
 *   context     — optional snapshot of what Brain showed (helps diagnosis)
 *   onRated     — optional callback once the rating is posted
 *   onRetry     — optional callback (only meaningful for subjectType='chat_answer')
 *                 invoked with { diagnosis, question, originalAnswer, sources }
 *                 when the user clicks "Try again" on a high-confidence
 *                 diagnosis. Parent (BrainChatPanel) is expected to call
 *                 POST /brain/retry and append the retry as a new message.
 *   compact     — if true, render small inline buttons (default)
 *
 * Behaviour:
 *   - Click 👍 → fires POST /brain/feedback with rating='up'. No extra prompt.
 *   - Click 👎 → shows an inline "why?" textbox + quick-pick chips. On
 *     submit, fires with rating='down'. For chat_answer, the server runs
 *     diagnosis SYNCHRONOUSLY and returns the category + likelyFix. If
 *     confidence ≥ 0.6 the buttons offer "Try again" which calls onRetry.
 *     Lower confidence: shows the diagnosis but no retry button.
 *
 * Keeps the rendering honest: no fake "saved ✓" before the server replies.
 */
import { useState, useCallback } from 'react';
import api from '../services/api';

const QUICK_PICKS = [
  { label: 'Wrong person', val: 'wrong person — used the wrong subject scope' },
  { label: 'Missed timeframe', val: 'missed the timeframe / out of date' },
  { label: 'Wrong source', val: 'pulled from the wrong source' },
  { label: 'Too vague', val: 'too vague / didn\'t answer the actual question' },
];
const RETRY_CONFIDENCE_FLOOR = 0.6;

export default function FeedbackButtons({
  subjectType,
  subjectId,
  context = null,
  onRated = null,
  onRetry = null,
  compact = true,
}) {
  const [state, setState] = useState('idle');   // idle | asking-reason | submitting | done-up | done-down | retrying
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [diagnosis, setDiagnosis] = useState(null);  // { category, hypothesis, likelyFix, confidence, ... }

  const send = useCallback(async (rating, providedReason = null) => {
    setState('submitting');
    setError(null);
    try {
      const r = await api.post('/brain/feedback', {
        subjectType, subjectId, rating,
        reason: providedReason,
        context,
      });
      // Phase 1 Self-Learning — also record into the governance feed.
      // Parallel POST (non-blocking). Maps the legacy {rating, reason}
      // shape into the learning feedback_type taxonomy. Failure here
      // never breaks the user-facing feedback flow.
      void api.post('/learning/feedback', {
        interactionId: context?.interactionId ?? null,
        feedbackType: rating === 'up' ? 'helpful' : (providedReason || 'incorrect'),
        feedbackComment: providedReason ?? null,
      }).catch(() => {});
      // Server returns diagnosis only for chat_answer 👎 (sync diagnosis)
      const diag = r?.data?.diagnosis ?? null;
      if (rating === 'down' && diag) setDiagnosis(diag);
      setState(rating === 'up' ? 'done-up' : 'done-down');
      onRated?.(rating, providedReason);
    } catch (err) {
      setError(err?.response?.data?.error ?? 'Could not save feedback');
      setState('idle');
    }
  }, [subjectType, subjectId, context, onRated]);

  const tryAgain = useCallback(() => {
    if (!onRetry || !diagnosis) return;
    setState('retrying');
    onRetry({
      diagnosis,
      question: context?.question ?? '',
      originalAnswer: context?.answer ?? '',
      sources: context?.sources ?? [],
    });
  }, [onRetry, diagnosis, context]);

  const size = compact ? 14 : 18;

  if (state === 'done-up') {
    return (
      <div style={wrap(compact)}>
        <span style={{ fontSize: size - 2, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          👍 Noted
        </span>
      </div>
    );
  }
  if (state === 'done-down') {
    // Three render branches:
    //   (a) chat_answer with high-confidence diagnosis → show category +
    //       likelyFix + Try Again button (only if onRetry provided)
    //   (b) chat_answer with low-confidence diagnosis → show "couldn't
    //       categorise the miss — feedback saved" (no retry)
    //   (c) other surfaces (no sync diagnosis returned) → original
    //       "thanks, diagnosing" message
    if (subjectType === 'chat_answer' && diagnosis) {
      const conf = Number(diagnosis.confidence ?? 0);
      const offerRetry = onRetry && conf >= RETRY_CONFIDENCE_FLOOR;
      return (
        <div style={{
          ...wrap(compact), flexDirection: 'column', alignItems: 'stretch', gap: 6,
          padding: '8px 10px',
          background: 'rgba(99,102,241,0.08)',
          border: '1px solid rgba(99,102,241,0.3)',
          borderRadius: 6,
        }}>
          <div style={{ fontSize: size - 2, color: 'var(--text)', fontWeight: 600 }}>
            👎 Thanks — Brain caught the miss
            <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 6 }}>
              ({diagnosis.category}, conf {conf.toFixed(2)})
            </span>
          </div>
          {diagnosis.likelyFix && (
            <div style={{ fontSize: size - 3, color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {diagnosis.likelyFix}
            </div>
          )}
          {offerRetry ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={tryAgain} style={btn('primary', compact)}>
                ↻ Try again with the fix
              </button>
              <button type="button" onClick={() => setState('done-down-final')} style={btn('ghost', compact)}>
                Leave it
              </button>
            </div>
          ) : (
            <div style={{ fontSize: size - 3, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              {conf < RETRY_CONFIDENCE_FLOOR
                ? 'Confidence too low to auto-retry — saved for the weekly rollup.'
                : 'Saved.'}
            </div>
          )}
        </div>
      );
    }
    return (
      <div style={wrap(compact)}>
        <span style={{ fontSize: size - 2, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          👎 Thanks — Brain is diagnosing why this missed.
        </span>
      </div>
    );
  }
  if (state === 'done-down-final') {
    return (
      <div style={wrap(compact)}>
        <span style={{ fontSize: size - 2, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          👎 Saved.
        </span>
      </div>
    );
  }
  if (state === 'retrying') {
    return (
      <div style={wrap(compact)}>
        <span style={{ fontSize: size - 2, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          ↻ Re-running with the diagnosis…
        </span>
      </div>
    );
  }
  if (state === 'asking-reason') {
    return (
      <div style={{ ...wrap(compact), flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div style={{ fontSize: size - 2, color: 'var(--text-muted)' }}>
          What was off? (helps Brain learn — pick one or write it)
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {QUICK_PICKS.map((qp) => (
            <button
              key={qp.label}
              type="button"
              onClick={() => send('down', qp.val)}
              style={btn('chip', compact)}
            >
              {qp.label}
            </button>
          ))}
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 600))}
          placeholder="…or describe in your own words: too formal, outdated, missed the meeting context…"
          rows={2}
          style={{
            fontSize: size - 1, padding: '6px 8px',
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 6, color: 'var(--text)', resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={() => send('down', reason.trim() || null)}
            style={btn('primary', compact)}
          >
            Send 👎
          </button>
          <button
            type="button"
            onClick={() => { setState('idle'); setReason(''); }}
            style={btn('ghost', compact)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // idle / submitting / error
  return (
    <div style={wrap(compact)}>
      <span style={{ fontSize: size - 3, color: 'var(--text-muted)', marginRight: 2 }}>
        Was this useful?
      </span>
      <button
        type="button"
        title="Thumbs up"
        aria-label="Rate thumbs up"
        disabled={state === 'submitting'}
        onClick={() => send('up')}
        style={iconBtn(compact)}
      >
        👍
      </button>
      <button
        type="button"
        title="Thumbs down"
        aria-label="Rate thumbs down"
        disabled={state === 'submitting'}
        onClick={() => setState('asking-reason')}
        style={iconBtn(compact)}
      >
        👎
      </button>
      {state === 'submitting' && (
        <span style={{ fontSize: size - 3, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          saving…
        </span>
      )}
      {error && (
        <span style={{ fontSize: size - 3, color: '#f87171' }}>{error}</span>
      )}
    </div>
  );
}

function wrap(compact) {
  return {
    display: 'flex', alignItems: 'center', gap: 4,
    marginTop: compact ? 6 : 10,
  };
}

function iconBtn(compact) {
  return {
    border: '1px solid transparent',
    background: 'transparent',
    cursor: 'pointer',
    padding: compact ? '2px 6px' : '4px 8px',
    fontSize: compact ? 14 : 16,
    borderRadius: 6,
    lineHeight: 1,
    transition: 'background 160ms ease, border-color 160ms ease',
  };
}

function btn(variant, compact) {
  const base = {
    fontSize: compact ? 11 : 12,
    padding: compact ? '4px 10px' : '6px 12px',
    border: '1px solid',
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: 600,
  };
  if (variant === 'primary') {
    return { ...base, background: 'rgba(99,102,241,0.15)', borderColor: 'rgba(99,102,241,0.5)', color: '#c7d2fe' };
  }
  if (variant === 'chip') {
    return { ...base, fontSize: compact ? 10 : 11, padding: compact ? '3px 8px' : '4px 10px',
      background: 'rgba(255,255,255,0.04)', borderColor: 'var(--border)', color: 'var(--text)', fontWeight: 500 };
  }
  return { ...base, background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-muted)' };
}
