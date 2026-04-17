import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [appName, setAppName] = useState('');
  const [aiName, setAiName] = useState('');
  const [logoUrl, setLogoUrl] = useState('/api/health/logo');
  const [loading, setLoading] = useState(true);

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
          // Fetch AI name from welcome endpoint
          api.get('/chat/welcome').then(w => {
            if (w.data?.aiName) setAiName(w.data.aiName);
          }).catch(() => {});
        }
      }).catch(() => {}),
    ]).finally(() => setLoading(false));
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
    <AuthContext.Provider value={{ user, appName, aiName, logoUrl, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
