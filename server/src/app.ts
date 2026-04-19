import express, { Router } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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
import authRoutes from './routes/authRoutes';
import userAuthRoutes from './routes/userAuthRoutes';
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
// MyOS routes
import connectorRoutes from './routes/connectorRoutes';
import connectorAdminRoutes from './routes/admin/connectorAdminRoutes';
import openItemsRoutes from './routes/openItemsRoutes';
import entityRoutes from './routes/entityRoutes';
import brainConfigRoutes from './routes/brainConfigRoutes';
import decisionsRoutes from './routes/decisionsRoutes';
import thoughtRoutes from './routes/thoughtRoutes';
import { requestIdMiddleware } from './middleware/requestId';
import { requestLoggerMiddleware } from './middleware/requestLogger';
import { killSwitchMiddleware } from './middleware/killSwitchMiddleware';
import { agentAuthMiddleware } from './middleware/agentAuthMiddleware';

const app = express();

// Request ID — must be first middleware so all downstream logs include it
app.use(requestIdMiddleware);

// Production monitoring — log every request with timing & user info
app.use(requestLoggerMiddleware);

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Disabled — CSP is the modern replacement
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

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

v1.use('/health', healthRoutes);
v1.use('/user', userAuthRoutes);
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
// MyOS endpoints
v1.use('/connectors', connectorRoutes);
v1.use('/admin/connectors', connectorAdminRoutes);
v1.use('/open-items', openItemsRoutes);
v1.use('/entities', entityRoutes);
v1.use('/brain', brainConfigRoutes);
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

// Mount versioned API
app.use('/api/v1', v1);
// Backward compatibility — existing /api/ paths keep working
app.use('/api', v1);
// External API — X-API-Key auth, separate prefix for clarity
app.use('/api/external/v1', externalApiRouter);
// WhatsApp webhooks — public (verified by signature, not session auth)
app.use('/api/v1', webhookRoutes);

// Error handler
app.use(errorHandler);

export default app;
