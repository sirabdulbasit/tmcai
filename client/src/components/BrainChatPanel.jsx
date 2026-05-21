/**
 * BrainChatPanel — the conversational face of Brain's Knowledge Center.
 *
 * Posts each message to /brain/ask, displays the intent label + answer +
 * lineage (entities / wiki_pages / decisions / open_items cited in the
 * response). This is the chat surface the MD uses for ad-hoc queries; the
 * Advisor mode (silent suggestions) continues to populate Day Brief in
 * parallel.
 */
import { useState, useRef, useEffect } from 'react';
import api from '../services/api';
import WikiPageDetail from '../pages/WikiPageDetail';
import FeedbackButtons from './FeedbackButtons';

export default function BrainChatPanel() {
  const [messages, setMessages] = useState([
    { role: 'brain', text: "I'm Brain. Ask me anything about your people, decisions, open items, emails, attachments, or what's been happening this week." },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [wikiPageId, setWikiPageId] = useState(null);
  // Pop-out overlay card for dashboard panel directives (open items
  // list, contact card, etc). Brain sends a PanelDirective alongside
  // the answer when the question warrants a structured view; the
  // Bubble shows a "View details" chip and this state drives the
  // overlay.
  const [activePanel, setActivePanel] = useState(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-focus the prompt bar when the chat panel mounts (i.e. every time
  // the user opens Chat with Brain), AND after each Brain response so the
  // user can type the follow-up without clicking back into the field.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!busy) inputRef.current?.focus();
  }, [busy]);

  const ask = async (question) => {
    const q = (question ?? input).trim();
    if (!q) return;
    setInput('');
    // Snapshot the existing thread before appending the new user turn —
    // this is what we send to /brain/ask as `history` so the server can
    // resolve follow-ups against prior turns.
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'brain')
      .slice(-6)
      .map((m) => ({ role: m.role, text: String(m.text ?? '') }));
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setBusy(true);

    // Quality Sprint 5e finish (2026-05-21): consume the /brain/ask-stream
    // SSE endpoint when available — falls back to the blocking /brain/ask
    // POST on any error. The streaming path gives the user immediate
    // visual feedback ("thinking..." stage) and progressive text chunks
    // instead of a 3-7 second blank wait.
    const answerId = `chat:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    let streamed = false;
    try {
      // Use fetch (not axios) because we need raw streaming reads.
      const resp = await fetch('/api/v1/brain/ask-stream', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history, channel: 'web' }),
      });
      if (resp.ok && resp.body) {
        streamed = true;
        // Insert a placeholder brain message to update as chunks arrive.
        setMessages((m) => [...m, {
          role: 'brain', id: answerId, question: q, text: '', streaming: true,
          sources: [], panel: null, intent: null,
        }]);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let accText = '';
        let meta = {};
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are separated by blank lines.
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const eventMatch = frame.match(/^event:\s*(\w+)/m);
            const dataMatch = frame.match(/^data:\s*(.*)$/m);
            if (!eventMatch || !dataMatch) continue;
            const event = eventMatch[1];
            let data;
            try { data = JSON.parse(dataMatch[1]); } catch { data = null; }
            if (event === 'chunk' && data?.text) {
              accText += (accText && !accText.endsWith(' ') ? ' ' : '') + data.text;
              setMessages((m) => m.map((mm) =>
                mm.id === answerId ? { ...mm, text: accText } : mm,
              ));
            } else if (event === 'meta' && data) {
              meta = data;
              setMessages((m) => m.map((mm) =>
                mm.id === answerId ? { ...mm, sources: data.sources ?? [], panel: data.panel ?? null, intent: data.intent } : mm,
              ));
            } else if (event === 'error' && data?.message) {
              setMessages((m) => m.map((mm) =>
                mm.id === answerId ? { ...mm, text: data.message, error: true, streaming: false } : mm,
              ));
            } else if (event === 'done') {
              setMessages((m) => m.map((mm) =>
                mm.id === answerId ? { ...mm, streaming: false } : mm,
              ));
            }
          }
        }
      }
    } catch {
      // Stream failed — fall through to blocking path below.
    }

    if (!streamed) {
      try {
        const { data } = await api.post('/brain/ask', { question: q, history });
        setMessages((m) => [
          ...m,
          {
            role: 'brain',
            id: answerId,
            question: q,
            intent: data?.intent,
            text: data?.answer ?? '(no answer)',
            sources: data?.sources ?? [],
            panel: data?.panel ?? null,
          },
        ]);
      } catch (e) {
        setMessages((m) => [...m, { role: 'brain', text: e?.response?.data?.error ?? e.message, error: true }]);
      }
    }
    setBusy(false);
  };

  // Retry handler — invoked from FeedbackButtons after a 👎 with a
  // high-confidence diagnosis. POSTs the diagnosis to /brain/retry, which
  // re-runs the composer with the diagnosis injected as steering. The
  // retry answer is appended as a fresh brain turn carrying retry=true so
  // the user can 👍/👎 it independently.
  const retry = async ({ diagnosis, question }) => {
    if (!question) return;
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'brain')
      .slice(-8)
      .map((m) => ({ role: m.role, text: String(m.text ?? '') }));
    setBusy(true);
    try {
      const { data } = await api.post('/brain/retry', {
        question,
        diagnosis: {
          category: diagnosis?.category,
          hypothesis: diagnosis?.hypothesis,
          likelyFix: diagnosis?.likelyFix,
        },
        history,
      });
      const answerId = `chat:retry:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      setMessages((m) => [
        ...m,
        {
          role: 'brain',
          id: answerId,
          question,
          intent: data?.intent,
          text: data?.answer ?? '(no retry answer)',
          sources: data?.sources ?? [],
          retry: { applied: true, category: data?.retry?.category ?? diagnosis?.category },
        },
      ]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'brain', text: e?.response?.data?.error ?? e.message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Scroll area */}
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        padding: 'var(--s-3) var(--s-4)',
        display: 'flex', flexDirection: 'column', gap: 'var(--s-3)',
      }}>
        {messages.map((m, i) => (
          <Bubble
            key={m.id ?? i}
            role={m.role}
            intent={m.intent}
            sources={m.sources}
            error={m.error}
            retry={m.retry}
            panel={m.panel}
            onPanelOpen={(p) => setActivePanel(p)}
            onSourceClick={(s) => { if (s.type === 'wiki_page') setWikiPageId(s.id); }}
            feedbackTarget={
              m.role === 'brain' && !m.error && m.id
                ? { id: m.id, question: m.question, answer: m.text, sources: m.sources }
                : null
            }
            onRetry={retry}
          >
            {m.text}
          </Bubble>
        ))}
        {busy && <Bubble role="brain">Thinking…</Bubble>}
        <div ref={endRef} />
      </div>

      {/* Input dock */}
      <div style={{
        borderTop: '1px solid var(--border)',
        padding: 'var(--s-3) var(--s-4)',
        background: 'var(--bg-1)',
      }}>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ask()}
            disabled={busy}
            placeholder="Ask Brain anything…"
            autoFocus
            style={{
              flex: 1, padding: '12px 14px',
              background: 'var(--bg-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)',
              color: 'var(--text)',
              fontSize: 'var(--fs-md)',
            }}
          />
          <button
            type="button"
            onClick={() => ask()}
            disabled={busy || !input.trim()}
            style={{
              padding: '12px 22px',
              background: busy || !input.trim() ? 'var(--bg-2)' : 'var(--accent)',
              color: busy || !input.trim() ? 'var(--text-dim)' : 'var(--accent-text)',
              border: 0,
              borderRadius: 'var(--r-md)',
              fontWeight: 'var(--fw-medium)',
              cursor: busy || !input.trim() ? 'not-allowed' : 'pointer',
              fontSize: 'var(--fs-md)',
            }}
          >
            {busy ? '…' : 'Ask'}
          </button>
        </div>
      </div>
      {wikiPageId && <WikiPageDetail id={wikiPageId} onClose={() => setWikiPageId(null)} />}
      {activePanel && <PanelOverlay panel={activePanel} onClose={() => setActivePanel(null)} />}
    </div>
  );
}

function Bubble({ role, intent, sources, error, children, onSourceClick, feedbackTarget = null, retry = null, onRetry = null, panel = null, onPanelOpen = null }) {
  const isUser = role === 'user';
  const renderBody = () => {
    if (isUser || error || typeof children !== 'string') {
      return <span style={{ whiteSpace: 'pre-wrap' }}>{children}</span>;
    }
    return <Markdown text={children} />;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}>
      <div style={{
        maxWidth: '92%',
        padding: '12px 14px',
        borderRadius: 'var(--r-md)',
        background: isUser ? 'var(--accent)' : 'var(--bg-2)',
        color: isUser ? 'var(--accent-text)' : error ? 'var(--danger)' : 'var(--text)',
        fontSize: 'var(--fs-md)',
        lineHeight: 1.6,
      }}>
        {renderBody()}
      </div>
      {intent && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '.5px' }}>
          intent: {intent}
        </div>
      )}
      {sources && sources.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', maxWidth: '88%' }}>
          <div style={{ fontWeight: 'var(--fw-medium)', marginBottom: 2 }}>Sources:</div>
          {sources.slice(0, 5).map((s, i) => {
            const clickable = s.type === 'wiki_page' && onSourceClick;
            return (
              <div key={i} style={{ display: 'flex', gap: 4, paddingLeft: 6 }}>
                <span style={{ color: 'var(--accent)' }}>·</span>
                {clickable ? (
                  <button
                    onClick={() => onSourceClick(s)}
                    style={{
                      background: 'transparent', border: 0, padding: 0,
                      color: 'var(--accent)', cursor: 'pointer',
                      textDecoration: 'underline', fontSize: 'inherit',
                    }}
                  >
                    [{s.type}] {s.snippet}
                  </button>
                ) : (
                  <span>[{s.type}] {s.snippet}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {panel && onPanelOpen && (
        <button
          type="button"
          onClick={() => onPanelOpen(panel)}
          style={{
            marginTop: 8,
            padding: '6px 12px',
            background: 'var(--bg-1)',
            border: '1px solid var(--accent)',
            borderRadius: 'var(--r-md)',
            color: 'var(--accent)',
            fontSize: 'var(--fs-sm)',
            fontWeight: 'var(--fw-medium)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
          title={panel.title}
        >
          {panelIconFor(panel.kind)} View {panel.title.toLowerCase()}
          {panel.kind === 'open_items_list' && Array.isArray(panel.itemIds) ? ` (${panel.itemIds.length})` : ''}
        </button>
      )}
      {retry?.applied && (
        <div style={{
          fontSize: 10, color: '#a5b4fc', fontWeight: 600,
          marginTop: 6,
          padding: '2px 6px',
          background: 'rgba(99,102,241,0.12)',
          border: '1px solid rgba(99,102,241,0.4)',
          borderRadius: 4,
          display: 'inline-block',
        }}>
          ↻ retry — corrected for {retry.category ?? 'previous miss'}
        </div>
      )}
      {feedbackTarget && (
        <FeedbackButtons
          subjectType="chat_answer"
          subjectId={feedbackTarget.id}
          context={{
            question: feedbackTarget.question,
            answer: feedbackTarget.answer,
            sources: feedbackTarget.sources,
          }}
          onRetry={onRetry}
        />
      )}
    </div>
  );
}

// Pop-out overlay card — renders a PanelDirective from the Brain
// response. Click backdrop or X to dismiss. Per user 2026-05-18:
// "Pop-out overlay card" UX, not a docked split.
function PanelOverlay({ panel, onClose }) {
  // Esc closes the overlay — keyboard-accessible.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 92vw)',
          maxHeight: '82vh',
          background: 'var(--bg-1, #1a1a1a)',
          border: '1px solid var(--border, #333)',
          borderRadius: 'var(--r-lg, 10px)',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border, #333)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-md, 14px)', fontWeight: 600, color: 'var(--text, #eee)' }}>
            <span>{panelIconFor(panel.kind)}</span>
            <span>{panel.title}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent', border: 0, color: 'var(--text-dim, #888)',
              fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: 4,
            }}
          >×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px' }}>
          {panel.kind === 'open_items_list' ? (
            <OpenItemsPanelBody itemIds={panel.itemIds} />
          ) : (
            <div style={{ color: 'var(--text-dim, #888)', fontSize: 13 }}>
              Panel kind "{panel.kind}" isn't rendered yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function panelIconFor(kind) {
  switch (kind) {
    case 'open_items_list': return '📋';
    case 'contact_card':    return '👤';
    case 'calendar_week':   return '🗓';
    case 'deal_summary':    return '💼';
    case 'custom_table':    return '📊';
    default:                return '·';
  }
}

function OpenItemsPanelBody({ itemIds }) {
  const [items, setItems] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.post('/open-items/by-ids', { ids: itemIds })
      .then((r) => { if (alive) setItems(r.data.items ?? []); })
      .catch((e) => { if (alive) setErr(e?.response?.data?.error ?? e.message); });
    return () => { alive = false; };
  }, [itemIds]);

  if (err) return <div style={{ color: 'var(--danger, #f87171)', fontSize: 13 }}>{err}</div>;
  if (items === null) return <div style={{ color: 'var(--text-dim, #888)', fontSize: 13 }}>Loading…</div>;
  if (items.length === 0) return <div style={{ color: 'var(--text-dim, #888)', fontSize: 13 }}>Nothing to show.</div>;

  const priorityColor = (p) => p === 'critical' ? '#f87171' : p === 'high' ? '#fb923c' : p === 'medium' ? '#fbbf24' : '#9ca3af';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it) => (
        <div key={it.id} style={{
          padding: '10px 12px',
          border: '1px solid var(--border, #333)',
          borderRadius: 'var(--r-md, 8px)',
          background: 'var(--bg-2, #222)',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{
              width: 6, alignSelf: 'stretch',
              background: priorityColor(it.priority),
              borderRadius: 3, flexShrink: 0,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text, #eee)', wordBreak: 'break-word' }}>
                {it.title}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-dim, #888)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <span>{it.status}</span>
                {it.priority && <span>· {it.priority}</span>}
                {it.dueDate && <span>· due {new Date(it.dueDate).toISOString().slice(0, 10)}</span>}
                {it.delegateeName && <span>· {it.delegateeName}</span>}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Minimal markdown renderer — handles what the LLM actually emits
// (**bold**, *italic*, `code`, bullet + numbered lists, blank-line
// paragraphs). Avoids pulling in a full markdown dependency.
function Markdown({ text }) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    // Bulleted list
    if (/^\s*[*\-•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[*\-•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[*\-•]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    // Paragraph (accumulate until blank line or list)
    const para = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*[*\-•]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'p', text: para.join(' ') });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {blocks.map((b, idx) => {
        if (b.type === 'p') {
          return <div key={idx}>{renderInline(b.text)}</div>;
        }
        if (b.type === 'ul') {
          return (
            <ul key={idx} style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
            </ul>
          );
        }
        if (b.type === 'ol') {
          return (
            <ol key={idx} style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
            </ol>
          );
        }
        return null;
      })}
    </div>
  );
}

// Inline: **bold**, *italic*, `code`. Tokenize in one pass to avoid
// nested-replace issues (e.g., ** containing *).
function renderInline(text) {
  const out = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      out.push(
        <code
          key={key++}
          style={{
            background: 'var(--bg-1)',
            padding: '1px 5px',
            borderRadius: 4,
            fontSize: '0.92em',
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          }}
        >
          {tok.slice(1, -1)}
        </code>
      );
    } else {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
