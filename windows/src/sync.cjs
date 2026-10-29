'use strict';

const tls = require('node:tls');
const { randomUUID, randomBytes, createHmac, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

const MAX_FRAME = 8 * 1024 * 1024;
const CIPHER = 'PSK-AES128-GCM-SHA256';
const IDENTITY = 'housecontrol';

function normalizePairing(value) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string') return null;
  const key = Buffer.isBuffer(value.key) ? value.key : typeof value.key === 'string' ? Buffer.from(value.key, 'base64') : null;
  if (!key || key.length !== 32) return null;
  return { id: value.id, name: value.name, key: key.toString('base64') };
}

function pairingLink(value) {
  const pairing = normalizePairing(value);
  if (!pairing) throw new Error('Invalid pairing');
  return `housecontrol://pair?v=1&id=${encodeURIComponent(pairing.id)}&name=${encodeURIComponent(pairing.name)}&key=${Buffer.from(pairing.key, 'base64').toString('base64url')}`;
}

function parsePairingLink(text) {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== 'housecontrol:' || url.hostname !== 'pair') return null;
    // URLComponents (Swift) keeps a literal +; URLSearchParams would turn it into a space.
    const items = new Map();
    for (const item of url.search.slice(1).split('&')) {
      const split = item.indexOf('=');
      const key = decodeURIComponent(split < 0 ? item : item.slice(0, split));
      if (!items.has(key)) items.set(key, decodeURIComponent(split < 0 ? '' : item.slice(split + 1)));
    }
    if (items.get('v') !== '1' || !/^[\w\-+/]+={0,2}$/.test(items.get('key') || '')) return null;
    return normalizePairing({ id: items.get('id'), name: items.get('name') ?? 'Windows', key: items.get('key') });
  } catch { return null; }
}

function deriveKey(pairing) {
  const normalized = normalizePairing(pairing);
  if (!normalized) throw new Error('Invalid pairing');
  return createHmac('sha256', Buffer.from(normalized.key, 'base64')).update('HouseControl sync v1', 'utf8').digest();
}

function planRevision(bytes) { return createHash('sha256').update(bytes).digest('hex').slice(0, 16); }

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (!body.length || body.length > MAX_FRAME) throw new Error('Invalid sync frame length');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** Handles partial headers, fragmented bodies and several frames per TCP packet. */
class FrameDecoder {
  constructor(onMessage) { this.onMessage = onMessage; this.pending = Buffer.alloc(0); this.length = null; }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const needed = (this.length === null ? 4 : this.length) - this.pending.length;
      const take = Math.min(needed, chunk.length - offset);
      this.pending = Buffer.concat([this.pending, chunk.subarray(offset, offset + take)]);
      offset += take;
      if (this.length === null && this.pending.length === 4) {
        this.length = this.pending.readUInt32BE(0);
        this.pending = Buffer.alloc(0);
        if (!this.length || this.length > MAX_FRAME) throw new Error('Invalid sync frame length');
      } else if (this.length !== null && this.pending.length === this.length) {
        const body = this.pending;
        this.pending = Buffer.alloc(0); this.length = null;
        let message;
        try { message = JSON.parse(body.toString('utf8')); } catch { continue; }
        if (message && typeof message === 'object' && !Array.isArray(message)) this.onMessage(message);
      }
    }
  }
}

function stateMessage(state, includePlan) {
  const message = { type: 'state', mac: state.macName || 'Windows', rev: state.revision || '',
    userCode: state.userCode || '', smartLife: !!state.smartLifeConnected };
  if (includePlan && state.plan != null) message.plan = Buffer.isBuffer(state.plan) ? state.plan.toString('utf8') : state.plan;
  if (state.connections != null) message.connections = state.connections;
  return message;
}

/** Implements the existing macOS/iOS/Android TLS-PSK protocol, without changing phones. */
class SyncServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.store = options.store || { read: () => null, write: () => {} };
    let saved;
    try { saved = this.store.read(); if (typeof saved === 'string') saved = JSON.parse(saved); } catch { saved = null; }
    this.pairing = normalizePairing(saved);
    this.snapshot = options.snapshot;
    this.onPeersChanged = options.onPeersChanged;
    this.onShowQR = options.onShowQR;
    this.onCatalog = options.onCatalog;
    this.onError = options.onError;
    this.listener = null; this.peers = new Map(); this.sockets = new Set();
    this.isAdvertised = false; this.bonjour = null; this.service = null; this.advertisingTimer = null;
    this.options = { advertise: true, port: 0, host: '0.0.0.0' };
  }
  get isEnabled() { return this.pairing !== null; }
  get port() { return this.listener?.address()?.port ?? null; }
  get connectedDevices() { return [...this.peers.values()].map(p => p.name).filter(Boolean).sort(); }
  get pairingLink() { return this.pairing ? pairingLink(this.pairing) : null; }
  _error(error) { this.onError?.(error); this.emit('syncError', error); }
  _changed() { this.onPeersChanged?.(); this.emit('peersChanged', this.connectedDevices); }
  async enable(name) {
    if (!this.pairing) return this.reset(name);
    if (this.pairing.name !== name) {
      this.pairing = { ...this.pairing, name };
      this.store.write(this.pairing);
      await this.stop();
    }
    await this.start();
    return this.pairing;
  }
  async reset(name) {
    await this.stop();
    this.pairing = { id: randomUUID(), name, key: randomBytes(32).toString('base64') };
    this.store.write(this.pairing);
    await this.start();
    return this.pairing;
  }
  async disable() { this.pairing = null; this.store.write(null); await this.stop(); }
  async start(options = {}) {
    this.options = { ...this.options, ...options };
    if (!this.pairing || this.listener) return;
    const psk = deriveKey(this.pairing);
    const listener = tls.createServer({ minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: CIPHER,
      pskIdentityHint: IDENTITY, pskCallback: (_socket, identity) => identity === IDENTITY ? psk : null,
      handshakeTimeout: 15000 }, socket => this._accept(socket));
    this.listener = listener;
    listener.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    // Authentication failures reveal no credentials and do not disrupt other paired phones.
    listener.on('tlsClientError', () => {});
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(this.options.port, this.options.host, () => { listener.off('error', reject); resolve(); });
      });
    } catch (error) { this.listener = null; throw error; }
    listener.on('error', error => this._error(error));
    if (this.options.advertise) {
      try {
        const { Bonjour } = require('bonjour-service');
        this.bonjour = new Bonjour({}, error => this._error(error));
        this.bonjour.server.mdns.on('error', error => this._error(error));
        this.bonjour.server.mdns.on('warning', error => this._error(error));
        this.service = this.bonjour.publish({ name: this.pairing.name, type: 'housecontrol', protocol: 'tcp',
          port: this.port, txt: { id: this.pairing.id } });
        this.service.on('up', () => {
          if (this.listener === listener) {
            clearTimeout(this.advertisingTimer); this.advertisingTimer = null;
            this.isAdvertised = true; this._changed();
          }
        });
        this.service.on('error', error => this._error(error));
        this.advertisingTimer = setTimeout(() => {
          if (this.listener === listener && !this.isAdvertised) {
            this._error(new Error('Phone discovery could not advertise this computer. Check the local network and whether another House Control instance uses this name.'));
          }
        }, 5000);
        this.advertisingTimer.unref();
      } catch (error) { this._error(error); }
    }
  }
  async stop() {
    this.isAdvertised = false;
    clearTimeout(this.advertisingTimer); this.advertisingTimer = null;
    const service = this.service, bonjour = this.bonjour;
    this.service = null; this.bonjour = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear(); this.peers.clear();
    const listener = this.listener; this.listener = null;
    if (listener) await new Promise(resolve => listener.close(resolve));
    if (bonjour) {
      // Send the DNS-SD goodbye before closing the multicast socket.
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 1000);
        const done = () => { clearTimeout(timeout); resolve(); };
        if (service) service.stop(done); else done();
      });
      bonjour.destroy();
    }
    this._changed();
  }
  _accept(socket) {
    socket.setNoDelay(true); socket.setKeepAlive(true, 20000);
    const peer = { socket, name: '', revision: '' };
    this.peers.set(socket, peer);
    const helloTimeout = setTimeout(() => { if (!peer.name) socket.destroy(); }, 15000);
    helloTimeout.unref();
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(helloTimeout);
      if (this.peers.delete(socket) && peer.name) this._changed();
    });
    const decoder = new FrameDecoder(message => this._handle(message, peer));
    socket.on('data', chunk => { try { decoder.push(chunk); } catch { socket.destroy(); } });
  }
  _handle(message, peer) {
    switch (message.type) {
      case 'hello': {
        const fresh = !peer.name;
        peer.name = typeof message.device === 'string' && message.device ? message.device : 'Android';
        peer.revision = typeof message.rev === 'string' ? message.rev : '';
        this._send(peer);
        if (fresh) this._changed();
        break;
      }
      case 'showQR':
        if (peer.name) {
          const content = typeof message.content === 'string' ? message.content : null;
          this.onShowQR?.(content, peer.name); this.emit('showQR', content, peer.name);
        }
        break;
      case 'catalog':
        if (peer.name && Array.isArray(message.devices) && message.devices.every(d => d && typeof d === 'object' && !Array.isArray(d))) {
          this.onCatalog?.(message.devices, peer.name); this.emit('catalog', message.devices, peer.name);
        }
        break;
    }
  }
  _send(peer, snapshot) {
    try {
      const state = snapshot ?? this.snapshot?.();
      if (!state) return;
      const frame = encodeFrame(stateMessage(state, state.revision !== peer.revision));
      // A stalled peer cannot accumulate an unbounded queue of whole floor plans.
      if (peer.socket.writableLength + frame.length > MAX_FRAME * 2) { peer.socket.destroy(); return; }
      peer.socket.write(frame); peer.revision = state.revision || '';
    } catch (error) { this._error(error); }
  }
  broadcast() {
    const snapshot = this.snapshot?.();
    if (snapshot) for (const peer of this.peers.values()) if (peer.name) this._send(peer, snapshot);
  }
}

module.exports = { SyncServer, MAX_FRAME, CIPHER, IDENTITY, normalizePairing, pairingLink, parsePairingLink,
  deriveKey, planRevision, encodeFrame, FrameDecoder, stateMessage };
