/**
 * smokeMcp.ts — verify the MCP JSON-RPC endpoint logic without going
 * over HTTP. Calls the route handlers directly with synthetic
 * `req`/`res` shims and a registered handler registry.
 */
import { runWithoutTenant } from '../db/tenantContext';
import prisma from '../db/prisma';

async function callRoute(rpc: any, user: any) {
  // Mount the handler registry first so listAll() returns real tools.
  const { registerAllHandlers } = await import('../services/actions/handlers');
  registerAllHandlers();
  // Pull the route module directly and invoke its handler. We can't go
  // through Express here, so we build a thin req/res that captures the
  // outcome.
  const mcp = (await import('../routes/mcpRoutes')).default as any;
  const layer = (mcp.stack ?? []).find((s: any) => s.route?.path === '/');
  const handler = layer?.route?.stack?.find((s: any) => s.method === 'post')?.handle;
  if (!handler) throw new Error('MCP POST handler not found in router');

  let captured: any = null;
  let statusCode = 200;
  const req: any = { user, body: rpc };
  const res: any = {
    status(code: number) { statusCode = code; return res; },
    json(payload: any) { captured = { statusCode, payload }; return res; },
  };
  await handler(req, res, () => {});
  return captured;
}

async function main() {
  await runWithoutTenant(async () => {
    const fakeUser = { id: 5, clientNumber: 'TMC-0001', userType: 'AD', isAgent: false };

    // 1. initialize
    console.log('\n=== 1. initialize ===');
    const init = await callRoute(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      fakeUser,
    );
    console.log('result:', init?.payload?.result);

    // 2. tools/list
    console.log('\n=== 2. tools/list ===');
    const list = await callRoute(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      fakeUser,
    );
    const tools = list?.payload?.result?.tools ?? [];
    console.log('tool count:', tools.length);
    console.log('first 5:', tools.slice(0, 5).map((t: any) => `${t.name}${t._myos?.dangerous ? ' ⚠' : ''}`).join(', '));
    console.log('categories:', [...new Set(tools.map((t: any) => t._myos?.category))].join(', '));

    // 3. tools/call (a safe one — tag_entity)
    console.log('\n=== 3. tools/call tag_entity ===');
    const call = await callRoute(
      { jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'tag_entity', arguments: { entityId: 'mcp:smoke', tags: ['mcp-smoke'] } } },
      fakeUser,
    );
    console.log('isError:', call?.payload?.result?.isError);
    console.log('content:', call?.payload?.result?.content?.[0]?.text?.slice(0, 100));

    // 4. unknown method
    console.log('\n=== 4. unknown method ===');
    const bad = await callRoute(
      { jsonrpc: '2.0', id: 4, method: 'foo/bar', params: {} },
      fakeUser,
    );
    console.log('error.code:', bad?.payload?.error?.code, '/', bad?.payload?.error?.message);

    // 5. unauthenticated
    console.log('\n=== 5. unauthenticated ===');
    const unauth = await callRoute(
      { jsonrpc: '2.0', id: 5, method: 'tools/list' },
      {},
    );
    console.log('status:', unauth?.statusCode, 'error:', unauth?.payload?.error?.message);

    console.log('\n=== ASSERTIONS ===');
    const asserts = [
      ['initialize returns serverInfo', !!init?.payload?.result?.serverInfo],
      ['tools/list returns tools array', Array.isArray(tools) && tools.length > 0],
      ['tools have inputSchema', tools.length === 0 || !!tools[0].inputSchema],
      ['tools/call returns content', !!call?.payload?.result?.content],
      ['unknown method returns -32601', bad?.payload?.error?.code === -32601],
      ['unauthenticated returns 401', unauth?.statusCode === 401],
    ];
    for (const [name, ok] of asserts) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  });

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
