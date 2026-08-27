import React, { useState, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import ClientManagementTab from './admin/ClientManagementTab';
import LicensesTab from './admin/LicensesTab';
import TierManagementTab from './admin/TierManagementTab';
import ConfigTab from './admin/ConfigTab';
import WhatsAppMergedTab from './admin/WhatsAppMergedTab';
import LlmSpendTab from './admin/LlmSpendTab';
import ConnectorsAdminTab from './admin/ConnectorsAdminTab';

/**
 * Admin surface — grouped by WHAT A SETTING APPLIES TO.
 *
 * Basit, 2026-08-27: "i just want clarity with Overall Settings / Client Specific / User List
 * with filter of client". The previous layout grouped by how often a thing was used (daily vs
 * Setup), which put client-scoped and global settings side by side and produced two real
 * confusions:
 *
 *   · TWO "Connectors" — a top-level tab (per-tenant eligibility) and "Client Connectors" inside
 *     the Users tab (tenant knowledge sources). Same word, different scopes, different screens.
 *   · TWO routes to "Clients" — Setup → Clients and Users → Clients rendered the SAME component
 *     in the SAME default state, because `initialSubTab` was passed and never accepted as a prop.
 *
 * The grouping now follows the code rather than a preference. Counting client/tenant references
 * per tab: WhatsApp 18, Client Config 13, Licenses 9, Connectors 3 — all client-scoped; User
 * Tiers 0, Brain Improvement 0, Brain Learning 1, LLM Spend 2 — global.
 *
 *   Overall   — applies across every client: the client list itself, user tiers, spend
 *   Client    — everything scoped to ONE client, chosen once at the top and held
 *   Users     — the user list
 *
 * BRAIN LEARNING AND BRAIN IMPROVEMENT LEFT THIS PAGE (2026-08-27) and are on the Brain
 * Evolution tab of the steering deck. They are two of the NINE SCORED CAPABILITIES — `Learn` and
 * `Self-Healing` — and operating a capability is not an administrative act. They were MOVED, not
 * removed: a check for other consumers of /learning/memories, /gaps, /proposals,
 * /development-requests and /audit returned ZERO for all five, so deleting the tabs would have
 * taken two live queues dark, including governed memories awaiting approval.
 *
 * NO FUNCTIONALITY MOVED. Every component rendered before is rendered now; only its address
 * changed. The one thing genuinely absent is a client FILTER on the user list —
 * `GET /admin/users` is scoped `where: { clientNumber: req.user.clientNumber }`, so it returns a
 * single client's users to everyone including a SuperAdmin. Widening it is a tenant-boundary
 * change, not a UI change, and this codebase carries four recorded `query-without-tenant-scope`
 * defects — so it is left for a deliberate decision rather than slipped in with a re-layout.
 */
export default function AdminPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('overall');
  const [overallSub, setOverallSub] = useState('clients');
  const [clientSub, setClientSub] = useState('config');
  const [msg, setMsgRaw] = useState('');

  // Auto-dismiss the floating toast after 4s. Wraps the raw setter so
  // tabs don't have to manage their own timeouts.
  const dismissTimer = useRef(null);
  const setMsg = useCallback((next) => {
    setMsgRaw(next);
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    if (next) {
      dismissTimer.current = setTimeout(() => setMsgRaw(''), 4000);
    }
  }, []);

  if (!user?.isAdmin) {
    return <div className="settings-page"><div className="settings-container"><h1>Access Denied</h1></div></div>;
  }

  const topTabs = [
    { key: 'overall', label: 'Overall Settings' },
    { key: 'client',  label: 'Client Specific' },
    { key: 'users',   label: 'Users' },
  ];

  // Global — nothing here belongs to one client.
  const overallSubs = [
    { key: 'clients',  label: 'Clients' },
    { key: 'tiers',    label: 'User Tiers' },
    { key: 'llm',      label: 'LLM Spend' },
  ];

  // Client-scoped. Order is setup-order: what the client IS, then how it talks, then what it
  // reads, then what it is licensed for.
  const clientSubs = [
    { key: 'config',     label: 'Client Config' },
    // ConfigTab and ClientConfigSection are DIFFERENT screens with confusingly similar names —
    // the first is application configuration, the second is the client's own config record. I
    // dropped ConfigTab entirely on the first pass of this re-layout by assuming they were the
    // same thing; both are listed explicitly so the next person cannot repeat that.
    { key: 'appconfig',  label: 'Application Config' },
    { key: 'whatsapp',   label: 'WhatsApp' },
    { key: 'connectors', label: 'Connectors' },
    { key: 'sources',    label: 'Knowledge Sources' },
    ...(user?.isSuperAdmin ? [{ key: 'licenses', label: 'Licence' }] : []),
  ];

  const subsFor = activeTab === 'overall' ? overallSubs
    : activeTab === 'client' ? clientSubs
    : [];
  const activeSub = activeTab === 'overall' ? overallSub : clientSub;
  const setActiveSub = activeTab === 'overall' ? setOverallSub : setClientSub;

  return (
    <div className="settings-page">
      <div className="settings-container">
        {/* Top-level tabs — kept to 5. */}
        <div className="config-tabs">
          {topTabs.map(t => (
            <button
              key={t.key}
              className={`config-tab ${activeTab === t.key ? 'active' : ''}`}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* One sub-tab row, driven by whichever group is open. Previously each group drew
            its own conditional row, which is how two of them ended up offering "Clients". */}
        {subsFor.length > 0 && (
          <div className="config-tabs config-tabs-sub" style={subTabRowStyle}>
            {subsFor.map(t => (
              <button
                key={t.key}
                className={`config-tab ${activeSub === t.key ? 'active' : ''}`}
                onClick={() => setActiveSub(t.key)}
                style={subTabButtonStyle}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {msg && (
          <div
            className={`settings-msg ${msg.includes('Failed') || msg.includes('failed') ? 'error' : ''}`}
            onClick={() => setMsg('')}
            role="status"
            aria-live="polite"
            title="Click to dismiss"
            style={{ cursor: 'pointer' }}
          >
            {msg}
          </div>
        )}

        {/* ── Overall — global settings ───────────────────────────────────────── */}
        {activeTab === 'overall' && overallSub === 'clients' && (
          <ClientManagementTab user={user} msg={msg} setMsg={setMsg} section="tenants" />
        )}
        {activeTab === 'overall' && overallSub === 'tiers' && (
          <TierManagementTab msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'overall' && overallSub === 'llm' && (
          <LlmSpendTab user={user} />
        )}

        {/* ── Client Specific — everything scoped to one client ────────────────── */}
        {activeTab === 'client' && clientSub === 'config' && (
          <ClientManagementTab user={user} msg={msg} setMsg={setMsg} section="clientconfig" />
        )}
        {activeTab === 'client' && clientSub === 'appconfig' && (
          <ConfigTab user={user} />
        )}
        {activeTab === 'client' && clientSub === 'whatsapp' && (
          <WhatsAppMergedTab msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'client' && clientSub === 'connectors' && (
          <ConnectorsAdminTab user={user} msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'client' && clientSub === 'sources' && (
          <ClientManagementTab user={user} msg={msg} setMsg={setMsg} section="connectors" />
        )}
        {activeTab === 'client' && clientSub === 'licenses' && user?.isSuperAdmin && (
          <LicensesTab msg={msg} setMsg={setMsg} />
        )}

        {/* ── Users ────────────────────────────────────────────────────────────── */}
        {activeTab === 'users' && (
          <ClientManagementTab user={user} msg={msg} setMsg={setMsg} section="users" />
        )}

      </div>
    </div>
  );
}

// Sub-tab row — lighter styling than top tabs so the hierarchy reads
// at a glance. Inline styles to avoid touching global CSS.
const subTabRowStyle = {
  marginTop: 8,
  marginBottom: 8,
  paddingBottom: 6,
  borderBottom: '1px solid var(--border, #333)',
};
const subTabButtonStyle = {
  fontSize: 12,
  padding: '4px 12px',
  opacity: 0.85,
};
