import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

export default function SettingsPage() {
  const { user, logout, fontScale, appDefaultFontScale, fontScaleIsOverride, setFontScale, resetFontScaleToDefault } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState({ city: '', contactNumber: '', aboutMe: '', instructions: '', gender: '', preferredTitle: '' });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/profile').then(res => {
      const p = res.data.profile || {};
      setProfile({ city: p.city || '', contactNumber: p.contactNumber || '', aboutMe: p.aboutMe || '', instructions: p.instructions || '', gender: p.gender || '', preferredTitle: p.preferredTitle || '' });
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
    { id: 'profile',  label: 'Profile' },
    { id: 'brain',    label: 'Brain' },
    { id: 'security', label: 'Security' },
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

            {/* Brain name */}
            <BrainNameSection />

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

            {/* Personalization */}
            <section className="settings-section">
              <h2>Personalization</h2>
              <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
                How Brain addresses you and what it knows about your working context.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="settings-field">
                  <label>City</label>
                  <input value={profile.city} onChange={e => setProfile(p => ({ ...p, city: e.target.value }))} placeholder="e.g. Karachi" />
                </div>
                <div className="settings-field">
                  <label>Contact Number</label>
                  <input value={profile.contactNumber} onChange={e => setProfile(p => ({ ...p, contactNumber: e.target.value }))} placeholder="e.g. +92 300 1234567" />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="settings-field">
                  <label>Gender</label>
                  <select value={profile.gender} onChange={e => setProfile(p => ({ ...p, gender: e.target.value }))} style={{ width: '100%', padding: '8px', background: '#2a2a2a', border: '1px solid #444', color: '#eee', borderRadius: 8, fontSize: 13 }}>
                    <option value="">— Select —</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label>How should Brain address you?</label>
                  <input value={profile.preferredTitle} onChange={e => setProfile(p => ({ ...p, preferredTitle: e.target.value }))} placeholder="e.g. Sir, Boss, Ma'am" />
                </div>
              </div>
              <div className="settings-field">
                <label>About Me</label>
                <textarea rows={3} value={profile.aboutMe} onChange={e => setProfile(p => ({ ...p, aboutMe: e.target.value }))} placeholder="Tell Brain about yourself — background, working style, what you focus on..." />
              </div>
              <div className="settings-field">
                <label>Custom Instructions</label>
                <textarea rows={3} value={profile.instructions} onChange={e => setProfile(p => ({ ...p, instructions: e.target.value }))} placeholder="e.g. Always flag project risks. Show amounts in PKR. Focus on delivery metrics." />
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
  const [channel, setChannel] = useState('whatsapp');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('06:00');
  const [minConfidence, setMinConfidence] = useState('0.7');
  const [outboundEnabled, setOutboundEnabled] = useState(false);  // opt-in default off
  const [outboundPaused, setOutboundPaused] = useState(false);
  const [dailyCap, setDailyCap] = useState('20');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!user?.id) return;
    api.get(`/profile/brain-channel`).then((r) => {
      const d = r.data || {};
      setChannel(d.channel || 'whatsapp');
      setWhatsappNumber(d.whatsappNumber || user?.contactNumber || '');
      setQuietStart(d.quietStart || '22:00');
      setQuietEnd(d.quietEnd || '06:00');
      setMinConfidence(String(d.minConfidence ?? 0.7));
      setOutboundEnabled(d.outboundEnabled === true);
      setOutboundPaused(!!d.outboundPaused);
      setDailyCap(String(d.dailyCap ?? 20));
    }).catch(() => {
      setWhatsappNumber(user?.contactNumber || '');
    });
  }, [user?.id]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      await api.put('/profile/brain-channel', {
        channel, whatsappNumber, quietStart, quietEnd,
        minConfidence: parseFloat(minConfidence),
        outboundEnabled,
        outboundPaused,
        dailyCap: parseInt(dailyCap, 10) || 20,
      });
      setMsg('Saved');
      setTimeout(() => setMsg(''), 2000);
    } catch (err) {
      setMsg(err?.response?.data?.error || 'Failed to save');
    }
    setSaving(false);
  };

  return (
    <section className="settings-section">
      <h2>Brain notifications</h2>
      <p style={{ color: '#888', fontSize: 13, marginTop: -4, marginBottom: 12 }}>
        How Brain reaches you between Day Briefs. By default Brain runs silently and saves everything for the next brief; only MEDIUM/HIGH-confidence decisions that need you mid-day ping you here.
      </p>
      {msg && <div className="settings-msg" style={{ marginBottom: 10 }}>{msg}</div>}

      <div className="settings-field">
        <label>Channel</label>
        <select value={channel} onChange={(e) => setChannel(e.target.value)}
                style={{ width: '100%', padding: 8, background: '#2a2a2a', border: '1px solid #444', color: '#eee', borderRadius: 8, fontSize: 13 }}>
          <option value="none">Silent — only Day Brief</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="email">Email</option>
          <option value="in_app">In-app only</option>
        </select>
      </div>

      {channel === 'whatsapp' && (
        <div className="settings-field">
          <label>WhatsApp number</label>
          <input value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value)}
                 placeholder="+92 300 1234567" />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div className="settings-field">
          <label>Quiet hours start</label>
          <input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
        </div>
        <div className="settings-field">
          <label>Quiet hours end</label>
          <input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
        </div>
      </div>

      <div className="settings-field">
        <label>Minimum confidence to ping (0.0 – 1.0)</label>
        <input type="number" step="0.05" min="0" max="1" value={minConfidence} onChange={(e) => setMinConfidence(e.target.value)} />
        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
          Below this, Brain saves it for Day Brief instead of messaging you.
        </div>
      </div>

      <h3 style={{ fontSize: 13, color: '#aaa', marginTop: 18, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.5px' }}>
        Brain → you on WhatsApp (opt-in)
      </h3>

      <div className="settings-field" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: outboundEnabled ? 'rgba(34,197,94,0.10)' : '#1f1f1f', border: `1px solid ${outboundEnabled ? 'rgba(34,197,94,0.5)' : '#444'}`, borderRadius: 8 }}>
        <input type="checkbox" id="outboundEnabled" checked={outboundEnabled} onChange={(e) => setOutboundEnabled(e.target.checked)} style={{ width: 18, height: 18 }} />
        <label htmlFor="outboundEnabled" style={{ flex: 1, cursor: 'pointer', margin: 0 }}>
          <div style={{ color: outboundEnabled ? '#86efac' : '#eee', fontWeight: 600 }}>
            {outboundEnabled ? 'Brain may message me on WhatsApp' : 'Enable Brain to message me on WhatsApp'}
          </div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 2, lineHeight: 1.5 }}>
            When enabled, Brain pings you from the company's WhatsApp Business number for items it judges substantive enough to interrupt your day. Default: <strong>off</strong> — Brain stays in Day Brief / email.
            <br /><br />
            <strong style={{ color: '#86efac' }}>Brain never replies as you.</strong> Brain has no path to send messages from your personal WhatsApp number to anyone — not your colleagues, not your contacts, not on heuristic, not ever. Your contacts only ever hear from you when you explicitly send.
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
            On top of the opt-in: a hard kill switch. When checked, Brain sends nothing to your WhatsApp regardless of the toggle above. Use during meetings, evenings, weekends — flip off when you want Brain back.
          </div>
        </label>
      </div>

      <div className="settings-field">
        <label>Daily message cap</label>
        <input type="number" min="1" max="200" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
          Hard ceiling on outbound from Brain in any 24h window. Even a runaway bug can never exceed this. Default 20.
        </div>
      </div>

      <h3 style={{ fontSize: 13, color: '#aaa', marginTop: 18, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.5px' }}>
        Per-channel autonomy
      </h3>
      <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
        Brain auto-sends when its confidence is above this threshold. Below it, Brain drafts and surfaces in Day Brief. Every action you take trains the Brain.
      </p>
      <PerChannelThresholds />

      <h3 style={{ fontSize: 13, color: '#aaa', marginTop: 18, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '.5px' }}>
        Learning threshold
      </h3>
      <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
        How many times you have to make the same decision before Brain starts doing it on its own. Every autonomous action is always listed in the "Brief" section of Day Brief so you can review what Brain did.
      </p>
      <BrainAutonomyThresholds />

      <button className="settings-btn" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </section>
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
