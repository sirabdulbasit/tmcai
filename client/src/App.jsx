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
import BrainMemoryPage from './pages/BrainMemoryPage';
import ConnectorsPage from './pages/ConnectorsPage';
import ConnectorGuidePage from './pages/ConnectorGuidePage';
import ThoughtPipelinePage from './pages/ThoughtPipelinePage';
import DayBriefPage from './pages/DayBriefPage';
import SteeringWheelPage from './pages/SteeringWheelPage';
import ContactsPage from './pages/ContactsPage';
import ContactDetailPage from './pages/ContactDetailPage';
import HowBrainWorksPage from './pages/HowBrainWorksPage';
import WelcomePage from './pages/WelcomePage';
import StaleConnectorBanner from './components/StaleConnectorBanner';

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="app-loading">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  // BrainAvatar REMOVED FROM EVERY PAGE — owner, 2026-08-24: "remove it from all pages",
  // pointing at the "NEXEO IS THINKING · Reading your inbox and chats…" pill.
  //
  // It was `position: fixed` at `z-index: var(--z-toast)`, so it floated above whatever page
  // was underneath — in his screenshot it was covering the Build Pulse controls (Heal now,
  // Force, Pause, Now), i.e. an indicator of work obscuring the buttons that start the work.
  //
  // The component and its route are left intact, not deleted: it is only unmounted here. If a
  // thinking indicator is wanted again it belongs INSIDE the page that is thinking, next to
  // the thing being waited on, where it cannot cover a control — that is what
  // `ThinkingIndicator` does in the chat and `BrainWorking` does in the Day Brief, both of
  // which stay.
  //
  // StaleConnectorBanner — top-of-page warning for stale/errored
  // connectors. Renders only when something is wrong; invisible
  // otherwise. Loud-not-silent failure surface per the trust
  // architecture (was: users learning via Day Brief 6h later).
  return (
    <>
      <StaleConnectorBanner />
      {children}
    </>
  );
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
      <Route path="/brain/memory" element={<ProtectedRoute><BrainMemoryPage /></ProtectedRoute>} />
      <Route path="/connectors" element={<ProtectedRoute><ConnectorsPage /></ProtectedRoute>} />
      <Route path="/connector-guide" element={<ConnectorGuidePage />} />
      <Route path="/thoughts" element={<ProtectedRoute><ThoughtPipelinePage /></ProtectedRoute>} />
      <Route path="/day-brief" element={<ProtectedRoute><DayBriefPage /></ProtectedRoute>} />
      <Route path="/chat-legacy" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
      <Route path="/steering" element={<ProtectedRoute><SteeringWheelPage /></ProtectedRoute>} />
      <Route path="/contacts" element={<ProtectedRoute><ContactsPage /></ProtectedRoute>} />
      <Route path="/contacts/:id" element={<ProtectedRoute><ContactDetailPage /></ProtectedRoute>} />
      <Route path="/how-it-works" element={<ProtectedRoute><HowBrainWorksPage /></ProtectedRoute>} />
      <Route path="/welcome" element={<ProtectedRoute><WelcomePage /></ProtectedRoute>} />
      <Route path="/*" element={<ProtectedRoute><SteeringWheelPage /></ProtectedRoute>} />
    </Routes>
  );
}
