/**
 * DelegateePicker — modal for picking a delegatee.
 *
 * Two behaviors depending on props:
 *   - Default: shows Brain's top ranked candidates for the given item
 *     (archetype + senderDomain). Loaded on open.
 *   - Search: as the MD types, live-searches users + entities for matches.
 *
 * On select, returns { userId?, email, name } to the parent via onPick.
 */
import { useEffect, useState } from 'react';
import api from '../services/api';
import { Button, Card, Pill } from './ui';
import { Icon } from './ui/Icon';

// Small pill that tells the MD where this candidate came from so they can
// decide in one glance whether it's an internal colleague or an external contact.
function kindPill(kind) {
  const labels = {
    user:      { text: 'internal',  variant: 'success' },
    directory: { text: 'internal',  variant: 'success' },
    history:   { text: 'delegated before', variant: 'accent' },
    google:    { text: 'in your contacts', variant: 'info' },
    contact:   { text: 'external',  variant: undefined },
  };
  const l = labels[kind] ?? { text: kind, variant: undefined };
  return <Pill variant={l.variant}>{l.text}</Pill>;
}

export default function DelegateePicker({ open, context, onCancel, onPick }) {
  const [q, setQ] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(false);
  const [customEmail, setCustomEmail] = useState('');

  // Reload when opened or query changes
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    else {
      if (context?.archetype) params.set('archetype', context.archetype);
      if (context?.itemType) params.set('itemType', context.itemType);
      if (context?.senderDomain) params.set('senderDomain', context.senderDomain);
    }
    api.get(`/brain/people/suggest?${params.toString()}`)
      .then((r) => setCandidates(r.data.candidates ?? []))
      .catch(() => setCandidates([]))
      .finally(() => setLoading(false));
  }, [open, q, context?.archetype, context?.itemType, context?.senderDomain]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 'calc(var(--z-modal) + 2)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 'calc(var(--s-8))', paddingTop: '10vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-1)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)', width: 'min(540px, 94vw)',
          maxHeight: '72vh', display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
        }}
      >
        <header style={{ padding: 'var(--s-4)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)' }}>Delegate to</div>
            <button onClick={onCancel} style={{ background: 'transparent', border: 0, color: 'var(--text-muted)', cursor: 'pointer' }}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <input
            autoFocus
            placeholder="Type a name or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              width: '100%', padding: '8px 10px',
              background: 'var(--bg-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)', color: 'var(--text)',
              fontSize: 'var(--fs-sm)',
            }}
          />
          {!q && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 6 }}>
              Brain's top picks for this {context?.itemType ?? 'item'} — ordered by history + fit + workload.
            </div>
          )}
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--s-3) var(--s-4)' }}>
          {loading && candidates.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>Searching…</div>
          )}
          {!loading && candidates.length === 0 && !q && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
              No ranked candidates yet. Start typing to search.
            </div>
          )}
          {!loading && candidates.length === 0 && q && (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
              No match for "{q}". Use the custom-email option below.
            </div>
          )}
          {candidates.map((c, i) => (
            <Card
              key={`${c.kind}-${c.userId ?? c.email ?? i}`}
              size="sm"
              style={{ marginBottom: 'var(--s-2)', cursor: 'pointer' }}
              onClick={() => onPick({ userId: c.userId ?? undefined, email: c.email, name: c.name })}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 'var(--fw-medium)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {c.name}
                    {kindPill(c.kind)}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                    {c.email}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
                    {c.note}
                  </div>
                </div>
                {!q && (c.score > 0) && (
                  <Pill variant="accent">{Math.round((c.score ?? 0) * 100)}%</Pill>
                )}
              </div>
            </Card>
          ))}
        </div>

        <footer style={{
          padding: 'var(--s-3) var(--s-4)', borderTop: '1px solid var(--border)',
          display: 'flex', gap: 'var(--s-2)', alignItems: 'center',
        }}>
          <input
            placeholder="Or paste custom email…"
            value={customEmail}
            onChange={(e) => setCustomEmail(e.target.value)}
            style={{
              flex: 1, padding: '6px 10px',
              background: 'var(--bg-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)', color: 'var(--text)',
              fontSize: 'var(--fs-sm)',
            }}
          />
          <Button
            variant="primary" size="sm"
            disabled={!customEmail.includes('@')}
            onClick={() => onPick({ email: customEmail.trim(), name: customEmail.split('@')[0] })}
          >
            Use custom
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        </footer>
      </div>
    </div>
  );
}
