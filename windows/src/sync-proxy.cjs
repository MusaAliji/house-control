'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
class DesktopSync {
  constructor(options) {
    this.options = options; this.pending = new Map(); this.sequence = 0;
    this.state = { connectedDevices: [], isEnabled: false, isAdvertised: false };
  }
  async start() {
    const child = fork(path.join(__dirname, 'sync-worker.cjs'), [], {
      execPath: this.options.nodePath, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    this.child = child;
    child.stderr.on('data', () => {}); // Never log pairing secrets or state credentials.
    child.on('error', error => this.options.onError?.(error));
    child.on('message', message => {
      if (message.state) { this.state = message.state; this.options.onPeersChanged?.(); }
      if (message.event === 'persist') this.options.store.set('sync', message.value);
      if (message.event === 'showQR') this.options.onShowQR?.(message.content, message.device);
      if (message.event === 'failure') this.options.onError?.(new Error(message.error));
      if (message.event === 'catalog') this.options.onCatalog?.(message.devices, message.device);
      if (message.id) {
        const request = this.pending.get(message.id); if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
      }
    });
    child.on('exit', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Phone sync stopped.')); }
      this.pending.clear(); this.state.connectedDevices = []; this.state.isAdvertised = false;
      this.options.onPeersChanged?.();
      if (!this.closing) this.restartTimer = setTimeout(() => this.start().catch(this.options.onError), 3000);
    });
    await this.call('init', { pairing: this.options.store.get('sync'), snapshot: this.options.snapshot() });
  }
  call(action, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child?.connected) return reject(new Error('Phone sync is unavailable.'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Phone sync timed out.')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, action, ...payload }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  enable(name) { return this.call('enable', { name }); }
  reset(name) { return this.call('reset', { name }); }
  disable() { return this.call('disable'); }
  broadcast() { return this.call('snapshot', { value: this.options.snapshot() }); }
  async close() { this.closing = true; clearTimeout(this.restartTimer); if (this.child?.connected) { await this.call('stop').catch(() => {}); this.child.disconnect(); } }
}
module.exports = { DesktopSync };
