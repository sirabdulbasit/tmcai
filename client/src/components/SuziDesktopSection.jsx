// Suzi desktop (DEF-370) — connect the Suzi desktop app to this Nexeo account with a single-use key,
// and see / disconnect the computers already connected. Lives in Settings → Suzi desktop.
import { useEffect, useState } from 'react';
import { InlineConfirm, formatPkt } from '../pages/admin/integrations/integrationUi';
import { createConnectKey, disconnectDevice, errorText, listDevices } from '../services/suziApi';

const OS_LABEL = { macos: 'macOS', windows: 'Windows' };

export default function SuziDesktopSection() {
  const [issued, setIssued] = useState(null); // { key, expiresAt }
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(null); // 'url' | 'key' | 'both'
  const [msg, setMsg] = useState(null); // { ok, text }
  const [devices, setDevices] = useState(null);

  const load = () =>
    listDevices()
      .then(setDevices)
      .catch((e) => {
        setDevices([]);
        setMsg({ ok: false, text: errorText(e) });
      });

  useEffect(() => {
    load();
  }, []);

  // The key is only good for 10 minutes; drop it from the screen when it lapses.
  useEffect(() => {
    if (!issued) return undefined;
    const ms = new Date(issued.expiresAt).getTime() - Date.now();
    const t = setTimeout(() => setIssued(null), Math.max(0, ms));
    return () => clearTimeout(t);
  }, [issued]);

  const generate = async () => {
    setBusy(true);
    setMsg(null);
    setCopied(null);
    try {
      setIssued(await createConnectKey());
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setMsg({ ok: false, text: 'Clipboard blocked — select the text and copy it manually.' });
    }
  };

  const disconnect = async (d) => {
    setMsg(null);
    try {
      await disconnectDevice(d.id);
      setMsg({ ok: true, text: `${d.name} is disconnected.` });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
    await load();
  };

  return (
    <>
      <section className="settings-section">
        <h2>Connect a computer</h2>
        <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
          Suzi is your voice assistant on your own Mac or Windows computer. Generate a key here, then give the Suzi
          desktop app the server URL and the key. A key works once and is valid for 10 minutes.
        </p>
        {!issued && (
          <button className="settings-btn" onClick={generate} disabled={busy}>
            {busy ? <><span className="btn-spinner" /> Generating…</> : 'Generate connection key'}
          </button>
        )}
        {issued && (
          <div>
            <CopyRow label="Server URL" value={issued.serverUrl} copied={copied === 'url'} onCopy={() => copy('url', issued.serverUrl)} />
            <CopyRow label="Key" value={issued.key} mono copied={copied === 'key'} onCopy={() => copy('key', issued.key)} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
              <button className="settings-btn" onClick={() => copy('both', issued.connectLink)}>
                {copied === 'both' ? 'Copied' : 'Copy both (one line)'}
              </button>
              <span style={{ fontSize: 12, color: '#999' }}>Paste it into the Suzi app's Connect field.</span>
            </div>
            <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
              Key valid until {formatPkt(issued.expiresAt)} · single use.
            </div>
            <button className="settings-btn" style={{ marginTop: 10, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)' }} onClick={generate} disabled={busy}>
              {busy ? 'Generating…' : 'Generate a new key'}
            </button>
          </div>
        )}
        {msg && <div style={{ fontSize: 12, color: msg.ok ? '#4ade80' : '#fca5a5', marginTop: 8 }}>{msg.text}</div>}
      </section>

      <section className="settings-section">
        <h2>Connected computers</h2>
        {devices === null && <div style={{ fontSize: 12, color: '#999' }}>Loading…</div>}
        {devices && devices.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>No computers connected yet.</div>}
        {devices && devices.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {devices.map((d) => (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {d.name}{' '}
                    <span style={{ fontSize: 11, color: d.online ? '#4ade80' : '#999', fontWeight: 400 }}>
                      {d.online ? '● online' : '○ offline'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#999' }}>
                    {OS_LABEL[d.os] ?? d.os} · connected {formatPkt(d.connectedAt)}
                    {d.lastSeenAt ? ` · last used ${formatPkt(d.lastSeenAt)}` : ''}
                  </div>
                </div>
                <InlineConfirm
                  label="Disconnect"
                  confirmLabel="Disconnect"
                  kind="danger"
                  consequence={`Suzi on ${d.name} stops working until you connect it again with a new key.`}
                  onConfirm={() => disconnect(d)}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function CopyRow({ label, value, mono = false, copied, onCopy }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          readOnly
          value={value}
          aria-label={label}
          onClick={(e) => e.target.select()}
          style={{ fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? 16 : 14, letterSpacing: mono ? 1 : 0, padding: '8px 10px', minWidth: 280 }}
        />
        <button className="settings-btn" onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
