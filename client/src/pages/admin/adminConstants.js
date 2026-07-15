// Admin → Application Configuration sections.
//
// These are deliberately minimal. Many tunables that lived here over
// time have been removed because Brain self-manages those:
//   - AI & RAG Pipeline (rag_top_k, rag_min_score, etc.) — retrieval
//     re-ranker self-calibrates per (user, page) from 👍/👎 feedback.
//   - AI Context & Tokens (context_limit_*, max_output_tokens_*,
//     thinking_budget_*) — llmRouter dynamic-routes per call.
//   - Response Control (response_length, max_response_words) — moved
//     to per-user prompt overlay + per-tier response_style settings.
//   - Caching (dedup_cache_ttl_ms, weather_cache_ttl_ms) — pure infra,
//     never tenant-tunable.
//
// What stays here is the irreducibly platform / SA-level config that
// Brain CAN'T figure out on its own: API keys, GCP project, password
// policy, app name. Per-tenant config (SMTP, FACL folder) is in
// CLIENT_SECTIONS below.

export const SYSTEM_SECTIONS = [
  { title: 'Application', icon: '⚙️', keys: ['app_name', 'session_hours'] },
  { title: 'Password & Security', icon: '🔐', keys: ['password_min_length', 'password_require_uppercase', 'password_require_number', 'password_require_special', 'max_login_attempts', 'lockout_minutes'] },
  { title: 'Google Cloud Platform', icon: '☁️', keys: ['data_source', 'ai_provider', 'gcp_project_id', 'gcp_location', 'bq_dataset'] },
  { title: 'AI API Keys', icon: '🔑', keys: ['gemini_api_key', 'anthropic_api_key', 'openai_api_key', 'groq_api_key', 'openrouter_api_key'] },
];

// Per-tenant Client Config. Google Drive OAuth keys (client_id, secret,
// redirect_uri) used to live here but the platform now runs a single
// OAuth client across all tenants — those keys are env-vars, not
// tenant settings. Per-tenant Drive identity is managed via the
// "Client Connectors" tab; only SMTP + folder pointers remain here.
export const CLIENT_SECTIONS = [
  { title: 'Email / SMTP', icon: '✉️', keys: ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_secure'] },
  { title: 'Foundation Drive', icon: '📁', keys: ['google_drive_folder_id', 'google_index_file_name'] },
];
