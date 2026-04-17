import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

const s = {
  wrapper: { height: '100vh', overflow: 'hidden', position: 'relative', background: '#111' },
  scrollArea: { height: '100%', overflowY: 'auto', paddingBottom: 60, scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' },
  fadeHint: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(transparent, #111)', pointerEvents: 'none', zIndex: 10, transition: 'opacity 0.3s' },
  page: { padding: '20px 24px', maxWidth: 900, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  btn: { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit' },
  btnPrimary: { background: '#cc6b4a', color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid #555', color: '#aaa' },
  btnSuccess: { background: '#4ade80', color: '#111' },
  btnDanger: { background: '#ef4444', color: '#fff' },
  badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + '22', color, marginLeft: 8 }),
  tab: (active) => ({ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit', background: active ? '#cc6b4a' : 'transparent', color: active ? '#fff' : '#888', marginRight: 4 }),
  card: { background: '#1e1e1e', border: '1px solid #333', borderRadius: 10, padding: 16, marginBottom: 12 },
  input: { width: '100%', background: '#2a2a2a', border: '1px solid #444', color: '#eee', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  label: { display: 'block', fontSize: 12, color: '#888', marginBottom: 4, marginTop: 14 },
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '20px 16px' },
  modalBody: { background: '#1e1e1e', border: '1px solid #444', borderRadius: 12, padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' },
  empty: { textAlign: 'center', padding: 40, color: '#666', fontSize: 14 },
};

const TYPE_ICONS = { weekly_review: '📊', reflection_prompt: '💭', pattern_insight: '💡', strategic_question: '🎯', user_note: '📝' };
const TYPE_LABELS = { weekly_review: 'Weekly Review', reflection_prompt: 'Reflection', pattern_insight: 'Pattern Insight', strategic_question: 'Strategic', user_note: 'Note' };
const STATUS_COLORS = { draft: '#f59e0b', published: '#4ade80', dismissed: '#888', archived: '#666' };

export default function ThoughtPipelinePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [atBottom, setAtBottom] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const r = await api.get('/thoughts');
      setEntries(r.data.entries || []);
    } catch {}
    setLoading(false);
  }

  async function handleCreate() {
    if (!newTitle || !newContent) return;
    try {
      await api.post('/thoughts', { title: newTitle, content: newContent });
      setShowNew(false); setNewTitle(''); setNewContent('');
      setMsg('Note created'); load();
      setTimeout(() => setMsg(''), 3000);
    } catch {}
  }

  async function handlePublish(id) {
    try {
      await api.post(`/thoughts/${id}/publish`);
      setMsg('Published'); load();
      setTimeout(() => setMsg(''), 3000);
    } catch {}
  }

  async function handleDismiss(id) {
    try {
      await api.post(`/thoughts/${id}/dismiss`);
      load();
    } catch {}
  }

  const filtered = filter === 'all' ? entries : entries.filter(e => e.status === filter);

  return (
    <div style={s.wrapper}>
      <div style={s.scrollArea} onScroll={e => { const { scrollTop, scrollHeight, clientHeight } = e.target; setAtBottom(scrollHeight - scrollTop - clientHeight < 40); }}>
      <div style={s.page}>
        <div style={s.header}>
          <div>
            <button style={{ ...s.btn, ...s.btnOutline, marginRight: 10 }} onClick={() => navigate('/')}>← Back to Chat</button>
            <span style={{ fontSize: 20, fontWeight: 700, color: '#eee' }}>My Thoughts</span>
            <span style={s.badge('#f59e0b')}>{entries.filter(e => e.status === 'draft').length} Drafts</span>
            <span style={s.badge('#4ade80')}>{entries.filter(e => e.status === 'published').length} Published</span>
          </div>
          <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => setShowNew(true)}>+ New Note</button>
        </div>

        {msg && <div style={{ padding: '8px 14px', background: '#4ade8022', border: '1px solid #4ade80', borderRadius: 8, marginBottom: 12, color: '#4ade80', fontSize: 13 }}>{msg}</div>}

        {/* Filters */}
        <div style={{ marginBottom: 16 }}>
          {['all', 'draft', 'published', 'dismissed'].map(f => (
            <button key={f} style={s.tab(filter === f)} onClick={() => setFilter(f)}>
              {f === 'all' ? `All (${entries.length})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${entries.filter(e => e.status === f).length})`}
            </button>
          ))}
        </div>

        {/* Entries */}
        {loading ? <div style={s.empty}>Loading...</div> : filtered.length === 0 ? (
          <div style={s.empty}>No thought entries yet. AI will generate reflections and weekly reviews as you use the system. You can also create notes manually.</div>
        ) : (
          filtered.map(entry => (
            <div key={entry.id} style={{ ...s.card, borderColor: expanded === entry.id ? '#cc6b4a' : '#333' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16 }}>{TYPE_ICONS[entry.type] || '📝'}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#eee' }}>{entry.title}</span>
                    <span style={s.badge(STATUS_COLORS[entry.status] || '#888')}>{entry.status}</span>
                    <span style={s.badge('#888')}>{TYPE_LABELS[entry.type] || entry.type}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    {new Date(entry.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {entry.triggerSource && ` · trigger: ${entry.triggerSource}`}
                    {entry.publishedAt && ` · published ${new Date(entry.publishedAt).toLocaleDateString()}`}
                  </div>
                </div>
                <span style={{ color: '#555', fontSize: 18 }}>{expanded === entry.id ? '▲' : '▼'}</span>
              </div>

              {expanded === entry.id && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #333' }}>
                  <div style={{ fontSize: 14, color: '#ccc', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{entry.content}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    {entry.status === 'draft' && (
                      <>
                        <button style={{ ...s.btn, ...s.btnSuccess }} onClick={() => handlePublish(entry.id)}>Publish</button>
                        <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => handleDismiss(entry.id)}>Dismiss</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      </div>
      <div style={{ ...s.fadeHint, opacity: atBottom ? 0 : 1 }} />

      {/* New note modal */}
      {showNew && (
        <div style={s.modal} onClick={() => setShowNew(false)}>
          <div style={s.modalBody} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#eee', marginBottom: 16 }}>New Thought Note</div>
            <label style={s.label}>Title *</label>
            <input style={s.input} value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="What's on your mind?" />
            <label style={s.label}>Content *</label>
            <textarea style={{ ...s.input, minHeight: 150, resize: 'vertical' }} value={newContent} onChange={e => setNewContent(e.target.value)} placeholder="Write your thoughts, observations, or strategic notes..." />
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => setShowNew(false)}>Cancel</button>
              <button style={{ ...s.btn, ...s.btnPrimary }} onClick={handleCreate}>Save Note</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
