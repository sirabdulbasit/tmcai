import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';

const AuthContext = createContext(null);

// Apply the user's chosen font scale to :root as --fs-scale. Persisted in
// the user's notificationPreferences.ui.fontScale via /profile/ui-prefs.
function applyFontScale(scale) {
  const s = typeof scale === 'number' && isFinite(scale) ? scale : 1;
  document.documentElement.style.setProperty('--fs-scale', String(s));
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [appName, setAppName] = useState('');
  const [aiName, setAiName] = useState('');
  // Tenant display name (Tenant.name from the DB) — used by Contacts /
  // Wiki / etc. to label tenant-shared content with a friendly company
  // name instead of the system word "Tenant" or raw clientNumber.
  const [tenantName, setTenantName] = useState('');
  const [logoUrl, setLogoUrl] = useState('/api/health/logo');
  const [loading, setLoading] = useState(true);
  const [fontScale, setFontScaleState] = useState(1);
  const [appDefaultFontScale, setAppDefaultFontScale] = useState(1);
  const [fontScaleIsOverride, setFontScaleIsOverride] = useState(false);

  useEffect(() => {
    // Fetch app name + check session in parallel
    Promise.all([
      api.get('/health/app-info').then(r => {
        const name = r.data.appName || '';
        setAppName(name);
        if (name) document.title = name;
      }).catch(() => {}),
      api.get('/user/me').then(r => {
        if (r.data?.user) {
          setUser(r.data.user);
          // tenant.name is the company display name (e.g. "TMC Pvt Ltd").
          // Falls back to the clientNumber when no name is configured.
          if (r.data.tenant?.name) setTenantName(r.data.tenant.name);
          else if (r.data.tenant?.clientNumber) setTenantName(r.data.tenant.clientNumber);
          // Fetch AI name from welcome endpoint
          api.get('/chat/welcome').then(w => {
            if (w.data?.aiName) setAiName(w.data.aiName);
          }).catch(() => {});
          // Per-user UI prefs (font scale). Applied immediately so every
          // screen renders at the user's chosen size from first paint.
          // Response now includes { fontScale, userOverride, appDefault }
          // — fontScale is already the effective merged value.
          api.get('/profile/ui-prefs').then(u => {
            const s = u.data?.fontScale ?? 1;
            setFontScaleState(s);
            setAppDefaultFontScale(u.data?.appDefault ?? 1);
            setFontScaleIsOverride(u.data?.userOverride != null);
            applyFontScale(s);
          }).catch(() => {});
        }
      }).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const setFontScale = useCallback(async (next) => {
    const clamped = Math.min(1.4, Math.max(0.85, Number(next) || 1));
    setFontScaleState(clamped);
    setFontScaleIsOverride(true);
    applyFontScale(clamped);
    // Persist; swallow network errors (user still sees the change locally).
    api.put('/profile/ui-prefs', { fontScale: clamped }).catch(() => {});
  }, []);

  const resetFontScaleToDefault = useCallback(async () => {
    try {
      const { data } = await api.put('/profile/ui-prefs', { fontScale: null });
      const s = data?.fontScale ?? 1;
      setFontScaleState(s);
      setFontScaleIsOverride(false);
      setAppDefaultFontScale(data?.appDefault ?? s);
      applyFontScale(s);
    } catch { /* keep local state if network fails */ }
  }, []);

  const login = useCallback(async (email, password) => {
    // Support both email and empcode login
    const isEmail = email.includes('@');
    const payload = isEmail ? { email, password } : { empcode: email, password };
    const res = await api.post('/user/login', payload);
    setUser(res.data.user);
    return res.data;
  }, []);

  const logout = useCallback(async () => {
    await api.post('/user/logout').catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, appName, aiName, tenantName, logoUrl, loading, login, logout,
      fontScale, appDefaultFontScale, fontScaleIsOverride,
      setFontScale, resetFontScaleToDefault,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
