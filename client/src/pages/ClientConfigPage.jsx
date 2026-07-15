import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import ConfigEditor from '../components/ConfigEditor';

// Client Config — Admin manages for their tenant
const CLIENT_SECTIONS = [
  {
    title: 'Email / SMTP',
    icon: '✉️',
    keys: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'],
  },
  {
    title: 'Google Drive',
    icon: '📁',
    // Per-tenant OAuth credentials (google_client_id, google_client_secret,
    // google_redirect_uri) were retired in 2026-05-04 — every tenant uses
    // the platform-wide OAuth client in tmcai-491811. See memory
    // `project_gcp_simplification.md`. Only the per-tenant Drive folder
    // pointer + index file remain configurable here.
    keys: ['google_drive_folder_id', 'google_index_file_name'],
  },
];

export default function ClientConfigPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  if (!user?.isAdmin) {
    return <div className="settings-page"><div className="settings-container"><h1>Access Denied</h1><p>Admin access required.</p></div></div>;
  }

  return (
    <div className="settings-page">
      <div className="settings-container" style={{ maxWidth: 720 }}>
        <div className="settings-header">
          <button className="settings-back" onClick={() => navigate('/admin')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            Back to Admin
          </button>
          <h1>Client Configuration</h1>
          <span className="config-scope-badge client">Tenant: {user?.clientNumber}</span>
        </div>
        <ConfigEditor sections={CLIENT_SECTIONS} apiPath="/config" />
      </div>
    </div>
  );
}
