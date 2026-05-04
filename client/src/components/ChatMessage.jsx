import { useState, useEffect } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Avatar, Pill } from './ui';
import { Icon } from './ui/Icon';
import './ui/ui.css';

/**
 * ChatMessage v2 — Compact density, design-token driven.
 * Assistant messages include:
 *   - model pill next to the name
 *   - hover-revealed Save-to-Wiki chip
 *   - feedback thumbs
 */
const PROVIDER_LABELS = {
  gemini: 'Deep',
  'gemini-flash': 'Fast',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  claude: 'Claude',
  openai: 'GPT-4o',
};

export default function ChatMessage({ message, isLastAssistant, isStreaming, onFollowUp, onOpenArtifact, previousUserMessage }) {
  const { user, appName, aiName, logoUrl } = useAuth();

  useEffect(() => {
    if (message.widgetData && isLastAssistant && onOpenArtifact) {
      onOpenArtifact('dashboard', null, message.widgetData?.title || 'Dashboard', message.widgetData);
    }
  }, [message.widgetData]);

  const displayName = aiName || appName || 'MyOS';
  const userInitial = user?.name?.charAt(0)?.toUpperCase() || 'U';
  const userName = user?.name?.split(' ')[0] || 'You';

  if (message.role === 'user') {
    return (
      <div className="msg-row">
        <Avatar size="md">{userInitial}</Avatar>
        <div className="msg-body">
          <div className="msg-name">{userName}</div>
          <div className="msg-content">
            {message.content.split('\n').map((line, i) => (
              <span key={i}>{line}{i < message.content.split('\n').length - 1 && <br />}</span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const providerLabel = PROVIDER_LABELS[message.provider] || 'AI';
  const showCursor = isLastAssistant && isStreaming;
  const hasContent = message.content && message.content.length > 10;

  return (
    <div className="msg-row msg-row-assistant">
      <Avatar size="md" accent>
        {logoUrl ? <img src={logoUrl} alt="" style={{ width: '100%', height: '100%', borderRadius: 'inherit' }} /> : 'M'}
      </Avatar>
      <div className="msg-body">
        <div className="msg-name">
          {displayName}
          <Pill variant="accent">{providerLabel}</Pill>
        </div>
        <div className="msg-content">
          <MarkdownRenderer content={message.content} isStreaming={showCursor} onFollowUp={onFollowUp} onOpenArtifact={onOpenArtifact} />
        </div>
        {message.widgetData && (
          <button className="msg-action-chip" type="button"
                  onClick={() => onOpenArtifact?.('dashboard', null, message.widgetData?.title || 'Dashboard', message.widgetData)}>
            <Icon name="grid" size={14} /> {message.widgetData?.title || 'Open dashboard'}
          </button>
        )}
        {message.meta && (
          <div className="msg-meta">
            <span>{message.meta.elapsed}s · {message.meta.outputTokens}out · {message.meta.totalTokens} total</span>
            {message.meta.dataLastUpdated && (
              <span>· Updated {new Date(message.meta.dataLastUpdated).toLocaleString()}</span>
            )}
            {hasContent && !isStreaming && (
              <span className="msg-tools">
                <FeedbackButtons query={previousUserMessage} response={message.content} conversationId={message.meta?.conversationId} />
                <SaveToWikiButton query={previousUserMessage} response={message.content} />
              </span>
            )}
          </div>
        )}
        {message.stopped && <div className="msg-stopped">Response stopped</div>}
      </div>
      <style>{`
        .msg-row { display: flex; gap: var(--s-3); padding: var(--s-3) 0; }
        .msg-row + .msg-row { border-top: 1px solid transparent; }
        .msg-body { flex: 1; min-width: 0; }
        .msg-name { display: flex; align-items: center; gap: var(--s-2); font-size: var(--fs-xs); color: var(--text-muted); font-weight: var(--fw-semibold); margin-bottom: 2px; }
        .msg-content { font-size: var(--fs-md); line-height: var(--lh-normal); color: var(--text); }
        .msg-content p { margin: 0 0 var(--s-2); }
        .msg-action-chip { display: inline-flex; align-items: center; gap: var(--s-1); padding: 4px 10px; border: 1px solid var(--border); border-radius: var(--r-pill); font-size: var(--fs-xs); color: var(--text-muted); background: transparent; margin-top: var(--s-2); cursor: pointer; }
        .msg-action-chip:hover { color: var(--accent); border-color: var(--accent); }
        .msg-meta { display: flex; align-items: center; gap: var(--s-3); font-size: var(--fs-xs); color: var(--text-dim); margin-top: var(--s-2); flex-wrap: wrap; }
        .msg-tools { display: inline-flex; gap: var(--s-2); align-items: center; margin-left: auto; opacity: 0; transition: opacity var(--t-fast); }
        .msg-row-assistant:hover .msg-tools { opacity: 1; }
        .msg-stopped { color: var(--text-dim); font-size: var(--fs-xs); margin-top: var(--s-2); font-style: italic; }
      `}</style>
    </div>
  );
}

function FeedbackButtons({ query, response, conversationId }) {
  const [voted, setVoted] = useState(null);
  const vote = async (rating) => {
    setVoted(rating);
    api.post('/chat/feedback', {
      rating, query: query || '',
      responsePreview: (response || '').slice(0, 300),
      conversationId,
    }).catch(() => {});
  };
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <button className="feedback-btn" type="button" disabled={voted !== null} onClick={() => vote('up')} title="Good">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={voted === 'up' ? 'var(--success)' : 'currentColor'} strokeWidth="2"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" /></svg>
      </button>
      <button className="feedback-btn" type="button" disabled={voted !== null} onClick={() => vote('down')} title="Bad">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={voted === 'down' ? 'var(--danger)' : 'currentColor'} strokeWidth="2"><path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10zM17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17" /></svg>
      </button>
      <style>{`.feedback-btn { background: transparent; border: none; cursor: pointer; color: var(--text-dim); padding: 2px; } .feedback-btn:hover { color: var(--text); }`}</style>
    </span>
  );
}

function SaveToWikiButton({ query, response }) {
  const [state, setState] = useState('idle');
  const [pageType, setPageType] = useState('concept');
  const [titleEditing, setTitleEditing] = useState(false);
  const [title, setTitle] = useState('');

  const titleSeed = () => (query || response).slice(0, 80).replace(/\n/g, ' ').trim();
  const buildDefaultTitle = (type) => type === 'decision'
    ? `Decision — ${new Date().toISOString().slice(0, 10)} — ${titleSeed()}`
    : `Concept — ${titleSeed()}`;

  const startSave = () => {
    setTitle(buildDefaultTitle(pageType));
    setTitleEditing(true);
  };

  const confirmSave = async () => {
    const finalTitle = title.trim();
    if (!finalTitle) return;
    setTitleEditing(false);
    setState('saving');
    try {
      const body = [
        `# ${finalTitle}`, '', `> Saved from chat: "${(query || '').slice(0, 120)}"`, '',
        '## Key facts',
        ...response.split('\n').slice(0, 20).filter(Boolean).map((l) => `- ${l.slice(0, 220)}`),
        '', '## Change log', `- ${new Date().toISOString().slice(0, 10)}: Saved from chat answer`,
      ].join('\n');
      await api.post('/wiki/pages', { pageType, title: finalTitle, body, confidence: 0.7, actor: 'chat-save' });
      setState('saved');
    } catch { setState('error'); }
  };

  if (titleEditing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <input
          type="text"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') confirmSave(); if (e.key === 'Escape') setTitleEditing(false); }}
          placeholder="Wiki page title"
          style={{
            background: 'var(--bg-2)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
            padding: '2px 6px', fontSize: 'var(--fs-xs)', minWidth: 280,
          }}
        />
        <button type="button" onClick={confirmSave} disabled={!title.trim()}
                className="msg-action-chip"
                style={{ margin: 0, padding: '2px var(--s-2)' }}>Save</button>
        <button type="button" onClick={() => setTitleEditing(false)}
                className="msg-action-chip"
                style={{ margin: 0, padding: '2px var(--s-2)', color: 'var(--text-muted)' }}>Cancel</button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select value={pageType} onChange={(e) => setPageType(e.target.value)} disabled={state !== 'idle'}
              style={{ background: 'var(--bg-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '2px 4px', fontSize: 'var(--fs-xs)' }}>
        <option value="concept">Concept</option>
        <option value="decision">Decision</option>
        <option value="pattern">Pattern</option>
      </select>
      <button type="button" onClick={startSave} disabled={state !== 'idle'}
              className="msg-action-chip"
              style={{ margin: 0, padding: '2px var(--s-2)', background: state === 'saved' ? 'var(--success-dim)' : 'transparent', color: state === 'saved' ? 'var(--success)' : 'var(--text-muted)' }}>
        <Icon name="save" size={12} />
        {state === 'idle' ? 'Save' : state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Error'}
      </button>
    </span>
  );
}
