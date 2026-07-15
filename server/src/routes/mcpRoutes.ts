/**
 * MCP server endpoint — exposes the action handler registry as
 * Model Context Protocol tools.
 *
 * Single JSON-RPC 2.0 endpoint at `POST /api/v1/mcp`. The endpoint
 * supports the three core MCP methods MyOS clients (Claude Desktop,
 * Claude Code, third-party agents) need:
 *
 *   initialize     → handshake, returns server capabilities + version
 *   tools/list     → enumerate every registered action handler with
 *                    its name, description, and JSON-Schema input
 *   tools/call     → execute a tool via `executeViaRegistry`
 *
 * Auth: requires `Authorization: Bearer <tenant-bound agent token>` and
 * `X-Tenant-Id: <clientNumber>` (validated by `agentAuthMiddleware`),
 * OR a valid session cookie. Tenant scope is enforced by the same
 * AsyncLocalStorage middleware that wraps every other route.
 *
 * Risk-tier gate: tools the registry classifies as HIGH or CRITICAL
 * risk require an additional `requiresApproval` confirm in the call
 * payload — they're listed in tools/list with `dangerous: true` in
 * their description so MCP clients can warn before invoking.
 */
import { Router, Request, Response } from 'express';
import createLogger from '../utils/logger';

const log = createLogger('mcp');

const router = Router();

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

router.post('/', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) {
    return res.status(401).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'unauthenticated' },
    });
  }

  const rpc = req.body as JsonRpcRequest;
  if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    return res.status(400).json({
      jsonrpc: '2.0', id: rpc?.id ?? null,
      error: { code: -32600, message: 'invalid JSON-RPC request' },
    });
  }

  try {
    let result: unknown;
    switch (rpc.method) {
      case 'initialize':
        result = handleInitialize(rpc.params);
        break;
      case 'tools/list':
        result = await handleToolsList();
        break;
      case 'tools/call':
        result = await handleToolsCall(user, rpc.params);
        break;
      case 'ping':
        result = { ok: true };
        break;
      default:
        return res.json({
          jsonrpc: '2.0', id: rpc.id,
          error: { code: -32601, message: `method not found: ${rpc.method}` },
        } as JsonRpcResponse);
    }
    return res.json({ jsonrpc: '2.0', id: rpc.id, result } as JsonRpcResponse);
  } catch (err: any) {
    log.warn('mcp call failed', { method: rpc.method, error: err.message });
    return res.json({
      jsonrpc: '2.0', id: rpc.id ?? null,
      error: { code: -32000, message: err.message?.slice(0, 240) ?? 'internal error' },
    } as JsonRpcResponse);
  }
});

function handleInitialize(_params: any) {
  return {
    protocolVersion: '2024-11-05',
    serverInfo: { name: 'myos', version: '0.1.0' },
    capabilities: {
      tools: { listChanged: false },
    },
  };
}

async function handleToolsList() {
  const { listAll } = await import('../services/actions/handlerRegistry');
  const handlers = listAll();
  const tools = handlers.map((h) => {
    const meta = h.metadata();
    let dangerous = false;
    try {
      const r = h.riskLevel({ clientNumber: '', userId: 0, payload: {} } as any);
      const tier = (typeof (r as any)?.then === 'function') ? 'MEDIUM' : (r as any);
      dangerous = tier === 'HIGH' || tier === 'CRITICAL';
    } catch { /* leave dangerous=false */ }
    return {
      name: meta.name,
      description: dangerous
        ? `[DANGEROUS — requires explicit confirmation] ${meta.description}`
        : meta.description,
      inputSchema: h.schema(),
      // MyOS-specific extension fields (clients ignore unknown keys)
      _myos: { category: meta.category, version: meta.version, dangerous },
    };
  });
  return { tools };
}

async function handleToolsCall(user: any, params: any) {
  const name = String(params?.name ?? '');
  const args = params?.arguments ?? {};
  if (!name) throw new Error('tools/call requires a name');

  const { has } = await import('../services/actions/handlerRegistry');
  if (!has(name)) {
    throw new Error(`unknown tool: ${name}`);
  }

  const { executeViaRegistry } = await import('../services/actions/executeViaRegistry');
  let r: { ok: boolean; output?: unknown; error?: string; actionId?: number; traceId?: string };
  try {
    r = await executeViaRegistry({
      actionType: name,
      clientNumber: user.clientNumber,
      userId: user.id,
      payload: args,
      confidence: 0.9,
      executedByAgent: 'mcp:' + (user.agentId ?? 'session'),
    });
  } catch (err: any) {
    // Validation failures and other thrown errors become MCP isError
    // responses, not JSON-RPC -32000 errors. The MCP client expects to
    // see the failure as content so it can decide whether to retry
    // with corrected arguments.
    return {
      content: [{ type: 'text', text: err.message ?? 'tool call failed' }],
      isError: true,
      _myos: { error: err.message ?? 'unknown' },
    };
  }

  // Audit every tool call.
  try {
    const { audit } = await import('../services/auditLogService');
    await audit({
      clientNumber: user.clientNumber,
      actorId: user.id,
      actorKind: user.isAgent ? 'agent' : 'user',
      action: 'brain.action.executed',
      subjectType: 'mcp_tool',
      subjectId: name,
      result: r.ok ? 'success' : 'failure',
      details: {
        actionType: name,
        actionId: r.actionId,
        error: r.error ?? null,
      },
    });
  } catch { /* audit best-effort */ }

  // MCP convention — wrap output as content array for clients to render.
  return {
    content: [
      {
        type: 'text',
        text: typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? null),
      },
    ],
    isError: !r.ok,
    _myos: { actionId: r.actionId, error: r.error ?? null, traceId: r.traceId },
  };
}

export default router;
