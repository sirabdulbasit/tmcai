/**
 * Admin — Tenant WhatsApp Notifier (outbound).
 *
 * Inbound WhatsApp is per-user (Connectors tab). This page configures the
 * tenant-level sender Brain uses for mid-day pings.
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { Button, Field, Input, Card, Pill, Dot } from '../../components/ui';

export default function WhatsAppNotifierTab() {
  const [state, setState] = useState({ loading: true });
  const [form, setForm] = useState({
    displayNumber: '', phoneNumberId: '', accessToken: '', appId: '', wabaId: '',
  });
  const [test, setTest] = useState({ phone: '', msg: 'MyOS notifier test — ignore', userId: '' });
  const [msg, setMsg] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  // Webhook config state — separate from notifier credentials. The
  // verifyToken is shown plaintext ONCE right after generation so the
  // operator can copy it into Meta's webhook config UI; afterwards we
  // only show a masked preview (first 6 + last 4 chars).
  const [webhookSecret, setWebhookSecret] = useState(null);   // plaintext, transient
  const [generatingSecret, setGeneratingSecret] = useState(false);
  const [copied, setCopied] = useState(null);                  // which value just got copied

  const load = async () => {
    setState({ loading: true });
    try {
      const { data } = await api.get('/admin/whatsapp-notifier');
      setState({ loading: false, ...data });
      setForm({
        displayNumber: data.displayNumber ?? '',
        phoneNumberId: data.phoneNumberId ?? '',
        accessToken: '',
        appId: data.appId ?? '',
        wabaId: data.wabaId ?? '',
      });
    } catch (e) { setState({ loading: false, error: e?.response?.data?.error ?? e.message }); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setMsg(null);
    try {
      await api.put('/admin/whatsapp-notifier', form);
      setMsg({ ok: true, text: 'Saved. Run Verify to confirm credentials.' });
      load();
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const verify = async () => {
    setMsg(null);
    try {
      const { data } = await api.post('/admin/whatsapp-notifier/ping');
      setMsg({ ok: data.ok, text: data.ok ? `Verified: ${data.detail}` : `Failed: ${data.detail}` });
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const sendTest = async () => {
    setMsg(null);
    try {
      const { data } = await api.post('/admin/whatsapp-notifier/test', { toPhone: test.phone, body: test.msg });
      setMsg({ ok: data.ok, text: data.ok ? `Text sent (id: ${data.waMessageId})` : `Failed: ${data.error}` });
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const sendVoice = async () => {
    setMsg(null);
    try {
      const { data } = await api.post('/admin/whatsapp-notifier/test-voice', { toPhone: test.phone, body: test.msg });
      setMsg({ ok: data.ok, text: data.ok ? `Voice note sent (id: ${data.waMessageId})` : `Failed: ${data.error}` });
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const sendCallCta = async () => {
    setMsg(null);
    try {
      const { data } = await api.post('/admin/whatsapp-notifier/test-call-cta', { toPhone: test.phone, body: test.msg });
      setMsg({ ok: data.ok, text: data.ok ? `Call CTA sent (id: ${data.waMessageId})` : `Failed: ${data.error}` });
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const placeCall = async () => {
    setMsg(null);
    try {
      const { data } = await api.post('/admin/whatsapp-notifier/test-call', { toPhone: test.phone });
      if (data.ok) {
        setMsg({ ok: true, text: `Call placed (id: ${data.callId})` });
      } else if (data.notEnrolled) {
        setMsg({ ok: false, text: `Number not enrolled in WhatsApp Business Calling. Brain will fall back to the Call CTA in production.` });
      } else {
        setMsg({ ok: false, text: `Failed: ${data.error}` });
      }
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const sendViaBrain = async () => {
    setMsg(null);
    try {
      // Brain primitive routes by user, not phone — pick the user whose
      // contact_number / brain_channel.whatsappNumber matches `test.phone`.
      // Server-side resolution would be cleaner; for the admin tester we
      // accept a user id passed alongside the phone for clarity. Default
      // to user id 1 (the MD) when omitted.
      const toUserId = test.userId || 1;
      const { data } = await api.post('/admin/whatsapp-notifier/test-brain', {
        toUserId, body: test.msg, urgency: 'normal',
      });
      if (data.sent) {
        setMsg({ ok: true, text: `Brain → user delivered via ${data.channelsUsed?.join('+') ?? 'unknown'} (audit id: ${data.recordId}). Same path used by criticality alerts.` });
      } else {
        setMsg({ ok: false, text: `Brain primitive failed: ${data.reason} (audit id: ${data.recordId})` });
      }
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const toggleCalling = async (enabled) => {
    setMsg(null);
    try {
      await api.post('/admin/whatsapp-notifier/calling-enabled', { enabled });
      setMsg({ ok: true, text: `WhatsApp Business Calling ${enabled ? 'enabled' : 'disabled'} for this tenant.` });
      load();
    } catch (e) { setMsg({ ok: false, text: e?.response?.data?.error ?? e.message }); }
  };
  const disable = async () => {
    await api.post('/admin/whatsapp-notifier/disable');
    setConfirmDisable(false);
    load();
  };

  // Generate + store a fresh webhook verify token. Shown plaintext ONCE
  // — operator copies it, pastes into Meta's webhook config page, and
  // clicks "Verify and save" there. On any subsequent page reload we
  // only show the masked preview from the GET response.
  const generateWebhookSecret = async () => {
    setGeneratingSecret(true);
    setMsg(null);
    try {
      const { data } = await api.post('/admin/whatsapp-notifier/webhook-secret');
      setWebhookSecret(data.verifyToken);
      setMsg({
        ok: true,
        text: 'Webhook verify token generated. Copy it now, paste into Meta\'s webhook config — Meta only verifies if the token matches.',
      });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e?.response?.data?.error ?? e.message });
    } finally {
      setGeneratingSecret(false);
    }
  };

  const copyToClipboard = async (label, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // clipboard API may be blocked — show inline so operator can manual-select
      setMsg({ ok: false, text: 'Clipboard blocked — select the value manually and copy.' });
    }
  };

  return (
    <div>
      {/* Header + status live in the parent merged tab. This panel only
          renders the Meta-Cloud-specific configuration form + per-channel
          send testers. */}

      {state.configured ? (
        <Card style={{ marginTop: 'var(--s-5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
            <Dot status={state.isActive ? 'up' : 'down'} />
            <div>
              <div style={{ fontWeight: 'var(--fw-semibold)' }}>
                {state.displayNumber || '(no display number)'} <Pill variant={state.isActive ? 'success' : 'danger'}>{state.isActive ? 'active' : 'inactive'}</Pill>
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
                {state.hasToken ? 'Token stored (encrypted)' : 'No token stored'}
                {state.lastSendAt && ` · last send ${new Date(state.lastSendAt).toLocaleString()}`}
                {state.lastError && ` · last error: ${state.lastError.slice(0, 80)}`}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <Button variant="secondary" size="sm" onClick={verify}>Verify</Button>
            {confirmDisable ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Brain will fall back to legacy per-user adapter.</span>
                <Button variant="danger" size="sm" onClick={disable}>Yes, disable</Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDisable(false)}>Cancel</Button>
              </span>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirmDisable(true)}>Disable</Button>
            )}
          </div>
        </Card>
      ) : (
        <Card style={{ marginTop: 'var(--s-5)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Not configured. Fill the form below to enable mid-day WhatsApp messaging.</div>
        </Card>
      )}

      {msg && (
        <div style={{
          marginTop: 'var(--s-4)', padding: 'var(--s-3)',
          background: msg.ok ? 'var(--success-dim)' : 'var(--danger-dim)',
          color: msg.ok ? 'var(--success)' : 'var(--danger)',
          borderRadius: 'var(--r-md)',
        }}>{msg.text}</div>
      )}

      <h3 style={{ marginTop: 'var(--s-6) ', marginBottom: 'var(--s-3)', textTransform: 'uppercase', fontSize: 'var(--fs-md)', color: 'var(--accent)', letterSpacing: '.5px' }}>Credentials</h3>
      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
          <Field label="Display number (e.g. +92 333 123 4567)"><Input value={form.displayNumber} onChange={(e) => setForm({ ...form, displayNumber: e.target.value })} /></Field>
          <Field label="Phone Number ID (Meta)"><Input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} /></Field>
          <Field label="Access Token (system-user or permanent)" helper="Stored encrypted"><Input type="password" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} placeholder={state.hasToken ? '••• (existing; leave blank to keep)' : ''} /></Field>
          <Field label="App ID (optional)"><Input value={form.appId} onChange={(e) => setForm({ ...form, appId: e.target.value })} /></Field>
          <Field label="WABA ID (optional)"><Input value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-2)', justifyContent: 'flex-end', marginTop: 'var(--s-3)' }}>
          <Button variant="primary" onClick={save} disabled={!form.displayNumber || !form.phoneNumberId || (!form.accessToken && !state.hasToken)}>
            Save
          </Button>
        </div>
      </Card>

      {/* ── Webhook (inbound from Meta) ─────────────────────────────────
          The above credentials let Brain SEND. To RECEIVE incoming user
          messages, Meta needs a webhook URL + verify token. Both must
          match exactly between this page and the Meta dashboard. */}
      <h3 style={{ marginTop: 'var(--s-6)', marginBottom: 'var(--s-3)', textTransform: 'uppercase', fontSize: 'var(--fs-md)', color: 'var(--accent)', letterSpacing: '.5px' }}>
        Inbound webhook
      </h3>
      <Card>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 'var(--s-3)', lineHeight: 1.5 }}>
          Configure these two values on Meta's webhook page:&nbsp;
          <code style={{ color: 'var(--accent)' }}>WhatsApp → Configuration → Webhook</code>.
          The verify token must match what's stored here — Meta calls our endpoint with it
          to confirm we own the URL, then starts delivering incoming messages.
        </div>

        <Field label="Callback URL — paste this in Meta's webhook config" helper="Public endpoint Meta posts incoming messages to. Same value, every save.">
          <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
            <Input value={state.webhook?.callbackUrl ?? ''} readOnly style={{ flex: 1 }} />
            <Button variant="secondary" size="sm" onClick={() => copyToClipboard('callbackUrl', state.webhook?.callbackUrl ?? '')}>
              {copied === 'callbackUrl' ? '✓ Copied' : 'Copy'}
            </Button>
          </div>
        </Field>

        <div style={{ marginTop: 'var(--s-3)' }}>
          <Field
            label="Verify token — paste this in Meta's webhook config"
            helper={state.webhook?.hasSecret
              ? `Stored (preview: ${state.webhook.secretPreview}). Generate a new one to rotate — old one stops working immediately, you'll need to update Meta to match.`
              : 'No webhook secret yet. Click Generate to create one — you can copy it ONCE, then it\'s stored hashed.'}
          >
            {webhookSecret ? (
              // Plaintext shown only just after generation
              <div>
                <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
                  <Input value={webhookSecret} readOnly style={{ flex: 1, fontFamily: 'monospace' }} />
                  <Button variant="primary" size="sm" onClick={() => copyToClipboard('verifyToken', webhookSecret)}>
                    {copied === 'verifyToken' ? '✓ Copied' : 'Copy'}
                  </Button>
                </div>
                <div style={{ marginTop: 6, padding: 'var(--s-2)', background: 'var(--warning-dim, rgba(245,158,11,0.1))', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>
                  ⚠ Copy this NOW — once you leave this page, only a masked preview will be shown.
                  Paste into Meta's <code>Verify token</code> field, then click <code>Verify and save</code> there.
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
                <Input value={state.webhook?.secretPreview ?? '(none generated yet)'} readOnly style={{ flex: 1, fontFamily: 'monospace', color: 'var(--text-dim)' }} />
                <Button variant={state.webhook?.hasSecret ? 'secondary' : 'primary'} size="sm" onClick={generateWebhookSecret} disabled={generatingSecret}>
                  {generatingSecret ? 'Generating…' : (state.webhook?.hasSecret ? 'Rotate' : 'Generate')}
                </Button>
              </div>
            )}
          </Field>
        </div>

        <div style={{ marginTop: 'var(--s-4)', padding: 'var(--s-3)', background: 'var(--bg-1, #0d1117)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)', lineHeight: 1.7 }}>
          <div style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--accent)', marginBottom: 6 }}>Setup steps on Meta side (do these once)</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            <li>Click <b>Generate</b> above → copy the verify token</li>
            <li>In Meta developer console → your app → <b>WhatsApp → Configuration → Webhook</b></li>
            <li>Paste the <b>Callback URL</b> (above) into Meta's "Callback URL" field</li>
            <li>Paste the <b>Verify token</b> into Meta's "Verify token" field</li>
            <li>Click <b>Verify and save</b> in Meta — if green check, webhook is wired</li>
            <li>Subscribe to the <code>messages</code> webhook field (and <code>message_status</code> if you want delivery receipts)</li>
            <li>Test: send any message to your business number — should appear in <b>Brain Chat</b> within a few seconds</li>
          </ol>
        </div>
      </Card>

      {state.configured && (
        <>
          <h3 style={{ marginTop: 'var(--s-6)', marginBottom: 'var(--s-3)', textTransform: 'uppercase', fontSize: 'var(--fs-md)', color: 'var(--accent)', letterSpacing: '.5px' }}>Brain → user channels</h3>
          <Card>
            <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 'var(--s-3)', alignItems: 'end', marginBottom: 'var(--s-3)' }}>
              <Field label="To phone"><Input value={test.phone} onChange={(e) => setTest({ ...test, phone: e.target.value })} placeholder="+92…" /></Field>
              <Field label="Message body" helper="Used as text body, voice-note script, and call-CTA preamble">
                <Input value={test.msg} onChange={(e) => setTest({ ...test, msg: e.target.value })} />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', alignItems: 'center' }}>
              <Button variant="primary" size="sm" onClick={sendTest} disabled={!test.phone || !state.isActive}>
                📝 Send text (Notifier only)
              </Button>
              <Button variant="secondary" size="sm" onClick={sendVoice} disabled={!test.phone || !state.isActive}>
                🎤 Send voice note
              </Button>
              <Button variant="secondary" size="sm" onClick={sendCallCta} disabled={!test.phone || !state.isActive}>
                📞 Send call CTA
              </Button>
              <Button variant="secondary" size="sm" onClick={placeCall} disabled={!test.phone || !state.isActive || !state.callingEnabled}
                title={state.callingEnabled ? 'Initiate a WhatsApp Business call' : 'Enable WhatsApp Business Calling first'}>
                ☎️ Place call
              </Button>
              <div style={{ flex: 1 }} />
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                <input
                  type="checkbox"
                  checked={!!state.callingEnabled}
                  onChange={(e) => toggleCalling(e.target.checked)}
                />
                Calling API enabled
              </label>
            </div>
            <div style={{ marginTop: 'var(--s-3)', paddingTop: 'var(--s-3)', borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)', marginBottom: 6 }}>
                Brain → user (the path criticality alerts actually take)
              </div>
              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'end', flexWrap: 'wrap' }}>
                <Field label="User ID (recipient)">
                  <Input value={test.userId} onChange={(e) => setTest({ ...test, userId: e.target.value })} placeholder="1" style={{ width: 80 }} />
                </Field>
                <Button variant="primary" size="sm" onClick={sendViaBrain} disabled={!test.msg}>
                  🧠 Send via brainContactsUser
                </Button>
                <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', flex: 1, lineHeight: 1.5 }}>
                  Routes through the unified primitive: tries Meta Notifier first → falls back to legacy webjs when Meta is unconfigured. Records to <code>brain_user_messages</code> for audit. <strong>This is the exact path Brain takes for criticality alerts on email / calendar / open items.</strong>
                </span>
              </div>
            </div>
            <div style={{ marginTop: 'var(--s-3)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
              <strong>Text</strong>: instant Meta Cloud API send. <strong>Voice note</strong>: Google TTS → Meta /media → audio bubble (requires GOOGLE_APPLICATION_CREDENTIALS). <strong>Call CTA</strong>: text with the tenant display number rendered tap-to-call — works on every account today. <strong>Place call</strong>: WhatsApp Business Calling API (POST /calls) — requires Meta enrollment per number.
              {state.lastCallAt && <div style={{ marginTop: 6 }}>Last call attempt: {new Date(state.lastCallAt).toLocaleString()}{state.lastCallError && ` · error: ${String(state.lastCallError).slice(0, 80)}`}</div>}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
