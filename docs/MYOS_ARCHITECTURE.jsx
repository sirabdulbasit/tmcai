import { useState } from "react";

const COLORS = {
  bg: "#0f172a",
  card: "#1e293b",
  cardHover: "#334155",
  border: "#334155",
  accent: "#3b82f6",
  accentLight: "#60a5fa",
  green: "#22c55e",
  greenDark: "#166534",
  yellow: "#eab308",
  yellowDark: "#854d0e",
  red: "#ef4444",
  orange: "#f97316",
  purple: "#a855f7",
  cyan: "#06b6d4",
  pink: "#ec4899",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  textDim: "#64748b",
};

const systemData = {
  overview: {
    title: "MyOS (HaseebOS v15)",
    subtitle: "AI-Powered Executive Operating System",
    description: "A multi-tenant AI platform combining 7 Gemini ADK agents, 36 action handlers, event-driven Pub/Sub architecture, and a unified Steering Wheel UI to automate executive workflows.",
    stack: "Platform :4002 (Express/TS) | Agent Worker :8080 (Python/FastAPI) | React :5174 (Vite) | Postgres :5432 | Redis :6379 | Pub/Sub Emulator :8085",
    tenant: "TMC-0001 | Abdul Haseeb (haseeb@tmcltd.ai) | AD-Admin",
  },
  layers: [
    {
      id: "ui",
      name: "Presentation Layer",
      icon: "🖥️",
      color: "#3b82f6",
      subtitle: "React + Vite (:5174)",
      items: [
        { name: "Steering Wheel", detail: "5-tab unified shell: Brain Query, Morning Brief, Action Center, Action Execution, Health Check" },
        { name: "Brain Query", detail: "Real-time chat with Gemini via SSE stream, model selector (Flash/Pro), quick actions (Day Brief, Name AI)" },
        { name: "Morning Brief", detail: "4 sections: A-Critical Items, B-Calendar, C-Email Digest, D-Delegation Follow-up + KPI cards + Run Engine" },
        { name: "Action Center", detail: "Open Items CRUD with 5 KPI cards, 7 filter tabs (All/Open/In Progress/Delegated/Blocked/Done/Overdue)" },
        { name: "Action Execution", detail: "Pending approval queue for MEDIUM/HIGH risk actions with Approve/Reject workflow" },
        { name: "Health Check", detail: "6 subsystem monitors: Platform API, Kill Switch, Steering Wheel, Risk Gating, Shadow Pipeline, Cascading Undo" },
        { name: "Admin Panel", detail: "4 tabs: Client Management (Users + Config), User Tiers, Application Configuration (SMTP/Drive), WhatsApp" },
        { name: "Settings", detail: "Profile, AI Personalization (address preference, custom instructions), Google OAuth, Change Password" },
        { name: "My Connectors", detail: "19 available connectors across 5 categories (Email, Calendar, Tasks, Messaging, Chat)" },
        { name: "Sidebar Navigation", detail: "13 items: New Chat, History, Search, Steering Wheel, Day Brief, Open Items, My Brain, My Thoughts, Connectors, Team, Reports, Admin, Settings" },
      ],
    },
    {
      id: "platform",
      name: "Platform API Layer",
      icon: "⚙️",
      color: "#22c55e",
      subtitle: "Express/TypeScript (:4002)",
      items: [
        { name: "Feed Ingestion", detail: "POST /feed/ingest — accepts gmail/calendar/whatsapp, dedup via contentHash, publishes to Pub/Sub" },
        { name: "Action Execution Engine", detail: "POST /actions/execute — 36 handlers, risk assessment, idempotency check, dependency graph creation" },
        { name: "Risk Gating", detail: "POST /risk/assess — 3 tiers (LOW=auto, MEDIUM=confirm, HIGH=full_review), $10k threshold, external escalation" },
        { name: "Kill Switch", detail: "POST/DELETE /safety/kill-switch — <50ms halt SLA, per-tenant Redis key, read-only mode, bypass paths" },
        { name: "Cascading Undo", detail: "POST /actions/:id/undo — dependency graph traversal, reverseOp execution, preview endpoint, undo_log audit" },
        { name: "Shadow Pipeline", detail: "DRAFT→SHADOW(30d)→ACTIVE lifecycle, gate thresholds (LOW=0.95, MEDIUM=0.98, HIGH=manual), drift guard" },
        { name: "Decision Log", detail: "Append-only with immutability triggers, BigQuery archive, v15 fields (riskTier, traceId, agentId, confidenceScore)" },
        { name: "Steering Dashboard", detail: "KPI snapshot computation (10 KPIs), daily 06:00 PKT schedule, trend analysis" },
        { name: "Auth Middleware", detail: "Dual auth: Session cookies (UI) + Bearer token + X-Tenant-Id (M2M agents), SA user resolution cache" },
        { name: "Feature Flags", detail: "feature_adk_agents, feature_pubsub, feature_redis_idempotency, feature_feed_ingestion_pubsub, feature_agents" },
      ],
    },
    {
      id: "agents",
      name: "Agent Pipeline",
      icon: "🤖",
      color: "#a855f7",
      subtitle: "Python/FastAPI + Gemini ADK (:8080)",
      items: [
        { name: "Brain Orchestrator (Pro)", detail: "Root agent — gemini-2.5-pro, orchestrates 7 sub-agents, routes tasks via transfer_to_agent" },
        { name: "Feed Curator (Flash)", detail: "gemini-2.5-flash — classifies feeds, promotes to open items via promote_feed_to_open_item tool" },
        { name: "Triage Analyst (Flash)", detail: "gemini-2.5-flash — scores open items with score_open_item tool, priority classification" },
        { name: "Action Executor (Flash)", detail: "gemini-2.5-flash — executes actions with execute_action + assess_risk tools, calls platform API" },
        { name: "Reflection Agent (Flash)", detail: "gemini-2.5-flash — reviews decisions with review_decision tool, quality assurance loop" },
        { name: "Steering Analyst (Flash)", detail: "gemini-2.5-flash — computes KPIs with compute_kpi tool, trend analysis" },
        { name: "External Knowledge (Flash)", detail: "gemini-2.5-flash — 3 tools: query_knowledge_base, query_tmc_context, query_know" },
        { name: "Shadow Scorer (Flash)", detail: "gemini-2.5-flash — scores shadow rules with score_shadow tool, golden dataset comparison" },
      ],
    },
    {
      id: "events",
      name: "Event Bus",
      icon: "📨",
      color: "#f97316",
      subtitle: "Google Cloud Pub/Sub",
      items: [
        { name: "tmcai-feed-raw", detail: "Feed ingestion events from gmail/calendar/whatsapp → Brain Orchestrator → Feed Curator" },
        { name: "tmcai-openitems-scored", detail: "Scored open items from Triage Analyst → downstream processing" },
        { name: "tmcai-actions-approved", detail: "Approved actions → Action Executor agent for execution (parallel fan-out children)" },
        { name: "tmcai-steering-snapshot", detail: "KPI snapshots + decision log archives → BigQuery export" },
        { name: "Dead Letter Queues (4)", detail: "DLQ for each topic (*-dlq suffix) — captures failed messages after max retries" },
        { name: "Push Subscriptions", detail: "Emulator pushes to agent :8080 endpoints: /pubsub/feed-raw, /pubsub/actions-approved, etc." },
        { name: "Ordering Keys", detail: "Per-entity ordering keys ensure message sequence within same entity context" },
        { name: "Trace ID Propagation", detail: "traceId attribute flows through all messages for cross-service correlation" },
      ],
    },
    {
      id: "data",
      name: "Data Layer",
      icon: "🗄️",
      color: "#06b6d4",
      subtitle: "PostgreSQL + Redis + BigQuery",
      items: [
        { name: "PostgreSQL (:5432)", detail: "Primary datastore via Prisma ORM — open_items, agent_actions, feed_events, decision_logs, shadow_rules, agent_memory" },
        { name: "Redis (:6379)", detail: "Caching + state: kill switch keys, idempotency SETNX (24h TTL), circuit breaker state, SA user cache" },
        { name: "BigQuery", detail: "Decision log archive (append-only), KPI historical data, analytics warehouse" },
        { name: "Idempotency Layer", detail: "Redis SETNX + SQL dual-write: key format idempotency:{tenant}:{hash}, 7-day SQL cleanup at 3 AM" },
        { name: "Circuit Breakers", detail: "Redis-backed state machine (CLOSED→OPEN→HALF-OPEN), wraps Gmail/Calendar/WhatsApp/Drive adapters" },
        { name: "Immutability Triggers", detail: "DB triggers on decision_logs: block UPDATE (except outcome) and DELETE operations" },
        { name: "Action Dependencies", detail: "parent_id → child_id graph for parallel_fan_out, enables cascading undo traversal" },
        { name: "Agent Memory", detail: "agent_memory table: agentId + memoryKey → memoryValue with previousValue tracking for undo" },
      ],
    },
    {
      id: "handlers",
      name: "36 Action Handlers",
      icon: "🔧",
      color: "#ec4899",
      subtitle: "8 Categories",
      items: [
        { name: "Communication (5)", detail: "send_email, send_whatsapp_message, send_sms, send_slack_message, send_teams_message" },
        { name: "Calendar (5)", detail: "create_event, reschedule_event, cancel_event, accept_invite, decline_invite" },
        { name: "Task (4)", detail: "create_task, update_task, complete_task, delegate_task" },
        { name: "CRM (4)", detail: "update_odoo_crm, create_odoo_opportunity, update_contact, log_interaction" },
        { name: "Lifecycle (7)", detail: "snooze, close, escalate, reopen, archive, prioritize, deprioritize" },
        { name: "Orchestration (3)", detail: "transfer_to_agent, parallel_fan_out, sequential_chain" },
        { name: "Brain (5)", detail: "update_memory, recall_memory, tag_entity, summarize_thread, classify_intent" },
        { name: "Governance (3)", detail: "freeze_rule, unfreeze_rule, audit_action" },
      ],
    },
    {
      id: "security",
      name: "Security & Safety",
      icon: "🛡️",
      color: "#eab308",
      subtitle: "Multi-Layer Protection",
      items: [
        { name: "Kill Switch", detail: "<50ms halt SLA, per-tenant Redis key kill_switch:{tenant}, read-only mode for GET endpoints, audit trail" },
        { name: "Risk Tiers", detail: "LOW (auto_execute), MEDIUM (confirm), HIGH (full_review) — $10k amount threshold, external target escalation" },
        { name: "Multi-Tenant Isolation", detail: "All data scoped by clientNumber/tenantId, Redis keys prefixed per-tenant, no cross-tenant data leakage" },
        { name: "Dual Authentication", detail: "Session cookies for UI users + Bearer token with X-Tenant-Id header for agent M2M communication" },
        { name: "Encrypted Fields", detail: "Sensitive fields (smtp_pass, google_client_secret) encrypted at rest, masked in UI with green 'encrypted' badge" },
        { name: "Immutable Decision Log", detail: "DB triggers prevent UPDATE/DELETE on decision_logs (except outcome field), BigQuery archive for compliance" },
        { name: "Shadow Rule Gates", detail: "30-day observation period, accuracy thresholds (0.95/0.98/manual), drift guard freezes on >2σ shift" },
        { name: "Circuit Breakers", detail: "All external service adapters wrapped, auto-OPEN after 3 failures, HALF-OPEN recovery probe" },
      ],
    },
  ],
  dataFlows: [
    { from: "Feed Source", to: "Platform API", label: "POST /feed/ingest", color: "#22c55e" },
    { from: "Platform API", to: "Pub/Sub", label: "tmcai-feed-raw", color: "#f97316" },
    { from: "Pub/Sub", to: "Brain Orchestrator", label: "Push subscription", color: "#a855f7" },
    { from: "Brain Orchestrator", to: "Feed Curator", label: "transfer_to_agent", color: "#a855f7" },
    { from: "Feed Curator", to: "Platform API", label: "POST /open-items", color: "#22c55e" },
    { from: "Brain Orchestrator", to: "Action Executor", label: "transfer_to_agent", color: "#a855f7" },
    { from: "Action Executor", to: "Platform API", label: "POST /actions/execute", color: "#22c55e" },
    { from: "Platform API", to: "Redis", label: "Idempotency + Kill Switch", color: "#06b6d4" },
    { from: "Platform API", to: "PostgreSQL", label: "Prisma ORM", color: "#06b6d4" },
    { from: "React UI", to: "Platform API", label: "REST + SSE", color: "#3b82f6" },
  ],
};

const LayerIcon = ({ icon, size = 32 }) => (
  <span style={{ fontSize: size, lineHeight: 1 }}>{icon}</span>
);

const Badge = ({ text, color }) => (
  <span
    style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 9999,
      fontSize: 11,
      fontWeight: 600,
      background: color + "22",
      color: color,
      border: `1px solid ${color}44`,
    }}
  >
    {text}
  </span>
);

const DataFlowDiagram = () => (
  <div style={{ padding: 20 }}>
    <h3 style={{ color: COLORS.text, fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
      Request Lifecycle — Feed → Brain → Action → Undo
    </h3>
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {systemData.dataFlows.map((flow, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            borderRadius: 8,
            background: COLORS.card,
          }}
        >
          <span style={{ color: flow.color, fontWeight: 700, minWidth: 160, fontSize: 13 }}>
            {flow.from}
          </span>
          <span style={{ color: COLORS.textDim, fontSize: 18 }}>→</span>
          <span
            style={{
              color: COLORS.textMuted,
              fontSize: 11,
              fontFamily: "monospace",
              background: flow.color + "18",
              padding: "2px 8px",
              borderRadius: 4,
              minWidth: 180,
            }}
          >
            {flow.label}
          </span>
          <span style={{ color: COLORS.textDim, fontSize: 18 }}>→</span>
          <span style={{ color: flow.color, fontWeight: 700, fontSize: 13 }}>{flow.to}</span>
        </div>
      ))}
    </div>
  </div>
);

const HighLevelView = ({ onSelectLayer }) => {
  const [hovered, setHovered] = useState(null);

  return (
    <div style={{ padding: 20 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: 16,
        }}
      >
        {systemData.layers.map((layer) => (
          <div
            key={layer.id}
            onClick={() => onSelectLayer(layer.id)}
            onMouseEnter={() => setHovered(layer.id)}
            onMouseLeave={() => setHovered(null)}
            style={{
              background: hovered === layer.id ? COLORS.cardHover : COLORS.card,
              border: `1px solid ${hovered === layer.id ? layer.color : COLORS.border}`,
              borderRadius: 12,
              padding: 20,
              cursor: "pointer",
              transition: "all 0.2s ease",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 3,
                background: layer.color,
                opacity: hovered === layer.id ? 1 : 0.4,
                transition: "opacity 0.2s",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <LayerIcon icon={layer.icon} size={28} />
              <div>
                <div style={{ color: COLORS.text, fontWeight: 700, fontSize: 15 }}>
                  {layer.name}
                </div>
                <div style={{ color: layer.color, fontSize: 12, fontFamily: "monospace" }}>
                  {layer.subtitle}
                </div>
              </div>
            </div>
            <div style={{ color: COLORS.textMuted, fontSize: 12, lineHeight: 1.5 }}>
              {layer.items.length} components — click to explore
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 10 }}>
              {layer.items.slice(0, 4).map((item, i) => (
                <Badge key={i} text={item.name} color={layer.color} />
              ))}
              {layer.items.length > 4 && (
                <Badge text={`+${layer.items.length - 4} more`} color={COLORS.textDim} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const DetailView = ({ layerId, onBack }) => {
  const layer = systemData.layers.find((l) => l.id === layerId);
  const [expanded, setExpanded] = useState(null);

  if (!layer) return null;

  return (
    <div style={{ padding: 20 }}>
      <button
        onClick={onBack}
        style={{
          background: "transparent",
          border: `1px solid ${COLORS.border}`,
          color: COLORS.textMuted,
          padding: "6px 16px",
          borderRadius: 8,
          cursor: "pointer",
          fontSize: 13,
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        ← Back to Overview
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <LayerIcon icon={layer.icon} size={36} />
        <div>
          <h2 style={{ color: COLORS.text, fontSize: 22, fontWeight: 700, margin: 0 }}>
            {layer.name}
          </h2>
          <div style={{ color: layer.color, fontSize: 13, fontFamily: "monospace" }}>
            {layer.subtitle}
          </div>
        </div>
      </div>
      <div style={{ color: COLORS.textMuted, fontSize: 13, marginBottom: 20 }}>
        {layer.items.length} components in this layer
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {layer.items.map((item, i) => (
          <div
            key={i}
            onClick={() => setExpanded(expanded === i ? null : i)}
            style={{
              background: expanded === i ? layer.color + "12" : COLORS.card,
              border: `1px solid ${expanded === i ? layer.color + "66" : COLORS.border}`,
              borderRadius: 10,
              padding: "14px 18px",
              cursor: "pointer",
              transition: "all 0.2s ease",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: layer.color + "22",
                    color: layer.color,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {i + 1}
                </div>
                <span style={{ color: COLORS.text, fontWeight: 600, fontSize: 14 }}>
                  {item.name}
                </span>
              </div>
              <span style={{ color: COLORS.textDim, fontSize: 18, transition: "transform 0.2s", transform: expanded === i ? "rotate(180deg)" : "rotate(0)" }}>
                ▾
              </span>
            </div>
            {expanded === i && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: `1px solid ${layer.color}33`,
                  color: COLORS.textMuted,
                  fontSize: 13,
                  lineHeight: 1.7,
                }}
              >
                {item.detail}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

const ArchDiagramSVG = () => {
  const boxW = 150, boxH = 50, gap = 20;
  const startY = 10;

  const boxes = [
    { id: "ui", label: "React UI", sub: ":5174", x: 250, y: startY, color: "#3b82f6" },
    { id: "platform", label: "Platform API", sub: ":4002", x: 100, y: startY + 90, color: "#22c55e" },
    { id: "agents", label: "Agent Worker", sub: ":8080", x: 400, y: startY + 90, color: "#a855f7" },
    { id: "pubsub", label: "Pub/Sub", sub: ":8085", x: 250, y: startY + 180, color: "#f97316" },
    { id: "pg", label: "PostgreSQL", sub: ":5432", x: 70, y: startY + 270, color: "#06b6d4" },
    { id: "redis", label: "Redis", sub: ":6379", x: 250, y: startY + 270, color: "#ef4444" },
    { id: "bq", label: "BigQuery", sub: "GCP", x: 430, y: startY + 270, color: "#eab308" },
  ];

  const arrows = [
    { from: "ui", to: "platform", label: "REST/SSE" },
    { from: "platform", to: "pubsub", label: "Publish" },
    { from: "pubsub", to: "agents", label: "Push" },
    { from: "agents", to: "platform", label: "API calls" },
    { from: "platform", to: "pg", label: "Prisma" },
    { from: "platform", to: "redis", label: "Cache" },
    { from: "platform", to: "bq", label: "Archive" },
  ];

  const getCenter = (id) => {
    const b = boxes.find((bx) => bx.id === id);
    return { x: b.x + boxW / 2, y: b.y + boxH / 2 };
  };

  return (
    <svg width="100%" viewBox="0 0 620 350" style={{ maxWidth: 620 }}>
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill={COLORS.textDim} />
        </marker>
      </defs>
      {arrows.map((a, i) => {
        const f = getCenter(a.from);
        const t = getCenter(a.to);
        const mx = (f.x + t.x) / 2;
        const my = (f.y + t.y) / 2;
        return (
          <g key={i}>
            <line
              x1={f.x} y1={f.y} x2={t.x} y2={t.y}
              stroke={COLORS.textDim}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              markerEnd="url(#arrowhead)"
            />
            <rect x={mx - 30} y={my - 8} width={60} height={16} rx={4} fill={COLORS.bg} />
            <text x={mx} y={my + 4} textAnchor="middle" fill={COLORS.textMuted} fontSize={9} fontFamily="monospace">
              {a.label}
            </text>
          </g>
        );
      })}
      {boxes.map((b) => (
        <g key={b.id}>
          <rect
            x={b.x} y={b.y} width={boxW} height={boxH} rx={10}
            fill={COLORS.card}
            stroke={b.color}
            strokeWidth={2}
          />
          <text x={b.x + boxW / 2} y={b.y + 22} textAnchor="middle" fill={COLORS.text} fontSize={13} fontWeight="bold" fontFamily="system-ui">
            {b.label}
          </text>
          <text x={b.x + boxW / 2} y={b.y + 38} textAnchor="middle" fill={b.color} fontSize={11} fontFamily="monospace">
            {b.sub}
          </text>
        </g>
      ))}
    </svg>
  );
};

const StatsBar = () => {
  const stats = [
    { label: "Agents", value: "7", sub: "1 Pro + 6 Flash", color: "#a855f7" },
    { label: "Handlers", value: "36", sub: "8 categories", color: "#ec4899" },
    { label: "Topics", value: "4+4", sub: "main + DLQ", color: "#f97316" },
    { label: "Risk Tiers", value: "3", sub: "L / M / H", color: "#eab308" },
    { label: "UI Tabs", value: "5", sub: "Steering Wheel", color: "#3b82f6" },
    { label: "Connectors", value: "19", sub: "5 categories", color: "#06b6d4" },
    { label: "Test Pass", value: "97%", sub: "188/193", color: "#22c55e" },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        padding: "12px 20px",
        overflowX: "auto",
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      {stats.map((s, i) => (
        <div
          key={i}
          style={{
            background: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 8,
            padding: "8px 14px",
            minWidth: 80,
            textAlign: "center",
            flex: "1 0 auto",
          }}
        >
          <div style={{ color: s.color, fontSize: 20, fontWeight: 800, lineHeight: 1.2 }}>
            {s.value}
          </div>
          <div style={{ color: COLORS.text, fontSize: 11, fontWeight: 600 }}>{s.label}</div>
          <div style={{ color: COLORS.textDim, fontSize: 10 }}>{s.sub}</div>
        </div>
      ))}
    </div>
  );
};

const TABS = [
  { id: "overview", label: "High-Level Overview", icon: "🏗️" },
  { id: "diagram", label: "System Diagram", icon: "📐" },
  { id: "flow", label: "Data Flow", icon: "🔄" },
];

export default function MyOSArchitecture() {
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedLayer, setSelectedLayer] = useState(null);

  return (
    <div
      style={{
        background: COLORS.bg,
        color: COLORS.text,
        minHeight: "100vh",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Header */}
      <div
        style={{
          background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
          borderBottom: `1px solid ${COLORS.border}`,
          padding: "24px 24px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              background: "linear-gradient(135deg, #3b82f6, #a855f7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
            }}
          >
            🧠
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, letterSpacing: -0.5 }}>
              {systemData.overview.title}
            </h1>
            <div style={{ color: COLORS.accentLight, fontSize: 13, fontWeight: 500 }}>
              {systemData.overview.subtitle}
            </div>
          </div>
        </div>
        <p style={{ color: COLORS.textMuted, fontSize: 13, lineHeight: 1.6, margin: "12px 0 8px", maxWidth: 750 }}>
          {systemData.overview.description}
        </p>
        <div style={{ color: COLORS.textDim, fontSize: 11, fontFamily: "monospace" }}>
          {systemData.overview.stack}
        </div>
      </div>

      {/* Stats */}
      <StatsBar />

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "12px 20px",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id);
              setSelectedLayer(null);
            }}
            style={{
              background: activeTab === tab.id ? COLORS.accent + "22" : "transparent",
              border: `1px solid ${activeTab === tab.id ? COLORS.accent : "transparent"}`,
              color: activeTab === tab.id ? COLORS.accentLight : COLORS.textMuted,
              padding: "8px 16px",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        {activeTab === "overview" && !selectedLayer && (
          <HighLevelView onSelectLayer={setSelectedLayer} />
        )}
        {activeTab === "overview" && selectedLayer && (
          <DetailView layerId={selectedLayer} onBack={() => setSelectedLayer(null)} />
        )}
        {activeTab === "diagram" && (
          <div style={{ padding: 20 }}>
            <h3 style={{ color: COLORS.text, fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
              Service Topology
            </h3>
            <div
              style={{
                background: COLORS.card,
                borderRadius: 12,
                border: `1px solid ${COLORS.border}`,
                padding: 24,
                display: "flex",
                justifyContent: "center",
              }}
            >
              <ArchDiagramSVG />
            </div>
            <div style={{ marginTop: 16, display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center" }}>
              {[
                { label: "React UI", color: "#3b82f6" },
                { label: "Platform API", color: "#22c55e" },
                { label: "Agent Worker", color: "#a855f7" },
                { label: "Pub/Sub", color: "#f97316" },
                { label: "PostgreSQL", color: "#06b6d4" },
                { label: "Redis", color: "#ef4444" },
                { label: "BigQuery", color: "#eab308" },
              ].map((l, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: l.color }} />
                  <span style={{ color: COLORS.textMuted, fontSize: 12 }}>{l.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {activeTab === "flow" && <DataFlowDiagram />}
      </div>

      {/* Footer */}
      <div
        style={{
          textAlign: "center",
          padding: "24px 20px",
          borderTop: `1px solid ${COLORS.border}`,
          marginTop: 40,
          color: COLORS.textDim,
          fontSize: 11,
        }}
      >
        MyOS Architecture v15 — Generated 2026-04-19 — TMC-0001 — 97.4% Test Pass Rate (188/193)
      </div>
    </div>
  );
}
