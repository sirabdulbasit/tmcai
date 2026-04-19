import { useState } from 'react';
import ChatPage from './ChatPage';
import DayBriefPage from './DayBriefPage';
import OpenItemsPage from './OpenItemsPage';
import ActionExecutionTab from '../components/steering/ActionExecutionTab';
import HealthCheckTab from '../components/steering/HealthCheckTab';
import ActionFormsPanel from '../components/steering/ActionForms';
import CustomActionTab from '../components/steering/CustomActionTab';
import './SteeringWheelPage.css';

const TABS = [
  { key: 'brain', label: 'Brain Query', render: () => <ChatPage /> },
  { key: 'brief', label: 'Morning Brief', render: () => <DayBriefPage /> },
  { key: 'center', label: 'Action Center', render: () => <OpenItemsPage /> },
  { key: 'exec', label: 'Pending Approvals', render: () => <ActionExecutionTab /> },
  { key: 'forms', label: 'Execute Action', render: () => <ActionFormsPanel /> },
  { key: 'custom', label: 'Custom Actions', render: () => <CustomActionTab /> },
  { key: 'health', label: 'Health Check', render: () => <HealthCheckTab /> },
];

export default function SteeringWheelPage() {
  const [active, setActive] = useState(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('tab') ?? 'brain';
    }
    return 'brain';
  });

  const select = (key) => {
    setActive(key);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', key);
      window.history.replaceState({}, '', url);
    }
  };

  const tab = TABS.find((t) => t.key === active) ?? TABS[0];

  return (
    <div className="steering-wheel">
      <nav className="steering-tabs" aria-label="Steering Wheel">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={t.key === active ? 'steering-tab active' : 'steering-tab'}
            onClick={() => select(t.key)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </nav>
      <section className="steering-content">{tab.render()}</section>
    </div>
  );
}
