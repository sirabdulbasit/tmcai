import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import ChatPage from './pages/ChatPage';
import LoginPage from './pages/LoginPage';
import SettingsPage from './pages/SettingsPage';
import AdminPage from './pages/AdminPage';
import SetupPasswordPage from './pages/SetupPasswordPage';
import SchedulerPage from './pages/SchedulerPage';
import AgentsPage from './pages/AgentsPage';
import OpenItemsPage from './pages/OpenItemsPage';
import BrainConfigPage from './pages/BrainConfigPage';
import ConnectorsPage from './pages/ConnectorsPage';
import ConnectorGuidePage from './pages/ConnectorGuidePage';
import ThoughtPipelinePage from './pages/ThoughtPipelinePage';
import DayBriefPage from './pages/DayBriefPage';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function LoginRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading">Loading...</div>;
  if (user) return <Navigate to="/" replace />;
  return <LoginPage />;
}

export default function App() {
  return (
    <Routes>
      {/* Public — no auth needed, render immediately */}
      <Route path="/setup-password" element={<SetupPasswordPage />} />
      <Route path="/login" element={<LoginRoute />} />

      {/* Protected */}
      <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute><AdminPage /></ProtectedRoute>} />
      <Route path="/schedules" element={<ProtectedRoute><SchedulerPage /></ProtectedRoute>} />
      <Route path="/agents" element={<ProtectedRoute><AgentsPage /></ProtectedRoute>} />
      <Route path="/open-items" element={<ProtectedRoute><OpenItemsPage /></ProtectedRoute>} />
      <Route path="/brain" element={<ProtectedRoute><BrainConfigPage /></ProtectedRoute>} />
      <Route path="/connectors" element={<ProtectedRoute><ConnectorsPage /></ProtectedRoute>} />
      <Route path="/connector-guide" element={<ConnectorGuidePage />} />
      <Route path="/thoughts" element={<ProtectedRoute><ThoughtPipelinePage /></ProtectedRoute>} />
      <Route path="/day-brief" element={<ProtectedRoute><DayBriefPage /></ProtectedRoute>} />
      <Route path="/*" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
    </Routes>
  );
}
