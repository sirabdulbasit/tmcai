import express, { Router } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import healthRoutes from './routes/healthRoutes';
import indexRoutes from './routes/indexRoutes';
import chatRoutes from './routes/chatRoutes';
import safetyRoutes from './routes/safetyRoutes';
import riskRoutes from './routes/riskRoutes';
import undoRoutes from './routes/undoRoutes';
import steeringRoutes from './routes/steeringRoutes';
import shadowRoutes from './routes/shadowRoutes';
import feedRoutes from './routes/feedRoutes';
import triageRoutes from './routes/triageRoutes';
import wikiRoutes from './routes/wikiRoutes';
import draftsRoutes from './routes/draftsRoutes';
import briefRoutes from './routes/briefRoutes';
import brainAskRoutes from './routes/brainAskRoutes';
import userPromptOverlayRoutes from './routes/userPromptOverlayRoutes';
import authRoutes from './routes/authRoutes';
import userAuthRoutes from './routes/userAuthRoutes';
import mutedSendersRoutes from './routes/mutedSendersRoutes';
import conversationRoutes from './routes/conversationRoutes';
import profileRoutes from './routes/profileRoutes';
import schedulerRoutes from './routes/schedulerRoutes';
import licenseRoutes from './routes/licenseRoutes';
import adminRoutes from './routes/adminRoutes';
import configRoutes from './routes/configRoutes';
import tenantRoutes from './routes/tenantRoutes';
import integrationRoutes from './routes/integrationRoutes';
import logRoutes from './routes/logRoutes';
import tierRoutes from './routes/tierRoutes';
import tokenUsageRoutes from './routes/tokenUsageRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import personalDriveRoutes from './routes/personalDriveRoutes';
import fileUploadRoutes from './routes/fileUploadRoutes';
import knowledgeBaseRoutes from './routes/knowledgeBaseRoutes';
import agentRoutes from './routes/agentRoutes';
import { developerRouter, externalApiRouter } from './routes/apiGatewayRoutes';
import webhookRoutes from './routes/webhookRoutes';
import whatsappAdminRoutes from './routes/admin/whatsappAdminRoutes';
import whatsappNotifierRoutes from './routes/admin/whatsappNotifierRoutes';
import clientDriveRoutes from './routes/admin/clientDriveRoutes';
import clientConnectorRoutes from './routes/admin/clientConnectorRoutes';
import llmSpendRoutes from './routes/admin/llmSpendRoutes';
import delegationMatrixRoutes from './routes/admin/delegationMatrixRoutes';
import costDashboardRoutes from './routes/admin/costDashboardRoutes';
import riskRadarRoutes from './routes/riskRadarRoutes';
import riskRulesRoutes from './routes/riskRulesRoutes';
import brainDocsRoutes from './routes/brainDocsRoutes';
import pushRoutes from './routes/pushRoutes';
import { userGateRulesRouter, adminGateRulesRouter } from './routes/gateRulesRoutes';
import entityCatalogRoutes from './routes/entityCatalogRoutes';
// MyOS routes
import connectorRoutes from './routes/connectorRoutes';
import connectorAdminRoutes from './routes/admin/connectorAdminRoutes';
import openItemsRoutes from './routes/openItemsRoutes';
import entityRoutes from './routes/entityRoutes';
import brainConfigRoutes from './routes/brainConfigRoutes';
import decisionsRoutes from './routes/decisionsRoutes';
import thoughtRoutes from './routes/thoughtRoutes';
import mcpRoutes from './routes/mcpRoutes';
import { requestIdMiddleware } from './middleware/requestId';
import { requestLoggerMiddleware } from './middleware/requestLogger';
import { killSwitchMiddleware } from './middleware/killSwitchMiddleware';
import { agentAuthMiddleware } from './middleware/agentAuthMiddleware';
import { optionalAuth } from './middleware/auth';

const app = express();

// H9 — Trust the first proxy (Cloud Run / LB) so req.ip and req.protocol
// reflect the original client, not the proxy. Without this, rate limiting
// keys and redirect URL construction use the proxy's IP/scheme.
app.set('trust proxy', 1);

// Request ID — must be first middleware so all downstream logs include it
app.use(requestIdMiddleware);

// Production monitoring — log every request with timing & user info
app.use(requestLoggerMiddleware);

// Security headers (helmet-equivalent, hand-rolled since we want fine
// control over CSP without adding a new dep). H1: dropped 'unsafe-eval'.
// 'unsafe-inline' remains for styles because the frontend uses inline
// styles heavily; a future pass should move to nonces.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Disabled — CSP is the modern replacement
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (process.env.NODE_ENV === 'production') {
    // HSTS — 1 year, include subdomains, preloadable
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // H1: removed 'unsafe-eval'. 'unsafe-inline' kept temporarily (see TODO above).
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  next();
});

// H2 — Global rate limit (generous; chokes brute-forcers without impacting
// normal users). Per-endpoint stricter limits are defined on individual
// routers (e.g. /user/login already has a 10/15min limiter).
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,            // 1 minute
  limit: 300,                     // 300 req/min per IP across the whole API
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Skip health-check probes so Cloud Run doesn't trip the limiter itself.
  skip: (req) => req.path.includes('/health'),
  message: { error: 'Too many requests. Please slow down.' },
});
app.use(globalLimiter);

// CORS
app.use(cors({
  origin: env.clientUrl,
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// HaseebOS v15 — agent auth: accept Bearer PLATFORM_API_TOKEN + X-Tenant-Id
// MUST come before cookieParser so it can build req.user without cookie-based auth
app.use(agentAuthMiddleware);
app.use(cookieParser());

// HaseebOS v15 — block mutations when tenant kill switch is active
app.use(killSwitchMiddleware);

// ── API v1 Router ──────────────────────────────────────────────────────
const v1 = Router();

// Add version header to all v1 responses
v1.use((_req, res, next) => {
  res.setHeader('X-API-Version', 'v1');
  next();
});

// Populate req.user from session cookie for any route that didn't call
// requireAuth() explicitly. Individual routes that require auth still check
// `req.user?.clientNumber` and return 401 themselves. Routes that need to
// strictly gate (admin, superadmin) continue to call requireAuth/requireAdmin.
v1.use(optionalAuth);

v1.use('/health', healthRoutes);
v1.use('/user', userAuthRoutes);
v1.use('/user/muted-senders', mutedSendersRoutes);
v1.use('/profile', profileRoutes);
v1.use('/conversations', conversationRoutes);
v1.use('/schedules', schedulerRoutes);
v1.use('/licenses', licenseRoutes);
v1.use('/admin', adminRoutes);
v1.use('/config', configRoutes);
v1.use('/tenants', tenantRoutes);
v1.use('/auth', authRoutes);
v1.use('/integration', integrationRoutes);
v1.use('/logs', logRoutes);
v1.use('/tiers', tierRoutes);
v1.use('/usage', tokenUsageRoutes);
v1.use('/analytics', analyticsRoutes);
v1.use('/personal-drive', personalDriveRoutes);
v1.use('/uploads', fileUploadRoutes);
v1.use('/knowledge', knowledgeBaseRoutes);
v1.use('/agents', agentRoutes);
v1.use('/admin/whatsapp', whatsappAdminRoutes);
// MCP server — exposes the action handler registry as JSON-RPC tools
// so Claude Desktop, Claude Code, and other MCP clients can call MyOS.
v1.use('/mcp', mcpRoutes);
v1.use('/admin', whatsappNotifierRoutes);
v1.use('/admin', clientDriveRoutes);
v1.use('/admin', clientConnectorRoutes);
v1.use('/admin', llmSpendRoutes);
v1.use('/admin/delegation-matrix', delegationMatrixRoutes);
v1.use('/admin', costDashboardRoutes);
v1.use('/risk-radar', riskRadarRoutes);
v1.use('/risk-rules', riskRulesRoutes);
// Typed Brain Docs (replay/audit substrate). Mounted under /brain so
// it shares the same prefix as brainAsk/brainConfig — unified Brain UX.
v1.use('/brain/docs', brainDocsRoutes);
v1.use('/push', pushRoutes);
v1.use('/gate-rules', userGateRulesRouter);
v1.use('/admin/gate-rules', adminGateRulesRouter);
// Mounted at /entity-catalog (not /entities/catalog) because the
// existing /entities router has a /:id handler that would shadow.
v1.use('/entity-catalog', entityCatalogRoutes);
// MyOS endpoints
v1.use('/connectors', connectorRoutes);
v1.use('/admin/connectors', connectorAdminRoutes);
v1.use('/open-items', openItemsRoutes);
v1.use('/entities', entityRoutes);
// M4 — the two /brain routers are kept at the same prefix because their
// route tables are disjoint (brainConfig: /, /delegation-rules,
// /escalation-rules, /alert-thresholds, /briefing, /context, /engine/*;
// brainAsk: /ask, /signal, /instructions, /entities, /wiki/*,
// /people/suggest, /scribe-backfill). Config is mounted FIRST so a
// future '/' in brainAsk can't accidentally shadow '/brain' config reads.
// Any new endpoint in either router must verify there's no path collision.
v1.use('/brain', brainConfigRoutes);
v1.use('/brain', brainAskRoutes);
v1.use('/brain', userPromptOverlayRoutes);
v1.use('/decisions', decisionsRoutes);
v1.use('/thoughts', thoughtRoutes);
v1.use('/developer', developerRouter);
v1.use('/index', indexRoutes);
v1.use('/chat', chatRoutes);
// HaseebOS v15 — safety + risk gating + cascading undo + steering wheel
v1.use('/safety', safetyRoutes);
v1.use('/risk', riskRoutes);
v1.use('/actions', undoRoutes);
v1.use('/steering', steeringRoutes);
v1.use('/shadow', shadowRoutes);
v1.use('/feed', feedRoutes);
v1.use('/triage', triageRoutes);
v1.use('/wiki', wikiRoutes);
v1.use('/drafts', draftsRoutes);
v1.use('/brief', briefRoutes);

// Mount versioned API
app.use('/api/v1', v1);
// M3 — Backward-compatible /api alias. Marked as deprecated so clients can
// migrate. Emits RFC 8594 Deprecation + Sunset headers.
app.use('/api', (_req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', 'Wed, 31 Dec 2026 23:59:59 GMT');
  res.setHeader('Link', '</api/v1>; rel="successor-version"');
  next();
}, v1);
// External API — X-API-Key auth, separate prefix for clarity
app.use('/api/external/v1', externalApiRouter);
// WhatsApp webhooks — public (verified by signature, not session auth)
app.use('/api/v1', webhookRoutes);

// Error handler
app.use(errorHandler);

export default app;
