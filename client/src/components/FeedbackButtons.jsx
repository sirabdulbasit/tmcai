/**
 * FeedbackButtons — a shared 👍 / 👎 row for any Brain-produced surface.
 *
 * Props:
 *   subjectType — 'chat_answer' | 'brain_action' | 'draft' | 'observation' |
 *                 'attention_card' | 'criticality_score' | 'other'
 *   subjectId   — stable id of the rated thing
 *   context     — optional snapshot of what Brain showed (helps diagnosis)
 *   onRated     — optional callback once the rating is posted
 *   compact     — if true, render small inline buttons (default)
 *
 * Behaviour:
 *   - Click 👍 → fires POST /brain/feedback with rating='up'. No extra prompt.
 *   - Click 👎 → shows an inline "why?" textbox (optional), then fires with
 *     rating='down' and the reason. Server side, this triggers an LLM
 *     diagnosis run that files a feedback_diagnosis wiki page.
 *   - After submission, the buttons show a quiet confirmation ("Thanks,
 *     Brain's looking into it" for 👎 / "Noted ✓" for 👍) and disable.
 *
 * Keeps the rendering honest: no fake "saved ✓" before the server replies.
 */
import { useState, useCallback } from 'react';
import api from '../services/api';

export default function FeedbackButtons({
  subjectType,
  subjectId,
  context = null,
  onRated = null,
  compact = true,
}) {
  const [state, setState] = useState('idle');   // idle | asking-reason | submitting | done-up | done-down
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);

  const send = useCallback(async (rating, providedReason = null) => {
    setState('submitting');
    setError(null);
    try {
      await api.post('/brain/feedback', {
        subjectType, subjectId, rating,
        reason: providedReason,
        context,
      });
      setState(rating === 'up' ? 'done-up' : 'done-down');
      onRated?.(rating, providedReason);
    } catch (err) {
      setError(err?.response?.data?.error ?? 'Could not save feedback');
      setState('idle');
    }
  }, [subjectType, subjectId, context, onRated]);

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
    return (
      <div style={wrap(compact)}>
        <span style={{ fontSize: size - 2, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          👎 Thanks — Brain is diagnosing why this missed.
        </span>
      </div>
    );
  }
  if (state === 'asking-reason') {
    return (
      <div style={{ ...wrap(compact), flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div style={{ fontSize: size - 2, color: 'var(--text-muted)' }}>
          What was off? (optional, helps Brain learn faster)
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 600))}
          placeholder="e.g. wrong person, too formal, outdated, missed the meeting context…"
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
  return { ...base, background: 'transparent', borderColor: 'var(--border)', color: 'var(--text-muted)' };
}
