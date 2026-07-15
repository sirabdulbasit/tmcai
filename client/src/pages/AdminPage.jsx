import React, { useState, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import ClientManagementTab from './admin/ClientManagementTab';
import LicensesTab from './admin/LicensesTab';
import TierManagementTab from './admin/TierManagementTab';
import ConfigTab from './admin/ConfigTab';
import WhatsAppMergedTab from './admin/WhatsAppMergedTab';
import LlmSpendTab from './admin/LlmSpendTab';
import ConnectorsAdminTab from './admin/ConnectorsAdminTab';
import BrainLearningTab from './admin/BrainLearningTab';
import BrainImprovementTab from './admin/BrainImprovementTab';

/**
 * Admin surface — kept intentionally small.
 *
 * Prior structure (2026-06 vintage) had 9 top-level tabs. Per Basit
 * 2026-07-06 ("this page become too much complex, try to make it
 * simpler with only necessary things") we collapsed to 5:
 *
 *   Users      — daily user management (renamed from Client Management)
 *   WhatsApp   — channel config + Verify panel
 *   Connectors — per-tenant eligibility
 *   Brain      — Learning + Improvement (nested sub-tabs)
 *   Setup      — rare/one-time (Clients, Licenses, Tiers, App Config,
 *                LLM Spend) — nested sub-tabs; hidden unless you need it
 *
 * The nested-sub-tabs pattern (Brain and Setup) keeps the daily
 * surface uncluttered without deleting any functionality.
 */
export default function AdminPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('users');
  const [brainSubTab, setBrainSubTab] = useState('learning');
  const [setupSubTab, setSetupSubTab] = useState('clients');
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
    { key: 'users',      label: 'Users' },
    { key: 'whatsapp',   label: 'WhatsApp' },
    { key: 'connectors', label: 'Connectors' },
    { key: 'brain',      label: 'Brain' },
    { key: 'setup',      label: 'Setup' },
  ];

  const brainSubTabs = [
    { key: 'learning',    label: 'Learning' },
    { key: 'improvement', label: 'Improvement' },
  ];

  // Setup groups the tabs used at initial config time or checked
  // rarely (once a month or less). Order = most-common-first among
  // the rare ones.
  const setupSubTabs = [
    { key: 'clients',    label: 'Clients' },
    ...(user?.isSuperAdmin ? [{ key: 'licenses', label: 'Licenses' }] : []),
    { key: 'tiers',      label: 'User Tiers' },
    { key: 'config',     label: 'Application Configuration' },
    { key: 'llm-spend',  label: 'LLM Spend' },
  ];

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

        {/* Sub-tab row — only rendered when the top-level tab has
            nested sections (Brain, Setup). Kept visually lighter than
            top tabs so the hierarchy is clear at a glance. */}
        {activeTab === 'brain' && (
          <div className="config-tabs config-tabs-sub" style={subTabRowStyle}>
            {brainSubTabs.map(t => (
              <button
                key={t.key}
                className={`config-tab ${brainSubTab === t.key ? 'active' : ''}`}
                onClick={() => setBrainSubTab(t.key)}
                style={subTabButtonStyle}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {activeTab === 'setup' && (
          <div className="config-tabs config-tabs-sub" style={subTabRowStyle}>
            {setupSubTabs.map(t => (
              <button
                key={t.key}
                className={`config-tab ${setupSubTab === t.key ? 'active' : ''}`}
                onClick={() => setSetupSubTab(t.key)}
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

        {/* Daily surfaces */}
        {activeTab === 'users' && (
          <ClientManagementTab user={user} msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'whatsapp' && (
          <WhatsAppMergedTab msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'connectors' && (
          <ConnectorsAdminTab user={user} msg={msg} setMsg={setMsg} />
        )}

        {/* Brain — Learning + Improvement */}
        {activeTab === 'brain' && brainSubTab === 'learning' && (
          <BrainLearningTab user={user} msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'brain' && brainSubTab === 'improvement' && (
          <BrainImprovementTab user={user} msg={msg} setMsg={setMsg} />
        )}

        {/* Setup — rare / one-time */}
        {activeTab === 'setup' && setupSubTab === 'clients' && (
          <ClientManagementTab user={user} msg={msg} setMsg={setMsg} initialSubTab="clients" />
        )}
        {activeTab === 'setup' && setupSubTab === 'licenses' && user?.isSuperAdmin && (
          <LicensesTab msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'setup' && setupSubTab === 'tiers' && (
          <TierManagementTab msg={msg} setMsg={setMsg} />
        )}
        {activeTab === 'setup' && setupSubTab === 'config' && (
          <ConfigTab user={user} />
        )}
        {activeTab === 'setup' && setupSubTab === 'llm-spend' && (
          <LlmSpendTab user={user} />
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
