/**
 * Verify Brain ↔ User Channel — admin testing surface.
 *
 * Lets the admin click their way through the four delivery shapes Brain
 * uses with no need to grep server logs:
 *
 *   1. Text outbound (English)        — proactive criticality alert
 *   2. Text outbound (Urdu)           — Urdu tone matching
 *   3. Voice note outbound (English)  — TTS via Google → Meta /media or
 *                                       webjs MessageMedia
 *   4. Voice note outbound (Urdu)     — Urdu TTS voice
 *
 * Plus an inbound testing panel (no buttons — just instructions) and a
 * live-tailing audit feed of `brain_user_messages` so the admin can see
 * exactly what Brain has sent any user, with suppressions/failures.
 *
 * This is the proof-of-life for the architectural rule: tenant WhatsApp
 * is THE Brain↔user channel, both directions, all media.
 */
import { useEffect, useState, useCallback } from 'react';
import api from '../../services/api';

export default function BrainChannelVerifyPanel({ user }) {
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null);   // which test is in flight
  const [results, setResults] = useState({});      // testKey -> { ok, message }
  const [targetUserId, setTargetUserId] = useState(user?.id ?? 1);
  // The user's configured Brain name (Nexeo, Brain, custom — whatever
  // they set in Settings). Used in every test body so the recipient sees
  // their own assistant's name, not a hardcoded "MyOS verify" prefix.
  const [brainName, setBrainName] = useState('Brain');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/brain-outbound/recent?limit=15');
      setRecent(data.rows ?? []);
    } catch { /* show empty */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // Load the configured Brain name once so the test bodies read with
  // the recipient's own assistant identity. Falls back to 'Brain' on
  // any error — the panel still works, just without per-user branding.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/profile/brain-name');
        if (!cancelled && data?.name) setBrainName(String(data.name));
      } catch { /* keep default */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const runTest = async (key, body, urgency, channel) => {
    setRunning(key);
    setResults((prev) => ({ ...prev, [key]: null }));
    try {
      const { data } = await api.post('/admin/whatsapp-notifier/test-brain', {
        toUserId: Number(targetUserId), body, urgency,
        ...(channel ? { channel } : {}),
      });
      setResults((prev) => ({
        ...prev,
        [key]: data.sent
          ? { ok: true, message: `Delivered via ${data.channelsUsed?.join('+') || 'unknown'}. Audit id: ${data.recordId}.` }
          : { ok: false, message: `Not delivered: ${data.reason ?? 'unknown'}${data.recordId ? ` (audit id: ${data.recordId})` : ''}` },
      }));
      await refresh();
    } catch (e) {
      setResults((prev) => ({ ...prev, [key]: { ok: false, message: e?.response?.data?.error ?? e.message } }));
    } finally {
      setRunning(null);
    }
  };

  // Bodies are built off the configured Brain name so the recipient sees
  // their own assistant's identity (Nexeo / Brain / custom) — not a
  // hardcoded brand. Memoizing keeps stable references during render.
  const TESTS = [
    {
      key: 'text-en', label: 'Text · English',
      desc: `Proactive ${brainName} ping in English (urgency = normal → text only).`,
      body: `${brainName} verify · English text channel. If you see this, ${brainName} can write to you.`,
      urgency: 'normal', icon: '💬',
    },
    {
      key: 'text-ur', label: 'Text · Urdu',
      desc: 'Same path, Urdu body. Validates UTF-8 + RTL rendering on the recipient.',
      body: `${brainName} verify · ${brainName} ne aap se baat karne ki koshish ki. Yeh test message hai. اردو اور انگریزی دونوں زبانوں کو سپورٹ کرتا ہے۔`,
      urgency: 'normal', icon: '💬',
    },
    {
      key: 'voice-en', label: 'Voice note · English',
      desc: `urgency=high → text + TTS voice note (Google TTS English voice).`,
      body: `${brainName} verify · English voice channel. If you hear this, ${brainName} can speak to you.`,
      urgency: 'high', icon: '🎤',
    },
    {
      key: 'voice-ur', label: 'Voice note · Urdu',
      desc: 'urgency=high with Urdu body → Urdu TTS voice (ur-IN-Standard-A).',
      body: `${brainName} verify · یہ اردو وائس ٹیسٹ ہے۔ اگر آپ یہ سن سکتے ہیں تو ${brainName} آپ سے اردو میں بات کر سکتا ہے۔`,
      urgency: 'high', icon: '🎤',
    },
    {
      key: 'call-en', label: 'Voice call · English',
      desc: 'Sends a tap-to-call CTA — taps your tenant business number. Works without Meta enrollment.',
      body: `${brainName} verify · Voice-call channel test (English). Tap the number below to call ${brainName} back.`,
      urgency: 'emergency', channel: 'call_cta', icon: '📞',
    },
    {
      key: 'call-ur', label: 'Voice call · Urdu',
      desc: 'Same path, Urdu preamble for the CTA.',
      body: `${brainName} verify · وائس کال چینل ٹیسٹ۔ نیچے دیے گئے نمبر پر ٹیپ کر کے ${brainName} کو واپس کال کریں۔`,
      urgency: 'emergency', channel: 'call_cta', icon: '📞',
    },
  ];

  return (
    <div style={{
      marginTop: 'var(--s-4)',
      padding: 'var(--s-4)',
      background: 'var(--bg-2)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-md)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-2)', marginBottom: 'var(--s-2)' }}>
        <span style={{
          fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px',
          color: 'var(--accent)', fontWeight: 600,
        }}>
          Verify Brain ↔ User channel
        </span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Bilingual end-to-end checks
        </span>
      </div>
      <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', margin: '0 0 var(--s-3)', lineHeight: 1.55 }}>
        Each button calls <code>brainContactsUser</code> — the same primitive Brain uses for
        criticality alerts, watchpoint fires, and emergency pings. Routing is auto-resolved
        (Meta if configured, else QR Code). Recipient is the user with the ID below.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', marginBottom: 'var(--s-3)' }}>
        <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Recipient user ID:</label>
        <input
          type="number"
          value={targetUserId}
          onChange={(e) => setTargetUserId(e.target.value)}
          style={{
            width: 80, padding: '4px 8px',
            background: 'var(--bg-1)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          (defaults to your user — will receive at <code>users.contact_number</code> or <code>brain_channel.whatsappNumber</code>)
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 'var(--s-2)' }}>
        {TESTS.map((t) => {
          const r = results[t.key];
          const inFlight = running === t.key;
          return (
            <div key={t.key} style={{
              padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
              background: r ? (r.ok ? 'rgba(34,197,94,0.06)' : 'rgba(217,83,79,0.06)') : 'transparent',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16 }}>{t.icon}</span>
                <strong style={{ fontSize: 'var(--fs-sm)' }}>{t.label}</strong>
                {r && (
                  <span style={{
                    marginLeft: 'auto', fontSize: 11, fontWeight: 600,
                    color: r.ok ? '#22c55e' : '#ef4444',
                  }}>
                    {r.ok ? '✓ delivered' : '✗ failed'}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 8px', lineHeight: 1.5 }}>
                {t.desc}
              </div>
              <button
                onClick={() => runTest(t.key, t.body, t.urgency, t.channel)}
                disabled={!!running || !targetUserId}
                style={{
                  padding: '6px 12px', fontSize: 12, fontWeight: 500,
                  background: inFlight ? 'var(--bg-1)' : 'var(--accent)',
                  color: inFlight ? 'var(--text-muted)' : '#0e1116',
                  border: 0, borderRadius: 'var(--r-sm)',
                  cursor: running ? 'not-allowed' : 'pointer',
                  opacity: running && !inFlight ? 0.5 : 1,
                }}
              >
                {inFlight ? <><span className="btn-spinner" />Running…</> : `Run ${t.label}`}
              </button>
              {r && (
                <div style={{ marginTop: 6, fontSize: 11, color: r.ok ? '#9bd9a0' : '#f0a3a0' }}>
                  {r.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Inbound testing — no buttons, just clear instructions. ─────── */}
      <div style={{
        marginTop: 'var(--s-3)', padding: '10px 12px',
        background: 'var(--bg-1)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)',
        lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--text)' }}>Inbound (User → Brain) — test from your phone</strong>
        <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
          <li>Open WhatsApp on the recipient phone (the one paired below).</li>
          <li>Send a <strong>text message</strong> in any language (English / Urdu / mixed) to the tenant number. Brain replies in the same language — see the message arrive in <em>Recent Messages</em> below this panel.</li>
          <li>Send a <strong>voice note</strong>. Brain transcribes (Gemini → Google STT, auto-detects Urdu / English / Hindi), processes, and replies with both a voice note and a text version.</li>
        </ol>
      </div>

      {/* ── Brain → User audit feed ────────────────────────────────────── */}
      <div style={{ marginTop: 'var(--s-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)' }}>
            Brain → User audit · last 15
          </strong>
          <button onClick={refresh} disabled={loading} style={{
            padding: '4px 10px', fontSize: 11, background: 'transparent',
            color: 'var(--text-muted)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-sm)', cursor: 'pointer',
          }}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {recent.length === 0 ? (
          <div style={{ padding: '12px', color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', textAlign: 'center' }}>
            No proactive Brain → user messages yet. Click any test above.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {recent.map((m) => (
              <div key={m.id} style={{
                padding: '8px 10px', fontSize: 11, borderRadius: 'var(--r-sm)',
                border: '1px solid var(--border)',
                background: m.status === 'sent' ? 'rgba(34,197,94,0.04)'
                  : m.status === 'partial' ? 'rgba(245,158,11,0.04)'
                  : m.status === 'suppressed' ? 'rgba(152,160,168,0.04)'
                  : 'rgba(217,83,79,0.04)',
                display: 'grid',
                gridTemplateColumns: 'auto 1fr auto',
                gap: 8, alignItems: 'baseline',
              }}>
                <span style={{
                  padding: '1px 6px', borderRadius: 4,
                  background: m.status === 'sent' ? 'rgba(34,197,94,0.18)'
                    : m.status === 'suppressed' ? 'rgba(152,160,168,0.18)'
                    : 'rgba(217,83,79,0.18)',
                  color: m.status === 'sent' ? '#9bd9a0'
                    : m.status === 'suppressed' ? 'var(--text-muted)'
                    : '#f0a3a0',
                  textTransform: 'uppercase', fontWeight: 600, letterSpacing: '.3px',
                  whiteSpace: 'nowrap',
                }}>
                  {m.status}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: 'var(--text)' }}>
                    <strong>{m.kind}</strong>
                    <span style={{ color: 'var(--text-muted)' }}> · {m.channel} · {m.urgency}</span>
                    {m.user && <span style={{ color: 'var(--text-muted)' }}> · → {m.user.name ?? m.user.email}</span>}
                    {m.toPhone && <span style={{ color: 'var(--text-dim)' }}> ({m.toPhone})</span>}
                  </div>
                  <div style={{ color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.summary}
                    {m.error && <span style={{ color: '#f0a3a0' }}> · {m.error}</span>}
                  </div>
                </div>
                <span style={{ color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                  {new Date(m.createdAt).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
