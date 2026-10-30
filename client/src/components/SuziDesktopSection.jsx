// Suzi desktop (DEF-370) — give the Suzi desktop app the server URL + YOUR OWN API key (each Nexeo
// user gets a different key), valid for the period chosen here, and see / disconnect the
// computers using your keys. Lives in Settings → Suzi desktop.
import { useEffect, useState } from 'react';
import { InlineConfirm, formatPkt } from '../pages/admin/integrations/integrationUi';
import { createApiKey, disconnectDevice, errorText, listDevices } from '../services/suziApi';

const VALIDITY = [7, 30, 90];

export default function SuziDesktopSection() {
  const [validity, setValidity] = useState(30);
  const [issued, setIssued] = useState(null); // { apiKey, keyPrefix, expiresAt, validityDays, serverUrl, connectLink }
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

  const generate = async () => {
    setBusy(true);
    setMsg(null);
    setCopied(null);
    try {
      setIssued(await createApiKey(validity));
      await load();
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
      if (issued && d.keyPrefix === issued.keyPrefix) setIssued(null);
      setMsg({ ok: true, text: `${label(d)} is disconnected — its key no longer works.` });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
    await load();
  };

  return (
    <>
      <section className="settings-section">
        <h2>Connect Suzi desktop</h2>
        <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
          Suzi is your voice assistant on your own Mac or Windows computer. Generate your API key here and enter it in the
          Suzi desktop app together with the server URL. The key is yours alone and works until it expires or you disconnect it.
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span style={{ fontSize: 13 }}>Valid for</span>
          {VALIDITY.map((d) => (
            <label key={d} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="radio" name="suzi-validity" checked={validity === d} onChange={() => setValidity(d)} />
              {d} days
            </label>
          ))}
        </div>
        <button className="settings-btn" onClick={generate} disabled={busy}>
          {busy ? <><span className="btn-spinner" /> Generating…</> : issued ? 'Generate another key' : 'Generate API key'}
        </button>

        {issued && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 12, color: '#f59e0b', marginBottom: 8 }}>
              Copy the key now — for your security it is shown only this once.
            </div>
            <CopyRow label="Server URL" value={issued.serverUrl} copied={copied === 'url'} onCopy={() => copy('url', issued.serverUrl)} />
            <CopyRow label="API key" value={issued.apiKey} mono copied={copied === 'key'} onCopy={() => copy('key', issued.apiKey)} />
            <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
              Valid for {issued.validityDays} days — until {formatPkt(issued.expiresAt)}.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="settings-btn" onClick={() => copy('both', issued.connectLink)}>
                {copied === 'both' ? 'Copied' : 'Copy both (one line)'}
              </button>
              <span style={{ fontSize: 12, color: '#999' }}>Paste it into the Suzi app's Connect field.</span>
            </div>
          </div>
        )}
        {msg && <div style={{ fontSize: 12, color: msg.ok ? '#4ade80' : '#fca5a5', marginTop: 8 }}>{msg.text}</div>}
      </section>

      <section className="settings-section">
        <h2>Your keys and computers</h2>
        {devices === null && <div style={{ fontSize: 12, color: '#999' }}>Loading…</div>}
        {devices && devices.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>No active keys yet.</div>}
        {devices && devices.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {devices.map((d) => (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {label(d)}{' '}
                    <span style={{ fontSize: 11, color: d.online ? '#4ade80' : '#999', fontWeight: 400 }}>
                      {d.online ? '● connected now' : '○ not connected'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: '#999' }}>
                    created {formatPkt(d.connectedAt)}
                    {d.expiresAt ? ` · expires ${formatPkt(d.expiresAt)}` : ''}
                    {d.lastSeenAt ? ` · last used ${formatPkt(d.lastSeenAt)}` : ' · not used yet'}
                  </div>
                </div>
                <InlineConfirm
                  label="Disconnect"
                  confirmLabel="Disconnect"
                  kind="danger"
                  consequence="This key stops working at once; Suzi on that computer needs a new key."
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

function label(d) {
  return d.keyPrefix ? `Key ${d.keyPrefix}…` : d.name;
}

function CopyRow({ label: text, value, mono = false, copied, onCopy }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>{text}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          readOnly
          value={value}
          aria-label={text}
          onClick={(e) => e.target.select()}
          style={{ fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? 13 : 14, padding: '8px 10px', minWidth: 320, flex: '1 1 320px' }}
        />
        <button className="settings-btn" onClick={onCopy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
