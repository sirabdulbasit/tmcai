import { useState, useEffect, useRef } from 'react';
import BrainChatPanel from './BrainChatPanel';
import { Icon } from './ui/Icon';

/**
 * FloatingChat — always-available conversational surface with the Brain.
 *
 * The Brain is primarily autonomous (runs at backend, Day Brief is the main
 * surface). This floating dock is for when you want to probe or ask something
 * mid-flow. Not a rail destination.
 *
 * Interaction:
 *   - Button bottom-right: toggle open/closed.
 *   - Keyboard shortcut: Cmd+/ (Mac) or Ctrl+/ (Win/Linux).
 *   - When open, slides from the right as a 440px drawer, on top of the page.
 *   - Same ChatPage content, in `embedded` mode.
 */
export default function FloatingChat() {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Chat with Brain (Cmd+/)"
        style={{
          position: 'fixed',
          right: 'var(--s-6)',
          bottom: 'var(--s-6)',
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--accent), #8b3a1e)',
          color: 'var(--accent-text)',
          border: 0,
          cursor: 'pointer',
          display: 'grid',
          placeItems: 'center',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 'var(--z-modal)',
          transition: 'transform var(--t-fast)',
          opacity: open ? 0 : 1,
          pointerEvents: open ? 'none' : 'auto',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = 'scale(1.06)')}
        onMouseLeave={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        <Icon name="chat" size={22} />
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            zIndex: 'var(--z-modal)',
            backdropFilter: 'blur(2px)',
          }}
        />
      )}

      <aside
        ref={drawerRef}
        aria-hidden={!open}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(640px, 95vw)',
          background: 'var(--bg-1)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 'calc(var(--z-modal) + 1)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform var(--t-base)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header style={{
          padding: 'var(--s-3) var(--s-4)',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
            <div style={{
              width: 28, height: 28, borderRadius: 6,
              background: 'linear-gradient(135deg, var(--accent), #8b3a1e)',
            }} />
            <div>
              <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)' }}>Chat with Brain</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Cmd+/ to toggle · Esc to close</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{
              // Beefed up so the close action is visible at a glance on
              // mobile where the keyboard hint isn't useful — "Esc to
              // close" doesn't help on a phone that has no Esc key.
              background: 'transparent',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              padding: '6px 12px',
              borderRadius: 'var(--r-sm)',
              cursor: 'pointer',
              fontSize: 'var(--fs-sm)',
              fontWeight: 'var(--fw-medium)',
              minHeight: 36,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
            aria-label="Close chat"
          >
            ✕ Close
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {open && <BrainChatPanel />}
        </div>
      </aside>
    </>
  );
}
