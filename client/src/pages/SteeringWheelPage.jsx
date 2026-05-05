import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import DayBriefPage from './DayBriefPage';
import OpenItemsPage from './OpenItemsPage';
import WikiPage from './WikiPage';
import HealthCheckTab from '../components/steering/HealthCheckTab';
// CustomActionTab removed from rail — its JSON-rule-builder UI was a
// developer surface and the API behind it had drifted (POST /shadow/rules
// now writes to a different table). Standing Instructions on My Rules
// covers user-facing rule creation in plain English.
import ConnectorsPage from './ConnectorsPage';
import MyRulesPage from './MyRulesPage';
import ContactsPage from './ContactsPage';
// ActionFormsPanel is no longer in the primary rail — file kept at
// components/steering/ActionForms.jsx and re-importable for admin/dev pages.
import SettingsPage from './SettingsPage';
import AdminPage from './AdminPage';
import HowBrainWorksPage from './HowBrainWorksPage';
import {
  AppShell, Canvas, Rail, RailLogo, RailSection, RailSpacer, RailButton,
  TopBar, TopBarTitle, TopBarSearch, TopBarUser, TopBarTenant,
} from '../components/ui';
import { Icon } from '../components/ui/Icon';
import FloatingChat from '../components/FloatingChat';

/**
 * SteeringWheelPage — MyOS main shell.
 * Left rail grouped into Work / Knowledge / Ops, top bar with search + tenant
 * + user, canvas renders the active tab's page.
 *
 * Multi-tenant SaaS: tenant pill + per-user greeting surfaced from AuthContext.
 */

// Brain-first ordering: Day Brief is the primary surface. Brain Query is a
// floating chat dock (always-available conversation), not a rail tab. Wiki is
// plumbing — reachable from Settings or inline citations, not the rail.
// TABS: the `admin` tab is appended at runtime only for admin users
// (Client Config + tenant WhatsApp Notifier + licences all live here).
const TABS = [
  { key: 'brief',     label: 'Day Brief',       icon: 'sun',      group: 'work',      render: () => <DayBriefPage /> },
  { key: 'center',    label: 'Action Center',   icon: 'grid',     group: 'work',      render: () => <OpenItemsPage /> },
  { key: 'contacts',  label: 'Contacts',        icon: 'users',    group: 'work',      render: () => <ContactsPage /> },
  { key: 'rules',     label: 'My Rules',        icon: 'zap',      group: 'work',      render: () => <MyRulesPage /> },
  { key: 'wiki',      label: 'Wiki',            icon: 'book',     group: 'knowledge', render: () => <WikiPage /> },
  { key: 'connectors',label: 'Connectors',      icon: 'external', group: 'knowledge', render: () => <ConnectorsPage /> },
  { key: 'health',    label: 'Health Check',    icon: 'pulse',    group: 'ops',       render: () => <HealthCheckTab /> },
  { key: 'how',       label: 'How Nexeo Works', icon: 'help',     group: 'ops',       render: () => <HowBrainWorksPage /> },
  { key: 'settings',  label: 'Settings',        icon: 'user',     group: 'ops',       render: () => <SettingsPage /> },
];
const ADMIN_TAB = { key: 'admin', label: 'Admin / Client Config', icon: 'settings', group: 'ops', render: () => <AdminPage /> };

export default function SteeringWheelPage() {
  const { user, appName, tenantName } = useAuth();
  const [active, setActive] = useState(() => {
    if (typeof window === 'undefined') return 'brief';
    return new URLSearchParams(window.location.search).get('tab') ?? 'brief';
  });

  const select = (key) => {
    setActive(key);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', key);
      window.history.replaceState({}, '', url);
    }
  };

  // Admin users get Client Config + WhatsApp Notifier + licences surfaced
  // as a rail tab. Everyone else never sees it — same access check AdminPage
  // enforces internally.
  const visibleTabs = user?.isAdmin ? [...TABS, ADMIN_TAB] : TABS;
  const tab = visibleTabs.find((t) => t.key === active) ?? visibleTabs[0];
  const groups = ['work', 'knowledge', 'ops'];
  const byGroup = Object.fromEntries(groups.map((g) => [g, visibleTabs.filter((t) => t.group === g)]));

  const userInitials = (user?.name || user?.email || 'U').slice(0, 2).toUpperCase();
  const firstName = user?.name?.split(' ')[0] ?? 'User';

  // Mobile rail drawer state. Off on desktop (CSS hides the hamburger).
  // Closes automatically on tab change so users don't have to dismiss it.
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => { setRailOpen(false); }, [active]);
  // Lock body scroll while drawer is open so content doesn't scroll behind.
  useEffect(() => {
    if (railOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [railOpen]);

  // Tap-on-rail-button on mobile: select the tab AND close the drawer.
  const railSelect = (key) => { select(key); setRailOpen(false); };

  return (
    <AppShell>
      {/* Mobile-only top bar with hamburger + active tab name. Hidden on
          desktop via CSS (.ui-mobile-topbar wrapped in @media query).
          On desktop, the standard TopBar inside Canvas is the chrome. */}
      <div className="ui-mobile-topbar">
        <button
          className="ui-mobile-hamburger"
          aria-label="Open menu"
          onClick={() => setRailOpen((o) => !o)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {railOpen ? (
              <g><line x1="6" y1="6" x2="18" y2="18" /><line x1="6" y1="18" x2="18" y2="6" /></g>
            ) : (
              <g><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></g>
            )}
          </svg>
        </button>
        <span className="ui-mobile-topbar-title">{tab.label}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {user?.clientNumber}
        </span>
      </div>

      {/* Backdrop: only renders/visible when drawer is open. */}
      <div
        className={`ui-rail-backdrop ${railOpen ? 'ui-rail-backdrop--open' : ''}`}
        onClick={() => setRailOpen(false)}
      />

      <Rail className={railOpen ? 'ui-rail--open' : ''}>
        <RailLogo src="/nexeo-logo.jpeg" onClick={() => railSelect('brief')} />
        {byGroup.work.map((t) => (
          <RailButton key={t.key} active={active === t.key} label={t.label} onClick={() => railSelect(t.key)}>
            <Icon name={t.icon} />
          </RailButton>
        ))}
        <div style={{ width: 24, height: 1, background: 'var(--border)', margin: '8px 0' }} />
        {byGroup.knowledge.map((t) => (
          <RailButton key={t.key} active={active === t.key} label={t.label} onClick={() => railSelect(t.key)}>
            <Icon name={t.icon} />
          </RailButton>
        ))}
        <RailSpacer />
        {byGroup.ops.map((t) => (
          <RailButton key={t.key} active={active === t.key} label={t.label} onClick={() => railSelect(t.key)}>
            <Icon name={t.icon} />
          </RailButton>
        ))}
      </Rail>
      <Canvas>
        <TopBar>
          <TopBarTitle>{tab.label}</TopBarTitle>
          <div style={{ flex: 1 }} />
          {user?.clientNumber && (
            <TopBarTenant title={user.clientNumber}>
              {tenantName || user.clientNumber}
            </TopBarTenant>
          )}
          <TopBarUser name={firstName} initials={userInitials} accent />
        </TopBar>
        {tab.render()}
      </Canvas>
      {/* Chat with Brain is a Day Brief affordance only — it lives where
          the MD is triaging, not on every tab. */}
      {active === 'brief' && <FloatingChat />}
    </AppShell>
  );
}
