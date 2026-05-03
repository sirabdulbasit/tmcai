import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Button, Field, Input } from '../components/ui';
import '../components/ui/ui.css';

/**
 * LoginPage — v2, design-token driven. Brand-tinted radial gradient behind
 * a centered card. Includes forgot-password inline flow.
 */
export default function LoginPage() {
  const { login, appName } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    maxWidth: 380,
    background: 'var(--bg-1)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-xl)',
    padding: 'var(--s-8)',
    boxShadow: 'var(--shadow-lg)',
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
          <LogoRow title="Reset password" sub="Enter your email to receive a reset link" />
          <form onSubmit={handleForgot}>
            {forgotMsg && (
              <div style={{ padding: 'var(--s-3)', background: 'var(--success-dim)', color: 'var(--success)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-4)' }}>
                {forgotMsg}
              </div>
            )}
            <Field label="Email">
              <Input type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} required autoFocus />
            </Field>
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
        <LogoRow title={appName || 'MyOS'} sub="Your personal AI intelligence" />
        <form onSubmit={handleSubmit}>
          {error && (
            <div style={{ padding: 'var(--s-3)', background: 'var(--danger-dim)', color: 'var(--danger)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--s-4)' }}>
              {error}
            </div>
          )}
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" variant="primary" block disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
          <div style={{ textAlign: 'right', marginTop: 'var(--s-3)' }}>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForgot(true)}>
              Forgot password?
            </Button>
          </div>
        </form>
        <div style={{ textAlign: 'center', marginTop: 'var(--s-6)', color: 'var(--text-dim)', fontSize: 'var(--fs-xs)' }}>
          By signing in you agree to the TMC terms.
        </div>
      </div>
    </div>
  );
}

function LogoRow({ title, sub }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', marginBottom: 'var(--s-6)' }}>
      <div style={{ width: 36, height: 36, background: 'linear-gradient(135deg, var(--accent), #8b3a1e)', borderRadius: 'var(--r-md)' }} />
      <div>
        <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-semibold)' }}>{title}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 2 }}>{sub}</div>
      </div>
    </div>
  );
}
