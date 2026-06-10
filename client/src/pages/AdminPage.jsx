import React, { useState, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import ClientManagementTab from './admin/ClientManagementTab';
import LicensesTab from './admin/LicensesTab';
import TierManagementTab from './admin/TierManagementTab';
import ConfigTab from './admin/ConfigTab';
import WhatsAppMergedTab from './admin/WhatsAppMergedTab';
import LlmSpendTab from './admin/LlmSpendTab';
import ConnectorsAdminTab from './admin/ConnectorsAdminTab';

export default function AdminPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('clients');
  const [msg, setMsgRaw] = useState('');

  // Auto-dismiss the floating toast after 4s. Wraps the raw setter so
  // tabs don't have to manage their own timeouts — pass a string, it
  // shows; pass empty/null/undefined, it hides immediately. Each new
  // message resets the timer so a rapid second click doesn't get
  // shadowed by the previous one's expiry.
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

  const tabs = [
    { key: 'clients', label: 'Client Management' },
    ...(user?.isSuperAdmin ? [{ key: 'licenses', label: 'Licenses' }] : []),
    { key: 'tiers', label: 'User Tiers' },
    { key: 'config', label: 'Application Configuration' },
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'connectors', label: 'Connectors' },
    { key: 'llm-spend', label: 'LLM Spend' },
  ];

  // Renders inside the SteeringWheel shell — the shell already provides
  // the rail + topbar ("Admin / Client Config"), so we skip our own
  // back button / H1 and just render the tab row + active sub-tab.
  return (
    <div className="settings-page">
      <div className="settings-container">
        <div className="config-tabs">
          {tabs.map(t => (
            <button key={t.key} className={`config-tab ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

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

        {activeTab === 'clients' && <ClientManagementTab user={user} msg={msg} setMsg={setMsg} />}
        {activeTab === 'licenses' && user?.isSuperAdmin && <LicensesTab msg={msg} setMsg={setMsg} />}
        {activeTab === 'tiers' && <TierManagementTab msg={msg} setMsg={setMsg} />}
        {activeTab === 'config' && <ConfigTab user={user} />}
        {activeTab === 'whatsapp' && <WhatsAppMergedTab msg={msg} setMsg={setMsg} />}
        {activeTab === 'connectors' && <ConnectorsAdminTab user={user} msg={msg} setMsg={setMsg} />}
        {activeTab === 'llm-spend' && <LlmSpendTab user={user} />}
      </div>
    </div>
  );
}
