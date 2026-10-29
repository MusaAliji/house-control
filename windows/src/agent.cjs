'use strict';

// Native counterpart of macOS AgentController + HouseCore AgentGateway. The
// existing panel owns tool schemas, permissions and device state on both hosts.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const token = () => crypto.randomBytes(16).toString('base64url');
const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const same = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function findCloudflared(explicit) {
  const candidates = [explicit, ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(p => path.join(p, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'))].filter(Boolean);
  return candidates.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

class AgentController {
  constructor(options = {}) {
    this.options = options;
    if (!options.cloudflared && options.dataDirectory) options.cloudflared = path.join(options.dataDirectory, 'bin', 'cloudflared.exe');
    this.settings = { reach: 'local', autoStop: '8h', control: true, edit: true, ...options.settings };
    this.activity = [];
    this.history = [];
    this.sessions = new Map();
    this.recent = [];
    this.rateLimit = options.rateLimit ?? 240;
    this.secret = token();
    this.phase = 'off';
    this.server = null;
    this.generation = 0;
  }

  status() {
    return { ...this.settings, state: this.phase, error: this.error || '',
      canUndo: !!this.history.length, activity: this.activity.slice(-80),
      home: this.options.home?.() || 'My home',
      tunnel: { installed: !!findCloudflared(this.options.cloudflared), downloading: !!this.downloading, error: this.installError || '' },
      ...(this.phase === 'live' ? { link: this.link, mcp: `${this.link}/mcp`, startedAt: this.startedAt, stopsAt: this.stopsAt } : {}),
    };
  }

  push() { this.options.onStatus?.(this.status()); }
  log(client, title, ok = true, quiet = false) {
    this.activity.push({ time: Date.now(), client, title, ok, quiet });
    if (this.activity.length > 200) this.activity.shift();
    this.push();
  }

  async handle(message) {
    switch (message.type) {
      case 'agent.start': return this.start(message.reach);
      case 'agent.stop': return this.stop();
      case 'agent.settings':
        for (const key of ['control', 'edit']) if (typeof message[key] === 'boolean') this.settings[key] = message[key];
        if (['1h', '8h', 'never'].includes(message.autoStop)) this.settings.autoStop = message.autoStop;
        if (!['live', 'starting'].includes(this.phase) && ['local', 'internet'].includes(message.reach)) this.settings.reach = message.reach;
        this.options.saveSettings?.(clone(this.settings));
        if (this.phase === 'live') this.scheduleStop();
        break;
      case 'agent.undo':
        try { await this.undo(); } catch (error) { this.log('House Control', error.message, false); }
        break;
      case 'agent.copy': this.options.clipboard?.(String(message.text || '')); break;
      case 'agent.open':
        try { const url = new URL(message.url); if (['http:', 'https:'].includes(url.protocol)) await this.options.openExternal?.(url.href); } catch { /* Invalid external URL. */ }
        break;
      case 'agent.install':
        return this.installTunnel();
      case 'ready': break;
      default: return false;
    }
    this.push();
    return true;
  }

  async start(reach) {
    if (['starting', 'live'].includes(this.phase)) return;
    if (['local', 'internet'].includes(reach)) this.settings.reach = reach;
    const executable = findCloudflared(this.options.cloudflared);
    if (this.settings.reach === 'internet' && !executable) {
      this.phase = 'setup'; this.error = 'Cloudflared is required for internet access. Install it or select This PC only.'; this.push(); return;
    }
    const generation = ++this.generation;
    this.secret = token(); this.sessions.clear(); this.recent = [];
    this.phase = 'starting'; this.error = ''; this.push();
    try {
      const server = http.createServer((req, res) => this.serve(req, res));
      this.server = server;
      server.requestTimeout = 30_000;
      server.headersTimeout = 15_000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port ?? 0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      if (generation !== this.generation) return;
      const base = `http://127.0.0.1:${server.address().port}`;
      this.base = this.settings.reach === 'internet' ? await this.openTunnel(executable, base) : base;
      if (generation !== this.generation) return;
      this.link = `${this.base}/${this.secret}`;
      this.phase = 'live'; this.startedAt = Date.now(); this.scheduleStop();
      this.log('House Control', this.settings.reach === 'local' ? 'Started on this PC' : 'Link is live');
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop(); this.phase = 'error'; this.error = error.message; this.push();
    }
  }

  async installTunnel() {
    if (this.downloading) return;
    this.downloading = true; this.installError = ''; this.push();
    let temporary;
    let file;
    try {
      if (!this.options.dataDirectory) throw new Error('The app data directory is unavailable.');
      const fetchFile = this.options.fetch || globalThis.fetch;
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'HouseControl-Windows' };
      const release = await fetchFile('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { headers, signal: AbortSignal.timeout(30_000) });
      if (!release.ok) throw new Error(`GitHub release lookup answered ${release.status}.`);
      const metadata = await release.json();
      const asset = metadata.assets?.find(a => a.name === 'cloudflared-windows-amd64.exe');
      if (!asset) throw new Error('The official release has no Windows AMD64 executable.');
      if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('GitHub did not provide a SHA256 digest; the executable was not downloaded.');
      const source = new URL(asset.browser_download_url);
      if (source.protocol !== 'https:' || source.hostname !== 'github.com' || !source.pathname.startsWith('/cloudflare/cloudflared/releases/download/')) throw new Error('The release download address is not an official Cloudflare GitHub asset.');
      const response = await fetchFile(source.href, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'HouseControl-Windows' } });
      if (!response.ok || !response.body) throw new Error(`GitHub asset download answered ${response.status}.`);
      const directory = path.join(this.options.dataDirectory, 'bin');
      await fs.promises.mkdir(directory, { recursive: true });
      temporary = path.join(directory, `cloudflared-${crypto.randomUUID()}.download`);
      file = await fs.promises.open(temporary, 'wx');
      const hash = crypto.createHash('sha256');
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 128 * 1024 * 1024) throw new Error('The executable exceeds the 128 MB download limit.');
        hash.update(chunk); await file.writeFile(chunk);
      }
      if (!length || (Number.isSafeInteger(asset.size) && asset.size !== length)) throw new Error('The downloaded executable size does not match the official release.');
      if (!same(hash.digest('hex'), asset.digest.slice(7).toLowerCase())) throw new Error('SHA256 verification failed; the downloaded executable was discarded.');
      await file.sync(); await file.close(); file = null;
      const destination = path.join(directory, 'cloudflared.exe');
      await fs.promises.rename(temporary, destination); temporary = null;
      this.options.cloudflared = destination;
      if (this.phase === 'setup') { this.phase = 'off'; this.error = ''; }
    } catch (error) {
      this.installError = error.message;
    } finally {
      if (file) await file.close().catch(() => {});
      if (temporary) await fs.promises.unlink(temporary).catch(() => {});
      this.downloading = false; this.push();
    }
  }

  openTunnel(executable, base) {
    return new Promise((resolve, reject) => {
      // A fixed executable and argument vector; AI input never becomes a process command.
      const args = ['tunnel', '--no-autoupdate'];
      if (this.options.dataDirectory) {
        const config = path.join(this.options.dataDirectory, 'cloudflared.yml');
        fs.writeFileSync(config, '# House Control quick tunnel\n');
        args.push('--config', config);
      }
      args.push('--metrics', '127.0.0.1:0', '--url', base);
      const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      this.tunnel = child;
      let output = '', settled = false;
      const finish = (error, url) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(url); };
      const timer = setTimeout(() => finish(new Error('Cloudflare tunnel did not connect within 60 seconds.')), 60_000);
      this.cancelTunnel = () => finish(new Error('Tunnel cancelled.'));
      const consume = chunk => {
        output = (output + chunk).slice(-20_000);
        const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (url && output.includes('Registered tunnel connection')) finish(null, url[0]);
      };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.on('error', error => finish(error));
      child.on('exit', () => {
        finish(new Error('Cloudflare tunnel stopped.'));
        if (this.tunnel === child && this.phase === 'live') { this.stop(); this.phase = 'error'; this.error = 'Cloudflare tunnel stopped.'; this.push(); }
      });
    });
  }

  scheduleStop() {
    clearTimeout(this.stopTimer);
    const hours = { '1h': 1, '8h': 8 }[this.settings.autoStop];
    this.stopsAt = hours ? this.startedAt + hours * 3_600_000 : null;
    if (hours) { this.stopTimer = setTimeout(() => this.stop('Stopped automatically'), Math.max(1, this.stopsAt - Date.now())); this.stopTimer.unref?.(); }
  }

  stop(reason = 'Stopped') {
    ++this.generation;
    clearTimeout(this.stopTimer);
    this.cancelTunnel?.(); this.cancelTunnel = null;
    const child = this.tunnel; this.tunnel = null; child?.kill();
    this.server?.closeAllConnections(); this.server?.close(); this.server = null;
    const wasLive = this.phase === 'live';
    this.phase = 'off'; this.secret = token(); this.sessions.clear(); this.link = null;
    this.startedAt = null; this.stopsAt = null;
    if (wasLive) this.log('House Control', `${reason} — the link no longer works`);
    this.push();
  }
  close() { this.stop(); }

  async undo() {
    const previous = this.history.at(-1);
    if (!previous) throw new Error('There is no floor plan change to undo.');
    if (this.options.restorePlan) await this.options.restorePlan(clone(previous));
    else await this.options.savePlan(clone(previous));
    this.history.pop();
    this.log('House Control', 'Undid the last floor plan change');
  }

  async ask(request) {
    if (!this.options.request) throw new Error('House Control is still loading the home.');
    let result = await this.options.request({ ...request, permissions: { control: this.settings.control, edit: this.settings.edit }, base: this.link });
    if (typeof result === 'string') result = JSON.parse(result);
    if (!result || typeof result !== 'object') throw new Error('The panel returned an invalid tool response.');
    if (result.savePlan) {
      if (!this.settings.edit) throw new Error('Floor plan editing is disabled.');
      const previous = clone(await this.options.getPlan());
      await this.options.savePlan(result.savePlan);
      this.history.push(previous); if (this.history.length > 30) this.history.shift();
      delete result.savePlan; this.push();
    }
    if (result.undo) {
      if (!this.settings.edit) throw new Error('Floor plan editing is disabled.');
      await this.undo(); delete result.undo;
      result.content = [{ type: 'text', text: 'Undone: the floor plan is back to how it was before the last change.' }];
    }
    return result;
  }

  async call(name, args, client) {
    try {
      const result = await this.ask({ op: 'call', tool: name, arguments: args, client });
      if (result.summary) this.log(client, result.summary, !result.isError, !!result.quiet);
      return result;
    } catch (error) {
      this.log(client, `${name} failed: ${error.message}`, false);
      return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  }

  async serve(req, res) {
    const send = (status, body, type = 'application/json', headers = {}) => {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', ...headers });
      res.end(req.method === 'HEAD' ? '' : data);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (!parts.length || !same(parts.shift(), this.secret)) return send(404, 'Not found\n', 'text/plain');
      // Cross-site pages must not invoke actions on a locally reachable secret URL.
      if (req.headers.origin) return send(403, { error: 'Browser cross-origin requests are not permitted.' });
      this.recent = this.recent.filter(t => t > Date.now() - 60_000);
      if (this.recent.length >= this.rateLimit) return send(429, { error: 'Too many requests. Wait a minute.' });
      this.recent.push(Date.now());
      const client = this.sessions.get(req.headers['mcp-session-id']) || 'AI agent';
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      const route = parts.join('/');
      if (method === 'GET' && ['', 'guide', 'llms.txt'].includes(route)) {
        const result = await this.ask({ op: 'guide' });
        this.log(client, 'Read the guide', true, true);
        return send(200, result.text || '', 'text/markdown; charset=utf-8');
      }
      if (method === 'GET' && parts[0] === 'do') {
        const result = await this.ask(req.method === 'HEAD' ? { op: 'guide' } : { op: 'link', path: parts.slice(1), client });
        if (result.summary) this.log(client, result.summary, result.ok !== false);
        return send(result.status || 200, result.text || '', 'text/markdown; charset=utf-8');
      }
      if (method === 'GET' && route === 'api/tools') return send(200, await this.ask({ op: 'tools' }));
      if (method === 'GET' && route === 'openapi.json') {
        const { tools = [] } = await this.ask({ op: 'tools' });
        const paths = Object.fromEntries(tools.map(t => [`/api/${t.name}`, { post: { operationId: t.name, summary: t.title || t.name, description: t.description || '', requestBody: { content: { 'application/json': { schema: t.inputSchema || { type: 'object' } } } }, responses: { 200: { description: 'Tool result' } } } }]));
        return send(200, { openapi: '3.1.0', info: { title: 'House Control', version: '1.0' }, servers: [{ url: this.link }], paths });
      }
      if (route === 'mcp' && method === 'DELETE') { this.sessions.delete(req.headers['mcp-session-id']); return send(204, ''); }
      if (route === 'mcp' && method === 'GET') return send(405, '', 'application/json', { Allow: 'POST, DELETE' });
      if (!(method === 'POST' && (route === 'mcp' || parts[0] === 'api' && parts.length === 2)) && !(method === 'GET' && route === 'plan.json')) return send(404, 'Not found\n', 'text/plain');
      let body = {};
      if (method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > (this.options.maxBody || 4 * 1024 * 1024)) return send(413, { error: 'Request body too large.' });
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, route === 'mcp' ? rpcError(null, -32700, 'Parse error') : { error: 'The body must be JSON.' }); }
      }
      if (route === 'mcp') return this.mcp(body, client, send);
      if (!body || Array.isArray(body) || typeof body !== 'object') return send(400, { error: 'The body must be a JSON object.' });
      const name = route === 'plan.json' ? 'get_floor_plan' : parts[1] === 'call' ? body.tool : parts[1];
      if (typeof name !== 'string') return send(400, { error: 'Missing tool name.' });
      const result = await this.call(name, parts[1] === 'call' ? body.arguments || {} : body, client);
      const out = { ok: !result.isError, result: (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n\n') };
      if (result.structuredContent !== undefined) out.data = result.structuredContent;
      const image = result.content?.find(c => c.type === 'image');
      if (image) out.image = `data:${image.mimeType};base64,${image.data}`;
      return send(result.isError ? 400 : 200, out);
    } catch (error) { if (!res.headersSent) send(503, { error: error.message }); else res.end(); }
  }

  async mcp(body, client, send) {
    let session;
    const one = async message => {
      if (!message || Array.isArray(message) || typeof message !== 'object') return rpcError(null, -32600, 'Invalid request');
      if (typeof message.method !== 'string') return rpcError(message.id, -32600, 'Invalid request');
      if (message.id == null) return null;
      const { id, method, params = {} } = message;
      switch (method) {
        case 'initialize': {
          session = crypto.randomUUID();
          this.sessions.set(session, String(params.clientInfo?.title || params.clientInfo?.name || client).slice(0, 100));
          const instructions = await this.ask({ op: 'instructions' });
          return rpc(id, { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'house-control', title: 'House Control', version: '1.0' }, instructions: instructions.text || '' });
        }
        case 'ping': return rpc(id, {});
        case 'tools/list': return rpc(id, await this.ask({ op: 'tools' }));
        case 'tools/call': {
          if (typeof params.name !== 'string') return rpcError(id, -32602, 'Missing tool name');
          const result = await this.call(params.name, params.arguments || {}, this.sessions.get(session) || client);
          delete result.summary; delete result.quiet; return rpc(id, result);
        }
        case 'resources/list': return rpc(id, { resources: [] });
        case 'resources/templates/list': return rpc(id, { resourceTemplates: [] });
        case 'prompts/list': return rpc(id, { prompts: [] });
        default: return rpcError(id, -32601, `Method not found: ${method}`);
      }
    };
    const results = [];
    const batch = Array.isArray(body);
    if (batch && !body.length) return send(400, rpcError(null, -32600, 'Invalid request'));
    for (const message of batch ? body : [body]) {
      try { const result = await one(message); if (result) results.push(result); }
      catch (error) { results.push(rpcError(message?.id, -32603, error.message)); }
    }
    send(results.length ? 200 : 202, results.length ? batch ? results : results[0] : '', 'application/json', session ? { 'Mcp-Session-Id': session } : {});
  }
}

module.exports = { AgentController, createAgent: options => new AgentController(options) };
