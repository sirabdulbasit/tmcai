import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function SettingsPage() {
  const { user, logout, fontScale, appDefaultFontScale, fontScaleIsOverride, setFontScale, resetFontScaleToDefault } = useAuth();
  const navigate = useNavigate();
  // `gender` retired from UI 2026-05-18 (replaced by preferredTitle for
  // address tone). Field stays on the User model so legacy data is
  // preserved; just no longer surfaced in Settings.
  const [profile, setProfile] = useState({ city: '', contactNumber: '', aboutMe: '', instructions: '', preferredTitle: '' });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/profile').then(res => {
      const p = res.data.profile || {};
      setProfile({ city: p.city || '', contactNumber: p.contactNumber || '', aboutMe: p.aboutMe || '', instructions: p.instructions || '', preferredTitle: p.preferredTitle || '' });
    }).catch(() => {});
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    setMsg('');
    try {
      await api.put('/profile', profile);
      setMsg('Profile saved');
    } catch (err) {
      setMsg(err.response?.data?.error || 'Failed to save');
    }
    setSaving(false);
  };

  const changePassword = async () => {
    if (!passwords.currentPassword || !passwords.newPassword) return;
    setSaving(true);
    setMsg('');
    try {
      await api.post('/user/change-password', passwords);
      setMsg('Password changed');
      setPasswords({ currentPassword: '', newPassword: '' });
    } catch (err) {
      setMsg(err.response?.data?.error || 'Failed to change password');
    }
    setSaving(false);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const [intStatus, setIntStatus] = useState(null);

  useEffect(() => {
    api.get('/integration/status').then(r => setIntStatus(r.data)).catch(() => {});
  }, []);

  // Tone is auto-learned by AI from conversations — no manual setting needed

  const [tab, setTab] = useState('profile');
  const tabs = [
    { id: 'profile',    label: 'Profile' },
    { id: 'brain',      label: 'Brain' },
    { id: 'openItems',  label: 'Open Items' },
    { id: 'security',   label: 'Security' },
  ];

  return (
    <div className="settings-page">
      <div className="settings-container">
        <div className="settings-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1>Settings</h1>
          <a
            href="/welcome"
            onClick={(e) => { e.preventDefault(); window.location.assign('/welcome'); }}
            style={{
              fontSize: 12, color: 'var(--accent)', textDecoration: 'none',
              padding: '6px 12px', border: '1px solid var(--border)', borderRadius: 6,
              background: 'transparent', cursor: 'pointer',
            }}
            title="Re-open the new-user walkthrough"
          >
            👋 Walkthrough
          </a>
        </div>

        {msg && <div className={`settings-msg ${msg.includes('Failed') || msg.includes('incorrect') ? 'error' : ''}`}>{msg}</div>}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, borderBottom: '1px solid #333' }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '8px 14px', background: 'transparent', border: 0, cursor: 'pointer',
                color: tab === t.id ? '#cc6b4a' : '#888',
                borderBottom: tab === t.id ? '2px solid #cc6b4a' : '2px solid transparent',
                fontSize: 13, textTransform: 'uppercase', letterSpacing: '.5px',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'profile' && (
          <>
            {/* Account (read-only) */}
            <section className="settings-section">
              <h2>Account</h2>
              <div className="settings-info">
                <div><span className="info-label">Name</span><span>{user?.name}</span></div>
                <div><span className="info-label">Email</span><span>{user?.email}</span></div>
                <div><span className="info-label">Employee Code</span><span>{user?.empcode}</span></div>
                <div><span className="info-label">Department</span><span>{user?.department || '—'}</span></div>
                <div><span className="info-label">User Type</span><span className="badge-type">{user?.userType} — {user?.label}</span></div>
                <div><span className="info-label">Client</span><span>{user?.clientNumber}</span></div>
              </div>
            </section>

            {/* Job Description (read-only) */}
            {user?.jobDescription && (
              <section className="settings-section">
                <h2>Job Description</h2>
                <p className="settings-readonly">{user.jobDescription}</p>
              </section>
            )}

            {/* Brain name moved to Brain tab 2026-05-18 — it's a Brain
                configuration choice, not personal info. */}

            {/* Display — user-level font scale (inherits from organisation default).
                SuperAdmin also sees the organisation-wide default control below. */}
            <DisplaySection
              fontScale={fontScale}
              setFontScale={setFontScale}
              appDefaultFontScale={appDefaultFontScale}
              isOverride={fontScaleIsOverride}
              resetToDefault={resetFontScaleToDefault}
              isSuperAdmin={!!user?.isSuperAdmin}
            />

            {/* Context Brain knows about you — what the LLM reads to
                tailor outputs. Was "Personalization"; renamed 2026-05-18. */}
            <section className="settings-section">
              <h2>Context Brain knows about you</h2>
              <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
                Brain reads these when composing messages, drafting replies, or briefing your day.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="settings-field">
                  <label>City</label>
                  <input value={profile.city} onChange={e => setProfile(p => ({ ...p, city: e.target.value }))} placeholder="e.g. Karachi" />
                </div>
                <div className="settings-field">
                  <label>Contact number</label>
                  <input value={profile.contactNumber} onChange={e => setProfile(p => ({ ...p, contactNumber: e.target.value }))} placeholder="e.g. +92 300 1234567" />
                  <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                    Brain pings you here by default. Override on the Brain tab if you want a different number.
                  </div>
                </div>
              </div>
              <div className="settings-field">
                <label>How Brain should address you</label>
                <input value={profile.preferredTitle} onChange={e => setProfile(p => ({ ...p, preferredTitle: e.target.value }))} placeholder="e.g. Sir, Boss, Ma'am, or your first name" />
              </div>
              <div className="settings-field">
                <label>Background</label>
                <textarea rows={3} value={profile.aboutMe} onChange={e => setProfile(p => ({ ...p, aboutMe: e.target.value }))} placeholder="Tell Brain about yourself — role, working style, what you focus on day-to-day." />
              </div>
              <div className="settings-field">
                <label>Standing orders</label>
                <textarea rows={3} value={profile.instructions} onChange={e => setProfile(p => ({ ...p, instructions: e.target.value }))} placeholder="Preferences Brain should always follow — e.g. always flag project risks. Show amounts in PKR. Don't auto-acknowledge messages from external clients." />
              </div>
              <button className="settings-btn" onClick={saveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save Profile'}</button>
              <p style={{ fontSize: 11, color: '#666', marginTop: 8 }}>
                Tip: You can also update these by telling Brain — e.g. "I live in Karachi" or "remember my number is 0300-1234567"
              </p>
            </section>
          </>
        )}

        {tab === 'brain' && (
          <BrainChannelSection user={user} />
        )}

        {tab === 'openItems' && (
          <OpenItemsSection />
        )}

        {tab === 'security' && (
          <>
            <section className="settings-section">
              <h2>Change Password</h2>
              <div className="settings-field">
                <label>Current Password</label>
                <input type="password" value={passwords.currentPassword} onChange={e => setPasswords(p => ({ ...p, currentPassword: e.target.value }))} autoComplete="current-password" />
              </div>
              <div className="settings-field">
                <label>New Password</label>
                <input type="password" value={passwords.newPassword} onChange={e => setPasswords(p => ({ ...p, newPassword: e.target.value }))} autoComplete="new-password" />
              </div>
              <button className="settings-btn" onClick={changePassword} disabled={saving}>{saving ? 'Changing…' : 'Change Password'}</button>
            </section>

            <section className="settings-section">
              <h2>Sign out</h2>
              <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
                End this session on this device. You'll need to log in again to use Brain.
              </p>
              <button className="settings-btn danger" onClick={handleLogout}>Sign Out</button>
            </section>
          </>
        )}
      </div>
    </div>
  );
}


/**
 * BrainChannelSection — how Brain reaches you between Day Briefs.
 *
 * Brain is autonomous: it watches feeds, processes them, and most of the time
 * acts without interrupting you. But when it's uncertain about a mid-day
 * decision, it messages you on the channel configured here. WhatsApp is the
 * default (and usually best) choice for Abdul.
 */
function BrainChannelSection({ user }) {
  // Rewritten 2026-05-18 per user UX call:
  //   - Channel dropdown dropped (only WhatsApp; one-line note instead).
  //   - WhatsApp number defaults to registered contact number; only
  //     persists an override if the user explicitly enters one.
  //   - Numeric "Minimum confidence" replaced by a 3-mode boldness
  //     selector (cautious / balanced / eager). Backend derives the
  //     threshold for existing consumers.
  //   - Daily message cap dropped from UI (still a hard ceiling in code).
  //   - Trust statement moved to the top of the section.
  //   - "Send test ping" button verifies the channel without enabling
  //     the autonomous opt-in.
  //   - Brain naming (was on Profile) moved here as the first block.
  const [registeredNumber, setRegisteredNumber] = useState('');
  const [whatsappNumberOverride, setWhatsappNumberOverride] = useState('');
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('06:00');
  const [boldness, setBoldness] = useState('cautious');
  const [outboundEnabled, setOutboundEnabled] = useState(false);
  const [outboundPaused, setOutboundPaused] = useState(false);
  const [dayBriefTime, setDayBriefTime] = useState('08:30');
  const [timezone, setTimezone] = useState('Asia/Karachi');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [pingMsg, setPingMsg] = useState('');
  const [pinging, setPinging] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    api.get(`/profile/brain-channel`).then((r) => {
      const d = r.data || {};
      setRegisteredNumber(d.registeredContactNumber || user?.contactNumber || '');
      setWhatsappNumberOverride(d.whatsappNumber || '');
      setOverrideOpen(!!d.whatsappNumber);
      setQuietStart(d.quietStart || '22:00');
      setQuietEnd(d.quietEnd || '06:00');
      setBoldness(d.boldness || 'cautious');
      setOutboundEnabled(d.outboundEnabled === true);
      setOutboundPaused(!!d.outboundPaused);
      setDayBriefTime(d.dayBriefTime || '08:30');
      setTimezone(d.timezone || 'Asia/Karachi');
    }).catch(() => {
      setRegisteredNumber(user?.contactNumber || '');
    });
  }, [user?.id]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await api.put('/profile/brain-channel', {
        whatsappNumber: overrideOpen ? whatsappNumberOverride : '',
        quietStart, quietEnd,
        boldness,
        outboundEnabled,
        outboundPaused,
        dayBriefTime,
        timezone,
      });
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch (err) {
      setMsg(err?.response?.data?.error || 'Failed to save');
    }
    setSaving(false);
  };

  const sendTestPing = async () => {
    setPinging(true); setPingMsg('');
    try {
      await api.post('/profile/test-ping');
      setPingMsg('Sent — check your WhatsApp.');
      setTimeout(() => setPingMsg(''), 4000);
    } catch (err) {
      const reason = err?.response?.data?.reason || err?.response?.data?.error || 'send failed';
      setPingMsg(`Test ping failed: ${reason}`);
      setTimeout(() => setPingMsg(''), 6000);
    }
    setPinging(false);
  };

  const pingTarget = overrideOpen && whatsappNumberOverride ? whatsappNumberOverride : registeredNumber;

  return (
    <>
      <BrainNameSection />

      <section className="settings-section">
        <h2>Brain notifications</h2>
        <p style={{ color: '#888', fontSize: 13, marginTop: -4, marginBottom: 12 }}>
          Brain reaches you on WhatsApp via the company number. By default Brain runs silently and saves everything for the next Day Brief; only items above your boldness threshold ping you mid-day.
        </p>

        {/* Trust statement promoted to the top — the load-bearing
            reassurance, no longer buried inside the opt-in box. */}
        <div style={{
          padding: 12, marginBottom: 14,
          background: 'rgba(34,197,94,0.08)',
          border: '1px solid rgba(34,197,94,0.4)',
          borderRadius: 8,
          fontSize: 12, lineHeight: 1.5, color: '#d1fae5',
        }}>
          <strong style={{ color: '#86efac' }}>Brain never replies as you.</strong> Brain cannot send messages from your personal WhatsApp number to anyone — not your colleagues, not your contacts, not on heuristic, not ever. Your contacts only hear from you when you explicitly send.
        </div>

        {msg && <div className="settings-msg" style={{ marginBottom: 10 }}>{msg}</div>}

        <div className="settings-field">
          <label>WhatsApp number</label>
          {!overrideOpen ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#1f1f1f', border: '1px solid #333', borderRadius: 8 }}>
              <span style={{ flex: 1, color: '#eee', fontSize: 13 }}>
                Pinging on <strong>{registeredNumber || '(no number on file)'}</strong> <span style={{ color: '#666' }}>(your registered contact number)</span>
              </span>
              <button type="button" onClick={() => setOverrideOpen(true)}
                style={{ background: 'transparent', border: '1px solid #444', color: '#ccc', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
                Use different number
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                value={whatsappNumberOverride}
                onChange={(e) => setWhatsappNumberOverride(e.target.value)}
                placeholder={registeredNumber || '+92 300 1234567'}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={() => { setOverrideOpen(false); setWhatsappNumberOverride(''); }}
                style={{ background: 'transparent', border: '1px solid #444', color: '#ccc', borderRadius: 6, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>
                Use registered
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="settings-field">
            <label>Quiet hours start <span style={{ color: '#666', fontWeight: 400 }}>(your timezone)</span></label>
            <input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
          </div>
          <div className="settings-field">
            <label>Quiet hours end</label>
            <input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div className="settings-field">
            <label>Day Brief time</label>
            <input type="time" value={dayBriefTime} onChange={(e) => setDayBriefTime(e.target.value)} />
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              Brain sends the daily brief to WhatsApp at this time. Bypasses quiet hours.
            </div>
          </div>
          <div className="settings-field">
            <label>Timezone</label>
            <select value={timezone} onChange={(e) => setTimezone(e.target.value)}
                    style={{ width: '100%', padding: 8, background: '#2a2a2a', border: '1px solid #444', color: '#eee', borderRadius: 8, fontSize: 13 }}>
              <option value="Asia/Karachi">Asia/Karachi (PKT, UTC+5)</option>
              <option value="Asia/Dubai">Asia/Dubai (GST, UTC+4)</option>
              <option value="Asia/Riyadh">Asia/Riyadh (AST, UTC+3)</option>
              <option value="Europe/London">Europe/London (GMT/BST)</option>
              <option value="America/New_York">America/New_York (ET)</option>
              <option value="America/Los_Angeles">America/Los_Angeles (PT)</option>
              <option value="UTC">UTC</option>
            </select>
          </div>
        </div>

        <div className="settings-field">
          <label>How bold should Brain be?</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            {[
              { v: 'cautious', t: 'Cautious', d: 'Only ping for high-stakes items. Quiet by default.' },
              { v: 'balanced', t: 'Balanced', d: 'Ping when Brain is reasonably confident the item needs you today.' },
              { v: 'eager',    t: 'Eager',    d: 'Ping liberally. Best when you want maximum visibility and don\'t mind interruptions.' },
            ].map((o) => (
              <label key={o.v} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: 10,
                background: boldness === o.v ? 'rgba(204,107,74,0.12)' : '#1f1f1f',
                border: `1px solid ${boldness === o.v ? 'rgba(204,107,74,0.6)' : '#333'}`,
                borderRadius: 8, cursor: 'pointer',
              }}>
                <input type="radio" name="boldness" value={o.v} checked={boldness === o.v} onChange={() => setBoldness(o.v)} style={{ marginTop: 2 }} />
                <div>
                  <div style={{ color: boldness === o.v ? '#fbbf24' : '#eee', fontWeight: 600, fontSize: 13 }}>{o.t}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{o.d}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <h3 style={{ fontSize: 13, color: '#aaa', marginTop: 18, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.5px' }}>
          Opt-in
        </h3>

        <div className="settings-field" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: outboundEnabled ? 'rgba(34,197,94,0.10)' : '#1f1f1f', border: `1px solid ${outboundEnabled ? 'rgba(34,197,94,0.5)' : '#444'}`, borderRadius: 8 }}>
          <input type="checkbox" id="outboundEnabled" checked={outboundEnabled} onChange={(e) => setOutboundEnabled(e.target.checked)} style={{ width: 18, height: 18 }} />
          <label htmlFor="outboundEnabled" style={{ flex: 1, cursor: 'pointer', margin: 0 }}>
            <div style={{ color: outboundEnabled ? '#86efac' : '#eee', fontWeight: 600 }}>
              {outboundEnabled ? 'Brain may message me on WhatsApp' : 'Enable Brain to message me on WhatsApp'}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              When enabled, Brain pings you for items it judges substantive enough to interrupt your day. Default: <strong>off</strong> — Brain stays in Day Brief.
            </div>
          </label>
        </div>

        <div className="settings-field" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: outboundPaused ? 'rgba(239,68,68,0.10)' : '#1f1f1f', border: `1px solid ${outboundPaused ? 'rgba(239,68,68,0.5)' : '#333'}`, borderRadius: 8, marginTop: 8 }}>
          <input type="checkbox" id="outboundPaused" checked={outboundPaused} onChange={(e) => setOutboundPaused(e.target.checked)} style={{ width: 18, height: 18 }} />
          <label htmlFor="outboundPaused" style={{ flex: 1, cursor: 'pointer', margin: 0 }}>
            <div style={{ color: outboundPaused ? '#fca5a5' : '#eee', fontWeight: 600 }}>
              {outboundPaused ? 'Pause active — Brain is silent' : 'Temporarily pause (kill switch)'}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
              Hard kill switch on top of the opt-in. Use during meetings, evenings, weekends — flip off when you want Brain back.
            </div>
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
          <button className="settings-btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={sendTestPing} disabled={pinging || !pingTarget}
            style={{
              background: 'transparent', border: '1px solid #444', color: '#ccc',
              borderRadius: 8, padding: '8px 14px', fontSize: 13, cursor: pingTarget ? 'pointer' : 'not-allowed',
            }}>
            {pinging ? 'Sending…' : 'Send test ping'}
          </button>
          {pingMsg && <span style={{ fontSize: 12, color: pingMsg.startsWith('Sent') ? '#4ade80' : '#fca5a5' }}>{pingMsg}</span>}
        </div>
      </section>
    </>
  );
}

function BrainAutonomyThresholds() {
  const [cfg, setCfg] = useState({ occurrences: 10, agreement: 0.9 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/profile/brain-autonomy')
      .then((r) => setCfg({
        occurrences: Number(r.data?.occurrences) || 10,
        agreement: Number(r.data?.agreement) || 0.9,
      }))
      .catch(() => {});
  }, []);

  const persist = async (next) => {
    setCfg(next); setSaving(true);
    try { await api.put('/profile/brain-autonomy', next); } catch {}
    setSaving(false);
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ padding: 10, background: '#2a2a2a', border: '1px solid #333', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Same decision repeated N times</div>
          <div style={{ fontSize: 12, color: '#cc6b4a', fontWeight: 600 }}>
            {cfg.occurrences} time{cfg.occurrences === 1 ? '' : 's'}
          </div>
        </div>
        <input
          type="range" min="3" max="30" step="1"
          value={cfg.occurrences}
          onChange={(e) => persist({ ...cfg, occurrences: parseInt(e.target.value, 10) })}
          style={{ width: '100%', marginTop: 6, accentColor: '#cc6b4a' }}
        />
        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
          After you make the same decision this many times, Brain promotes the pattern so it can start handling it autonomously.
        </div>
      </div>
      <div style={{ padding: 10, background: '#2a2a2a', border: '1px solid #333', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Required consistency</div>
          <div style={{ fontSize: 12, color: '#cc6b4a', fontWeight: 600 }}>{Math.round(cfg.agreement * 100)}%</div>
        </div>
        <input
          type="range" min="0.7" max="1" step="0.01"
          value={cfg.agreement}
          onChange={(e) => persist({ ...cfg, agreement: parseFloat(e.target.value) })}
          style={{ width: '100%', marginTop: 6, accentColor: '#cc6b4a' }}
        />
        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
          Brain won't auto-promote a pattern where your choices were inconsistent. Raise this to be more cautious; lower to let Brain learn faster.
        </div>
      </div>
      {saving && <div style={{ fontSize: 11, color: '#888' }}>Saving…</div>}
    </div>
  );
}

function PerChannelThresholds() {
  const channels = [
    { key: 'email', label: 'Email (inbound replies)', defaultFloor: 0.88, note: 'Mix of formal + external — mistakes reach customers' },
    { key: 'whatsapp', label: 'WhatsApp', defaultFloor: 0.92, note: 'Informal, noisy — highest risk of misreading context' },
    { key: 'delegation', label: 'Delegation to team', defaultFloor: 0.75, note: 'Internal, stable patterns, low blast radius' },
    { key: 'calendar', label: 'Calendar (accept / decline / reschedule)', defaultFloor: 0.82, note: 'Medium — affects meetings with external people' },
  ];
  const [values, setValues] = useState({});

  useEffect(() => {
    api.get('/profile/brain-channel-thresholds')
      .then((r) => setValues(r.data || {}))
      .catch(() => setValues(Object.fromEntries(channels.map((c) => [c.key, c.defaultFloor]))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setVal = async (key, val) => {
    const updated = { ...values, [key]: val };
    setValues(updated);
    await api.put('/profile/brain-channel-thresholds', updated).catch(() => {});
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {channels.map((c) => {
        const v = values[c.key] ?? c.defaultFloor;
        return (
          <div key={c.key} style={{ padding: 10, background: '#2a2a2a', border: '1px solid #333', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{c.label}</div>
              <div style={{ fontSize: 12, color: '#cc6b4a', fontWeight: 600 }}>{Math.round(v * 100)}%</div>
            </div>
            <input
              type="range"
              min="0.5" max="1" step="0.01"
              value={v}
              onChange={(e) => setVal(c.key, parseFloat(e.target.value))}
              style={{ width: '100%', marginTop: 6, accentColor: '#cc6b4a' }}
            />
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>{c.note}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Rename your Brain — stored in users.notificationPreferences.brainName.
 *  Empty reverts to default "Brain". Applies immediately on next LLM call. */
function BrainNameSection() {
  const [name, setName] = useState('');
  const [current, setCurrent] = useState('Brain');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/profile/brain-name').then((r) => {
      setCurrent(r.data.name || 'Brain');
      setName(r.data.isCustom ? r.data.name : '');
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const { data } = await api.put('/profile/brain-name', { name });
      setCurrent(data.name);
      setMsg(`Saved. Call me ${data.name}.`);
      setTimeout(() => setMsg(''), 3000);
    } catch {
      setMsg('Failed to save.');
    }
    setSaving(false);
  };

  return (
    <section className="settings-section">
      <h2>🧠 Your Brain</h2>
      <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
        I'm <strong>{current}</strong> — your assistant. Give me a different name if you'd like; I'll answer to it everywhere.
      </p>
      <div className="settings-field">
        <label>What should I call me?</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Jeeves, Adel, Sidekick — or leave blank for Brain"
            maxLength={40}
            style={{ flex: 1 }}
          />
          <button className="settings-btn" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save name'}
          </button>
        </div>
        {msg && <div style={{ fontSize: 12, color: '#4ade80', marginTop: 6 }}>{msg}</div>}
      </div>
    </section>
  );
}

/** Per-user font scale control. Persists to notificationPreferences.ui.fontScale.
 *  Applies immediately via the --fs-scale CSS variable on :root, so every
 *  typographic token across the app scales. Clamped 0.85–1.4 server-side too.
 *  Inherits from the organisation default; "Reset to organisation default"
 *  removes the personal override.
 *
 *  For SuperAdmins, a second control is rendered below so they can set
 *  the organisation-wide default from Settings without having to navigate
 *  to Admin → Application Configuration. */
function DisplaySection({ fontScale, setFontScale, appDefaultFontScale, isOverride, resetToDefault, isSuperAdmin }) {
  const PRESETS = [
    { label: 'Small', value: 0.9 },
    { label: 'Normal', value: 1.0 },
    { label: 'Large', value: 1.15 },
    { label: 'XL', value: 1.3 },
  ];
  const current = Number(fontScale ?? 1);
  const clampedCurrent = Math.round(current * 100);
  const orgPct = Math.round(Number(appDefaultFontScale ?? 1) * 100);

  // SA-only: load + mutate the tenant default.
  const [appDefault, setAppDefault] = useState(Number(appDefaultFontScale ?? 1));
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultMsg, setDefaultMsg] = useState('');

  useEffect(() => { setAppDefault(Number(appDefaultFontScale ?? 1)); }, [appDefaultFontScale]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    api.get('/profile/app-defaults/font-scale').then((r) => {
      if (typeof r.data?.fontScale === 'number') setAppDefault(r.data.fontScale);
    }).catch(() => {});
  }, [isSuperAdmin]);

  const saveAppDefault = async (next) => {
    const clamped = Math.min(1.4, Math.max(0.85, Number(next) || 1));
    setSavingDefault(true); setDefaultMsg('');
    try {
      await api.put('/profile/app-defaults/font-scale', { fontScale: clamped });
      setAppDefault(clamped);
      setDefaultMsg(`Organisation default set to ${Math.round(clamped * 100)}%. Users without a personal override will see this size.`);
      setTimeout(() => setDefaultMsg(''), 4000);
    } catch (err) {
      setDefaultMsg(err.response?.data?.error || 'Failed to save');
    }
    setSavingDefault(false);
  };

  const appDefaultPct = Math.round(appDefault * 100);

  return (
    <section className="settings-section">
      <h2>Display</h2>
      <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
        Scale the interface text up or down. {isOverride
          ? <>You're using a personal override; organisation default is <strong>{orgPct}%</strong>.</>
          : <>You're using the organisation default (<strong>{orgPct}%</strong>).</>}
      </p>

      {/* Personal scale */}
      <div className="settings-field">
        <label>Your text size · {clampedCurrent}%{isOverride ? ' (personal)' : ' (org default)'}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="settings-btn" onClick={() => setFontScale(Math.max(0.85, current - 0.05))} disabled={current <= 0.85} title="Smaller">A−</button>
          <button className="settings-btn" onClick={() => setFontScale(Math.min(1.4, current + 0.05))} disabled={current >= 1.4} title="Larger">A+</button>
          <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 4px' }} />
          {PRESETS.map((p) => (
            <button
              key={p.value}
              className="settings-btn"
              onClick={() => setFontScale(p.value)}
              style={Math.abs(current - p.value) < 0.02 ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            >{p.label}</button>
          ))}
          {isOverride && (
            <>
              <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 4px' }} />
              <button className="settings-btn" onClick={resetToDefault} title="Revert to the organisation default">
                Reset to org default
              </button>
            </>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          Preview — this sentence resizes with your setting.
        </div>
      </div>

      {/* SA-only: app-wide default */}
      {isSuperAdmin && (
        <div className="settings-field" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px dashed var(--border)' }}>
          <label>
            🛡 Organisation default · {appDefaultPct}%
            <span style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(204,107,74,0.15)', color: 'var(--accent)', fontWeight: 600 }}>
              SA only
            </span>
          </label>
          <p style={{ fontSize: 12, color: '#666', marginTop: 2, marginBottom: 8 }}>
            Sets the default interface text size for every user in <strong>{/* tenant name omitted */}this tenant</strong>. Individual users can still set a personal override, which wins over this.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="settings-btn" onClick={() => saveAppDefault(Math.max(0.85, appDefault - 0.05))} disabled={savingDefault || appDefault <= 0.85} title="Smaller">A−</button>
            <button className="settings-btn" onClick={() => saveAppDefault(Math.min(1.4, appDefault + 0.05))} disabled={savingDefault || appDefault >= 1.4} title="Larger">A+</button>
            <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 4px' }} />
            {PRESETS.map((p) => (
              <button
                key={p.value}
                className="settings-btn"
                onClick={() => saveAppDefault(p.value)}
                disabled={savingDefault}
                style={Math.abs(appDefault - p.value) < 0.02 ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              >{p.label}</button>
            ))}
          </div>
          {defaultMsg && <div style={{ fontSize: 12, color: '#4ade80', marginTop: 8 }}>{defaultMsg}</div>}
        </div>
      )}
    </section>
  );
}

/**
 * OpenItemsSection — knobs for the open-items lifecycle.
 *
 * Three groups: lifecycle (follow-up cadence, archive, stale, DRAFT
 * expiry), auto-creation gating (which sources Brain may auto-create
 * from + the criticality floor), and purge (destructive — typed-phrase
 * confirmation per the no-browser-dialogs rule).
 *
 * What's NOT here on purpose: anything that asks the user to predict
 * a specific day or threshold. Brain decides "send today vs tomorrow";
 * the user decides "how often, max attempts, what's a stale item".
 */
function OpenItemsSection() {
  const [s, setS] = useState({
    followUpDays: 3,
    autoArchiveClosedAfterDays: 30,
    staleThresholdDays: 14,
    draftExpiryDays: 6,
    draftAskChannel: 'whatsapp',
    autoCreateFromEmail: true,
    autoCreateFromWhatsapp: true,
    autoCreateFromVoice: true,
    autoCreateCriticalityFloor: 'all',
    defaultSort: 'priority',
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/profile/open-items')
      .then((r) => setS((prev) => ({ ...prev, ...r.data })))
      .catch(() => {});
  }, []);

  const set = (k, v) => setS((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await api.put('/profile/open-items', s);
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch {
      setMsg('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="settings-section">
        <h2>Open Items — lifecycle</h2>
        <p style={{ fontSize: 12, color: '#888', marginTop: -6, marginBottom: 14 }}>
          How long items live, how often Brain chases delegations, when an item is
          considered stale.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="settings-field">
            <label>Follow-up cadence (days)</label>
            <input type="number" min="1" max="30" value={s.followUpDays}
                   onChange={(e) => set('followUpDays', parseInt(e.target.value, 10) || 3)} />
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              Default gap between delegation chase attempts. Brain may chase sooner
              or later based on signals (deadline, recipient activity) — this is the
              baseline.
            </div>
          </div>

          <div className="settings-field">
            <label>Auto-archive closed items after (days)</label>
            <input type="number" min="0" max="365" value={s.autoArchiveClosedAfterDays}
                   onChange={(e) => set('autoArchiveClosedAfterDays', parseInt(e.target.value, 10) || 0)} />
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              0 = never. Closed items stay searchable but stop appearing in /open-items
              + Day Brief after this many days.
            </div>
          </div>

          <div className="settings-field">
            <label>Stale threshold (days, 0 = off)</label>
            <input type="number" min="0" max="90" value={s.staleThresholdDays}
                   onChange={(e) => set('staleThresholdDays', parseInt(e.target.value, 10) || 0)} />
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              No activity for this many days → Brain surfaces "Is this still alive?"
              instead of letting it sit indefinitely.
            </div>
          </div>

          <div className="settings-field">
            <label>DRAFT expiry (days)</label>
            <input type="number" min="2" max="30" value={s.draftExpiryDays}
                   onChange={(e) => set('draftExpiryDays', parseInt(e.target.value, 10) || 6)} />
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              DRAFT items (missing priority or deadline) expire after N daily asks.
              Default 6 — Brain asks days 0–4, warns on day 5, closes day 6.
            </div>
          </div>

          <div className="settings-field">
            <label>DRAFT ask channel</label>
            <select value={s.draftAskChannel} onChange={(e) => set('draftAskChannel', e.target.value)}
                    style={{ width: '100%', padding: 8, background: '#2a2a2a', border: '1px solid #444', color: '#eee', borderRadius: 8, fontSize: 13 }}>
              <option value="whatsapp">WhatsApp only</option>
              <option value="email">Email only</option>
              <option value="both">Both</option>
            </select>
            <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
              Where Brain asks you to fill in missing priority/deadline.
            </div>
          </div>

          <div className="settings-field">
            <label>Default sort on /open-items</label>
            <select value={s.defaultSort} onChange={(e) => set('defaultSort', e.target.value)}
                    style={{ width: '100%', padding: 8, background: '#2a2a2a', border: '1px solid #444', color: '#eee', borderRadius: 8, fontSize: 13 }}>
              <option value="priority">Priority</option>
              <option value="deadline">Deadline</option>
              <option value="recent">Most recent activity</option>
              <option value="oldest">Oldest first</option>
            </select>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Auto-creation — which sources Brain may create items from</h2>
        <p style={{ fontSize: 12, color: '#888', marginTop: -6, marginBottom: 14 }}>
          When off, Brain still detects the item internally but parks it as a
          suggestion in Day Brief for one-tap accept instead of creating it live.
          Useful while you're earning trust on a source.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
          <input type="checkbox" checked={s.autoCreateFromEmail}
                 onChange={(e) => set('autoCreateFromEmail', e.target.checked)} />
          <span>Email</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
          <input type="checkbox" checked={s.autoCreateFromWhatsapp}
                 onChange={(e) => set('autoCreateFromWhatsapp', e.target.checked)} />
          <span>WhatsApp</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
          <input type="checkbox" checked={s.autoCreateFromVoice}
                 onChange={(e) => set('autoCreateFromVoice', e.target.checked)} />
          <span>Voice notes</span>
        </label>

        <div className="settings-field" style={{ marginTop: 14 }}>
          <label>Criticality floor for auto-create</label>
          <select value={s.autoCreateCriticalityFloor} onChange={(e) => set('autoCreateCriticalityFloor', e.target.value)}
                  style={{ width: '100%', padding: 8, background: '#2a2a2a', border: '1px solid #444', color: '#eee', borderRadius: 8, fontSize: 13 }}>
            <option value="all">All — auto-create at any criticality</option>
            <option value="medium">Medium and above</option>
            <option value="high">High and critical only</option>
          </select>
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            Brain's criticality call is LLM-judged from the message's substance.
            Below this floor, items become Day Brief suggestions instead of live items.
          </div>
        </div>
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <button className="settings-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
        {msg && <span style={{ fontSize: 12, color: msg === 'Saved' ? '#4ade80' : '#f87171' }}>{msg}</span>}
      </div>

      <PurgePanel />
    </>
  );
}

/**
 * PurgePanel — destructive cleanup with typed-phrase confirmation.
 *
 * Two-step: (1) user picks scope (closed / stale / expired-draft) and
 * hits Preview → server returns the count + the exact phrase the user
 * must type. (2) user types the phrase + hits Purge → server validates
 * both the phrase AND that the count still matches (so new items
 * arriving between preview and confirm can't get silently swept).
 *
 * No browser dialogs ([[feedback_no_browser_dialogs]]).
 */
function PurgePanel() {
  const [scope, setScope] = useState({ closed: false, stale: false, expiredDraft: false });
  const [preview, setPreview] = useState(null); // { count, phrase }
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState('');

  const togglesEmpty = !scope.closed && !scope.stale && !scope.expiredDraft;

  const runPreview = async () => {
    setWorking(true); setMsg(''); setPreview(null); setTyped('');
    try {
      const r = await api.post('/profile/open-items/purge/preview', { scope });
      setPreview(r.data);
      if (r.data.count === 0) setMsg('Nothing matches the selected scope.');
    } catch (e) {
      setMsg('Preview failed.');
    } finally {
      setWorking(false);
    }
  };

  const runPurge = async () => {
    if (!preview || preview.count === 0) return;
    setWorking(true); setMsg('');
    try {
      const r = await api.post('/profile/open-items/purge', { scope, phrase: typed });
      setMsg(`Purged ${r.data.deleted} item${r.data.deleted === 1 ? '' : 's'}.`);
      setPreview(null); setTyped('');
      setScope({ closed: false, stale: false, expiredDraft: false });
    } catch (e) {
      if (e.response?.status === 409) {
        setMsg(`Count changed — phrase should now be "${e.response.data.expectedPhrase}". Re-preview to confirm.`);
        setPreview(e.response.data ? { count: e.response.data.count, phrase: e.response.data.expectedPhrase } : null);
      } else {
        setMsg('Purge failed.');
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="settings-section" style={{ marginTop: 16, borderLeft: '3px solid #dc2626', paddingLeft: 12 }}>
      <h2 style={{ color: '#fca5a5' }}>Purge data — destructive</h2>
      <p style={{ fontSize: 12, color: '#888', marginTop: -6, marginBottom: 14 }}>
        Hard-deletes the selected open items. Cannot be undone. Pick a scope, hit
        Preview to see the count, then type the confirmation phrase exactly to fire.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
        <input type="checkbox" checked={scope.closed}
               onChange={(e) => { setScope({ ...scope, closed: e.target.checked }); setPreview(null); }} />
        <span>All closed items</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
        <input type="checkbox" checked={scope.expiredDraft}
               onChange={(e) => { setScope({ ...scope, expiredDraft: e.target.checked }); setPreview(null); }} />
        <span>Expired DRAFT items only</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0' }}>
        <input type="checkbox" checked={scope.stale}
               onChange={(e) => { setScope({ ...scope, stale: e.target.checked }); setPreview(null); }} />
        <span>Items marked stale</span>
      </label>

      <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="settings-btn" onClick={runPreview} disabled={working || togglesEmpty}>
          {working ? 'Working…' : 'Preview'}
        </button>

        {preview && preview.count > 0 && (
          <>
            <div style={{ fontSize: 13, color: '#fca5a5' }}>
              {preview.count} item{preview.count === 1 ? '' : 's'} will be deleted. Type{' '}
              <code style={{ background: '#2a2a2a', padding: '2px 6px', borderRadius: 4 }}>{preview.phrase}</code>{' '}
              to confirm.
            </div>
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)}
                   placeholder={preview.phrase}
                   style={{ flex: '1 1 240px', minWidth: 200, padding: 8, background: '#2a2a2a', border: '1px solid #dc2626', color: '#eee', borderRadius: 8, fontSize: 13, fontFamily: 'monospace' }} />
            <button className="settings-btn danger" onClick={runPurge}
                    disabled={working || typed !== preview.phrase}>
              {working ? 'Purging…' : 'Purge'}
            </button>
          </>
        )}
      </div>

      {msg && <div style={{ fontSize: 12, color: msg.startsWith('Purged') ? '#4ade80' : '#fca5a5', marginTop: 10 }}>{msg}</div>}
    </section>
  );
}
