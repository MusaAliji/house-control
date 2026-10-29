'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAgent } = require('../src/agent.cjs');

async function fixture(t, extra = {}) {
  let plan = { name: 'Before', rooms: [{ id: 'room' }] };
  const requests = [];
  const agent = createAgent({
    getPlan: () => plan,
    savePlan: next => { plan = next; },
    request: request => {
      requests.push(request);
      if (request.op === 'tools') return { tools: [{ name: 'get_home', inputSchema: { type: 'object' } }] };
      if (request.op === 'guide' || request.op === 'instructions') return { text: 'Home guide' };
      if (request.op === 'link') return { text: 'Action done', summary: 'Switched light on' };
      if (request.tool === 'edit_floor_plan') return { savePlan: { name: 'After', rooms: [{ id: 'room' }] }, content: [{ type: 'text', text: 'Saved' }] };
      if (request.tool === 'undo') return { undo: true };
      if (request.tool === 'fail') throw new Error('Device unavailable');
      return { content: [{ type: 'text', text: 'Home' }], structuredContent: { name: plan.name }, summary: 'Read home', quiet: true };
    }, ...extra,
  });
  t.after(() => agent.close());
  await agent.start();
  const call = async (route, body, headers = {}) => {
    const response = await fetch(`${agent.status().link}${route}`, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await response.text();
    return { response, body: text && (response.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : text };
  };
  return { agent, call, requests, plan: () => plan };
}

test('gateway binds loopback, authenticates, exposes guide, tools and OpenAPI', async t => {
  const { agent, call } = await fixture(t);
  assert.equal(agent.server.address().address, '127.0.0.1');
  assert.equal((await fetch(`${agent.base}/wrong/api/tools`)).status, 404);
  assert.equal((await call('')).body, 'Home guide');
  assert.equal((await call('/api/tools')).body.tools[0].name, 'get_home');
  assert.ok((await call('/openapi.json')).body.paths['/api/get_home']);
  assert.equal((await call('/plan.json')).body.data.name, 'Before');
});

test('REST and MCP use exact web tool backend and retain structured data', async t => {
  const { call, requests } = await fixture(t);
  const rest = await call('/api/call', { tool: 'get_home', arguments: { x: 1 } });
  assert.equal(rest.body.ok, true);
  assert.equal(rest.body.data.name, 'Before');
  const init = await call('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Test client' } } });
  const session = init.response.headers.get('mcp-session-id');
  assert.ok(session);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  const tools = await call('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_home' } }, { 'Mcp-Session-Id': session });
  assert.equal(tools.body.result.summary, undefined);
  assert.equal(requests.at(-1).client, 'Test client');
  const failed = await call('/api/fail', {});
  assert.equal(failed.response.status, 400);
  assert.match(failed.body.result, /Device unavailable/);
});

test('edit captures snapshot and undo restores it; disabled edit cannot save', async t => {
  const { agent, call, plan } = await fixture(t);
  await call('/api/edit_floor_plan', {});
  assert.equal(plan().name, 'After');
  assert.equal(agent.status().canUndo, true);
  await call('/api/undo', {});
  assert.equal(plan().name, 'Before');
  assert.equal(agent.status().canUndo, false);
  await agent.handle({ type: 'agent.settings', edit: false, control: false });
  const result = await call('/api/edit_floor_plan', {});
  assert.equal(result.body.ok, false);
  assert.equal(plan().name, 'Before');
});

test('HEAD action links cannot mutate and Origin requests are refused', async t => {
  const { agent, call, requests } = await fixture(t);
  const head = await fetch(`${agent.link}/do/light/on`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(requests.at(-1).op, 'guide');
  assert.equal((await call('/do/light/on', undefined, { Origin: 'https://hostile.example' })).response.status, 403);
  await call('/do/light/on');
  assert.equal(requests.at(-1).op, 'link');
});

test('new start revokes old secret and requests are rate limited', async t => {
  const { agent, call } = await fixture(t, { rateLimit: 2 });
  const oldSecret = agent.secret;
  await call('/api/tools'); await call('/api/tools');
  assert.equal((await call('/api/tools')).response.status, 429);
  agent.stop(); await agent.start();
  assert.notEqual(agent.secret, oldSecret);
  assert.equal((await fetch(`${agent.base}/${oldSecret}/api/tools`)).status, 404);
});

test('MCP notifications, malformed batches and size limits recover cleanly', async t => {
  const { agent, call } = await fixture(t, { maxBody: 256 });
  assert.equal((await call('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).response.status, 202);
  assert.equal((await call('/mcp', [])).body.error.code, -32600);
  assert.equal((await call('/mcp', null)).body.error.code, -32600);
  assert.equal((await call('/api/get_home', { value: 'x'.repeat(300) })).response.status, 413);
  assert.equal((await fetch(`${agent.link}/api/get_home`, { method: 'POST', body: '{' })).status, 400);
});

test('auto stop, settings and externally supplied snapshots are supported', async t => {
  let restored;
  const { agent, call } = await fixture(t, { getPlan: () => ({ active: 'demo', custom: null }), restorePlan: value => { restored = value; } });
  await call('/api/edit_floor_plan', {});
  await agent.undo();
  assert.deepEqual(restored, { active: 'demo', custom: null });
  await agent.handle({ type: 'agent.settings', autoStop: 'never' });
  assert.equal(agent.status().stopsAt, null);
  await agent.handle({ type: 'agent.settings', autoStop: '1h' });
  assert.equal(agent.status().stopsAt - agent.status().startedAt, 3_600_000);
});

function downloadFixture(t, { digest, source, payload = Buffer.from('mock Windows executable') } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'housecontrol-agent-download-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  const calls = [];
  const states = [];
  const agent = createAgent({ dataDirectory: directory, onStatus: s => states.push(s), fetch: async url => {
    calls.push(url);
    if (url.includes('api.github.com')) return new Response(JSON.stringify({ assets: [{ name: 'cloudflared-windows-amd64.exe', digest: digest === undefined ? `sha256:${hash}` : digest, size: payload.length, browser_download_url: source || 'https://github.com/cloudflare/cloudflared/releases/download/2026.1.0/cloudflared-windows-amd64.exe' }] }), { status: 200 });
    return new Response(payload, { status: 200 });
  } });
  t.after(() => agent.close());
  return { agent, directory, payload, calls, states };
}

test('optional Windows tunnel download verifies official SHA256 then atomically installs', async t => {
  const { agent, directory, payload, states } = downloadFixture(t);
  agent.phase = 'setup';
  await agent.handle({ type: 'agent.install' });
  assert.deepEqual(fs.readFileSync(path.join(directory, 'bin', 'cloudflared.exe')), payload);
  assert.equal(agent.status().state, 'off');
  assert.equal(agent.status().tunnel.installed, true);
  assert.equal(agent.status().tunnel.downloading, false);
  assert.equal(agent.status().tunnel.error, '');
  assert.ok(states.some(s => s.tunnel.downloading));
  assert.deepEqual(fs.readdirSync(path.join(directory, 'bin')), ['cloudflared.exe']);
});

test('missing GitHub digest rejects download before fetching executable', async t => {
  const { agent, directory, calls } = downloadFixture(t, { digest: null });
  await agent.handle({ type: 'agent.install' });
  assert.equal(calls.length, 1);
  assert.match(agent.status().tunnel.error, /SHA256 digest/);
  assert.equal(fs.existsSync(path.join(directory, 'bin', 'cloudflared.exe')), false);
});

test('digest mismatch deletes temporary executable and preserves existing install', async t => {
  const { agent, directory } = downloadFixture(t, { digest: `sha256:${'0'.repeat(64)}` });
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.writeFileSync(path.join(directory, 'bin', 'cloudflared.exe'), 'existing');
  await agent.handle({ type: 'agent.install' });
  assert.match(agent.status().tunnel.error, /verification failed/);
  assert.equal(fs.readFileSync(path.join(directory, 'bin', 'cloudflared.exe'), 'utf8'), 'existing');
  assert.deepEqual(fs.readdirSync(path.join(directory, 'bin')), ['cloudflared.exe']);
});

test('unofficial asset addresses are rejected', async t => {
  const { agent, calls } = downloadFixture(t, { source: 'https://other.example/cloudflared.exe' });
  await agent.installTunnel();
  assert.equal(calls.length, 1);
  assert.match(agent.status().tunnel.error, /not an official/);
});

test('missing tunnel opens setup and an absent explicit path still falls back to PATH', async t => {
  const { agent, directory } = downloadFixture(t);
  const previousPath = process.env.PATH;
  t.after(() => { process.env.PATH = previousPath; });
  process.env.PATH = '';
  await agent.start('internet');
  assert.equal(agent.status().state, 'setup');
  fs.writeFileSync(path.join(directory, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'), 'fake');
  process.env.PATH = directory;
  assert.equal(agent.status().tunnel.installed, true);
});
