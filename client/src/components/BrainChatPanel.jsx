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
    try {
      const { data } = await api.post('/brain/ask', { question: q, history });
      // Stable client-side id for this answer — feedback/subjectId references it.
      // The server doesn't persist a row per chat answer today, so we carry the
      // query + answer + sources as `context` in the feedback call so diagnosis
      // can reconstruct what was shown.
      const answerId = `chat:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      setMessages((m) => [
        ...m,
        {
          role: 'brain',
          id: answerId,
          question: q,
          intent: data?.intent,
          text: data?.answer ?? '(no answer)',
          sources: data?.sources ?? [],
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
            onSourceClick={(s) => { if (s.type === 'wiki_page') setWikiPageId(s.id); }}
            feedbackTarget={
              m.role === 'brain' && !m.error && m.id
                ? { id: m.id, question: m.question, answer: m.text, sources: m.sources }
                : null
            }
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
    </div>
  );
}

function Bubble({ role, intent, sources, error, children, onSourceClick, feedbackTarget = null }) {
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
      {feedbackTarget && (
        <FeedbackButtons
          subjectType="chat_answer"
          subjectId={feedbackTarget.id}
          context={{
            question: feedbackTarget.question,
            answer: feedbackTarget.answer,
            sources: feedbackTarget.sources,
          }}
        />
      )}
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
