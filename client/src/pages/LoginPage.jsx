import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Button } from '../components/ui';
import '../components/ui/ui.css';

/**
 * LoginPage — Nexeo brand. Inline-SVG mark in the accent palette, icon-affixed
 * inputs with a password reveal toggle, soft-glow card.
 */
export default function LoginPage() {
  const { login, appName } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState('');
  const [forgotSending, setForgotSending] = useState(false);

  const wrapStyle = {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'radial-gradient(ellipse at top, #1a1416 0%, var(--bg-0) 60%)',
    padding: 'var(--s-5)',
  };
  const cardStyle = {
    width: '100%',
    maxWidth: 420,
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)',
    padding: 'var(--s-8)',
    boxShadow:
      '0 0 0 1px rgba(214, 109, 60, 0.08), 0 34px 160px 52px rgba(214, 109, 60, 0.18), var(--shadow-lg)',
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgot = async (e) => {
    e.preventDefault();
    if (!forgotEmail) return;
    setForgotSending(true);
    setForgotMsg('');
    try {
      const res = await api.post('/user/forgot-password', { email: forgotEmail, baseUrl: window.location.origin });
      setForgotMsg(res.data.message || 'If an account exists with that email, a reset link has been sent.');
    } catch {
      setForgotMsg('If an account exists with that email, a reset link has been sent.');
    }
    setForgotSending(false);
  };

  if (showForgot) {
    return (
      <div style={wrapStyle}>
        <div style={cardStyle}>
          <Brand title="Reset password" sub="Enter your email to receive a reset link" />
          <form onSubmit={handleForgot}>
            {forgotMsg && (
              <div style={{ padding: 'var(--s-3)', background: 'var(--success-dim)', color: 'var(--success)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-4)' }}>
                {forgotMsg}
              </div>
            )}
            <IconField label="Email" icon={<MailIcon />}>
              <input
                type="email"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                required
                autoFocus
                placeholder="you@example.com"
                className="ui-input"
                style={{ paddingLeft: 40 }}
              />
            </IconField>
            <Button type="submit" variant="primary" block disabled={forgotSending || !forgotEmail}>
              {forgotSending ? 'Sending…' : 'Send reset link'}
            </Button>
            <div style={{ textAlign: 'center', marginTop: 'var(--s-4)' }}>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setShowForgot(false); setForgotMsg(''); }}>
                ← Back to sign in
              </Button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <div style={cardStyle}>
        <Brand title={appName || 'Nexeo'} sub="Your personal AI intelligence" />
        <form onSubmit={handleSubmit}>
          {error && (
            <div style={{ padding: 'var(--s-3)', background: 'var(--danger-dim)', color: 'var(--danger)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-4)' }}>
              {error}
            </div>
          )}
          <IconField label="Email" icon={<MailIcon />}>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              placeholder="you@example.com"
              className="ui-input"
              style={{ paddingLeft: 40 }}
            />
          </IconField>
          <IconField
            label="Password"
            icon={<LockIcon />}
            suffix={
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                style={{
                  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                  background: 'transparent', border: 0, cursor: 'pointer', padding: 6,
                  color: 'var(--text-muted)', display: 'flex', alignItems: 'center',
                }}
              >
                {showPw ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            }
          >
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Enter your password"
              className="ui-input"
              style={{ paddingLeft: 40, paddingRight: 40 }}
            />
          </IconField>
          <Button type="submit" variant="primary" block disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
          <div style={{ textAlign: 'right', marginTop: 'var(--s-3)' }}>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForgot(true)}>
              Forgot password?
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ───────── Brand mark ───────── */

function Brand({ title, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)', marginBottom: 'var(--s-7)' }}>
      <NexeoMark size={64} />
      <div>
        <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 'var(--fw-semibold)', letterSpacing: -0.4 }}>{title}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>{sub}</div>
      </div>
    </div>
  );
}

/**
 * Inline-SVG Nexeo mark — rounded tile with a stylised brain + integrated "N",
 * tinted by the brand accent. No raster, no background, scales cleanly.
 */
function NexeoMark({ size = 64 }) {
  const id = 'nexeo-grad';
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-label="Nexeo">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f0a574" />
          <stop offset="1" stopColor="#c1542a" />
        </linearGradient>
        <radialGradient id="nexeo-glow" cx="32" cy="32" r="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#d66d3c" stopOpacity="0.35" />
          <stop offset="1" stopColor="#d66d3c" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* tile */}
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#1a1416" stroke={`url(#${id})`} strokeWidth="1.25" />
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#nexeo-glow)" />
      {/* brain outline (left lobe) */}
      <g stroke={`url(#${id})`} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M22 22c-3 0-5 2-5 5 0 1.4.6 2.6 1.5 3.4-1 .9-1.5 2.1-1.5 3.6 0 2 1.4 3.7 3.3 4.3-.2.5-.3 1.1-.3 1.7 0 2.5 2 4.5 4.5 4.5h2.5V20.5C24 20.5 22 21 22 22z" />
        <path d="M27 28h-3M27 34h-4M27 40h-3" />
      </g>
      {/* N letterform — integrated on the right side of the brain */}
      <path
        d="M34 44V22l10 14V22"
        stroke={`url(#${id})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* accent nodes */}
      <circle cx="22" cy="22" r="1.6" fill="#f0a574" />
      <circle cx="22" cy="44.5" r="1.6" fill="#c1542a" />
      <circle cx="44" cy="22" r="1.6" fill="#f0a574" />
    </svg>
  );
}

/* ───────── Field with icon prefix/suffix ───────── */

function IconField({ label, icon, suffix, children }) {
  return (
    <div className="ui-field">
      {label && <label className="ui-label">{label}</label>}
      <div style={{ position: 'relative' }}>
        <span
          aria-hidden
          style={{
            position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--text-muted)', display: 'flex', alignItems: 'center', pointerEvents: 'none',
          }}
        >
          {icon}
        </span>
        {children}
        {suffix}
      </div>
    </div>
  );
}

/* ───────── Inline icons ───────── */

const ICON_PROPS = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' };

function MailIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}
function LockIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A9.7 9.7 0 0 1 12 6c6.5 0 10 6 10 6a13.3 13.3 0 0 1-2.7 3.5M6.6 6.6A13.4 13.4 0 0 0 2 12s3.5 6 10 6c1.6 0 3-.4 4.3-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}
