'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { SyncServer, MAX_FRAME, CIPHER, IDENTITY, pairingLink, parsePairingLink, deriveKey,
  planRevision, encodeFrame, FrameDecoder } = require('../src/sync.cjs');

function memoryStore() { let value = null; return { read: () => value, write: next => { value = next; } }; }
function pairing() { return { id: 'companion-1', name: 'Studio + Windows', key: Buffer.alloc(32, 7).toString('base64') }; }
async function serverFor(t, snapshot) {
  const store = memoryStore(); store.write(pairing());
  const server = new SyncServer({ store, snapshot });
  await server.start({ advertise: false, host: '127.0.0.1' });
  t.after(() => server.stop()); return server;
}
function connect(server, key = server.pairing) {
  const socket = tls.connect({ host: '127.0.0.1', port: server.port, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
    ciphers: CIPHER, rejectUnauthorized: false, pskCallback: () => ({ identity: IDENTITY, psk: deriveKey(key) }) });
  socket.on('error', () => {}); return socket;
}
function inbox(socket) {
  const queued = []; const waiting = [];
  const decoder = new FrameDecoder(message => waiting.length ? waiting.shift()(message) : queued.push(message));
  socket.on('data', bytes => decoder.push(bytes));
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiting.push(resolve));
}

test('pairing link matches Swift/Android escaping, binary key and literal plus', () => {
  const p = pairing();
  assert.deepEqual(parsePairingLink(`  ${pairingLink(p)}\n`), p);
  assert.equal(parsePairingLink(pairingLink(p).replace('Studio%20%2B%20Windows', 'Studio+Windows')).name, 'Studio+Windows');
  for (const value of ['https://pair?v=1', 'housecontrol://pair?v=2', 'housecontrol://pair?v=1&id=x&key=short']) {
    assert.equal(parsePairingLink(value), null);
  }
  const vector = { ...p, key: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64') };
  assert.equal(deriveKey(vector).toString('hex'), 'f752501247f992b8c8a906e77f37d24b3c56baafc89675fec1780ad85a4fb042');
  assert.equal(planRevision('abc'), 'ba7816bf8f01cfea');
});

test('framing reads fragmented headers, Unicode payloads, coalesced packets and skips malformed JSON', () => {
  const messages = [], decoder = new FrameDecoder(m => messages.push(m));
  const frame = Buffer.concat([encodeFrame({ type: 'hello', device: 'Téléphone' }), Buffer.from([0, 0, 0, 1, 120]), encodeFrame({ type: 'showQR' })]);
  for (const byte of frame) decoder.push(Buffer.from([byte]));
  assert.deepEqual(messages, [{ type: 'hello', device: 'Téléphone' }, { type: 'showQR' }]);
  for (const size of [0, MAX_FRAME + 1, 0xffffffff]) {
    const bytes = Buffer.alloc(4); bytes.writeUInt32BE(size);
    assert.throws(() => new FrameDecoder(() => {}).push(bytes), /length/);
  }
  assert.throws(() => encodeFrame({ plan: 'x'.repeat(MAX_FRAME) }), /length/);
});

test('real TLS1.2 PSK handshake delivers state, credentials, revisions and pushed updates', { timeout: 10000 }, async t => {
  let plan = '{"name":"Apartment","rooms":[{"id":"living"}]}';
  const snapshot = () => ({ macName: 'Windows desktop', revision: planRevision(plan), plan,
    userCode: 'account-code', smartLifeConnected: true,
    connections: { homeassistant: { url: 'http://ha.local:8123', token: 'secret' }, hue: { host: '192.168.1.4', key: 'bridge-key' } } });
  const server = await serverFor(t, snapshot);
  const socket = connect(server); t.after(() => socket.destroy());
  const next = inbox(socket); await once(socket, 'secureConnect');
  assert.equal(socket.getProtocol(), 'TLSv1.2');
  assert.equal(socket.getCipher().standardName, 'TLS_PSK_WITH_AES_128_GCM_SHA256');
  socket.write(encodeFrame({ type: 'hello', device: 'Pixel 9', rev: '' }));
  const first = await next();
  assert.equal(first.type, 'state'); assert.equal(first.plan, plan);
  assert.equal(first.connections.homeassistant.token, 'secret');
  assert.deepEqual(server.connectedDevices, ['Pixel 9']);
  socket.write(encodeFrame({ type: 'hello', device: 'Pixel 9', rev: first.rev }));
  assert.equal((await next()).plan, undefined);
  plan = '{"name":"Updated","rooms":[{"id":"bed"}]}'; server.broadcast();
  assert.equal((await next()).plan, plan);
});

test('QR and catalog require hello, retain QR when phone disconnects, and support explicit hide', { timeout: 10000 }, async t => {
  const server = await serverFor(t, () => ({ revision: '' }));
  const socket = connect(server); t.after(() => socket.destroy());
  const next = inbox(socket); await once(socket, 'secureConnect');
  const shown = []; const catalogs = [];
  server.onShowQR = (...args) => shown.push(args);
  server.onCatalog = (...args) => catalogs.push(args);
  socket.write(encodeFrame({ type: 'showQR', content: 'ignored' }));
  socket.write(encodeFrame({ type: 'hello', device: 'Pixel', rev: '' })); await next();
  let event = once(server, 'showQR');
  socket.write(encodeFrame({ type: 'showQR', content: 'tuyaSmart--qrLogin?token=t1' })); await event;
  event = once(server, 'catalog');
  socket.write(encodeFrame({ type: 'catalog', devices: [{ id: 'light.1', name: 'Hall lamp', kind: 'light' }] })); await event;
  assert.deepEqual(shown, [['tuyaSmart--qrLogin?token=t1', 'Pixel']]);
  assert.equal(catalogs[0][0][0].name, 'Hall lamp');
  event = once(server, 'showQR'); socket.write(encodeFrame({ type: 'showQR' })); await event;
  assert.deepEqual(shown[1], [null, 'Pixel']);
  const gone = once(server, 'peersChanged'); socket.destroy(); await gone;
  assert.equal(shown.length, 2); assert.deepEqual(server.connectedDevices, []);
});

test('wrong PSK fails before snapshot or application messages', { timeout: 10000 }, async t => {
  let served = false;
  const server = await serverFor(t, () => { served = true; return { revision: '' }; });
  const socket = connect(server, { ...pairing(), key: Buffer.alloc(32, 9).toString('base64') });
  t.after(() => socket.destroy());
  await once(socket, 'error');
  assert.equal(served, false); assert.deepEqual(server.connectedDevices, []);
});

test('authenticated malformed frame closes only the offending connection', { timeout: 10000 }, async t => {
  const server = await serverFor(t, () => ({ revision: '' }));
  const socket = connect(server); t.after(() => socket.destroy());
  await once(socket, 'secureConnect');
  const closed = once(socket, 'close');
  socket.write(Buffer.from([255, 255, 255, 255])); await closed;
  assert.deepEqual(server.connectedDevices, []); assert.ok(server.port);
});

test('pairing persists, rename keeps key, reset revokes key, disable deletes pairing', { timeout: 10000 }, async t => {
  const store = memoryStore();
  const server = new SyncServer({ store });
  // Configure tests without advertising before enabling any listener.
  await server.start({ advertise: false, host: '127.0.0.1' });
  t.after(() => server.stop());
  const first = await server.enable('Old desktop');
  assert.deepEqual(new SyncServer({ store }).pairing, first);
  const renamed = await server.enable('New desktop');
  assert.equal(renamed.key, first.key); assert.equal(renamed.id, first.id);
  const fresh = await server.reset('New desktop');
  assert.notEqual(fresh.key, first.key); assert.notEqual(fresh.id, first.id);
  await server.disable();
  assert.equal(new SyncServer({ store }).pairing, null); assert.equal(server.port, null);
});

test('Android BouncyCastle transport interoperates with Node TLS server', { timeout: 30000 }, async t => {
  // Reuse Android's exact BC version when its Gradle dependency cache is present.
  // CI can provide BC_CLASSPATH and JAVA_HOME explicitly without an Android SDK.
  let jars = process.env.BC_CLASSPATH;
  if (!jars) {
    const root = path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1/org.bouncycastle');
    const found = [];
    for (const artifact of ['bctls-jdk18on', 'bcprov-jdk18on', 'bcutil-jdk18on']) {
      const folder = path.join(root, artifact, '1.83');
      if (fs.existsSync(folder)) {
        for (const hash of fs.readdirSync(folder)) {
          const file = path.join(folder, hash, `${artifact}-1.83.jar`);
          if (fs.existsSync(file)) found.push(file);
        }
      }
    }
    if (found.length === 3) jars = found.join(path.delimiter);
  }
  const javaCandidates = [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
    process.platform === 'win32' && 'C:/Program Files/Android/Android Studio/jbr/bin/java.exe'];
  const java = javaCandidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!jars || !java) { t.skip('Requires JDK17+ and Android BC1.83 cache or BC_CLASSPATH'); return; }
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'housecontrol-sync-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const source = path.join(folder, 'CompanionProbe.java');
  fs.writeFileSync(source, `
import java.net.Socket;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.bouncycastle.tls.*;
import org.bouncycastle.tls.crypto.impl.bc.BcTlsCrypto;
public class CompanionProbe {
  public static void main(String[] args) throws Exception {
    byte[] key = Base64.getDecoder().decode(args[1]);
    Mac hmac = Mac.getInstance("HmacSHA256"); hmac.init(new SecretKeySpec(key, "HmacSHA256"));
    byte[] psk = hmac.doFinal("HouseControl sync v1".getBytes(StandardCharsets.UTF_8));
    try (Socket socket = new Socket("127.0.0.1", Integer.parseInt(args[0]))) {
      socket.setSoTimeout(10000);
      TlsClientProtocol protocol = new TlsClientProtocol(socket.getInputStream(), socket.getOutputStream());
      protocol.connect(new PSKTlsClient(new BcTlsCrypto(new SecureRandom()), "housecontrol".getBytes(StandardCharsets.UTF_8), psk) {
        protected ProtocolVersion[] getSupportedVersions() { return new ProtocolVersion[] {ProtocolVersion.TLSv12}; }
        protected int[] getSupportedCipherSuites() { return new int[] {CipherSuite.TLS_PSK_WITH_AES_128_GCM_SHA256}; }
      });
      byte[] hello = "{\\"type\\":\\"hello\\",\\"device\\":\\"BouncyCastle Android\\",\\"rev\\":\\"\\"}".getBytes(StandardCharsets.UTF_8);
      DataOutputStream out = new DataOutputStream(protocol.getOutputStream());
      out.writeInt(hello.length); out.write(hello); out.flush();
      DataInputStream in = new DataInputStream(protocol.getInputStream());
      int length = in.readInt(); if (length < 1 || length > 8388608) throw new IOException("Bad frame");
      byte[] body = new byte[length]; in.readFully(body);
      System.out.println(new String(body, StandardCharsets.UTF_8));
    }
  }
}`);
  const server = await serverFor(t, () => ({ macName: 'Windows', revision: 'interop1', plan: '{"name":"BC test"}' }));
  const child = spawn(java, ['-cp', jars, source, String(server.port), server.pairing.key], { windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  const state = JSON.parse(stdout.trim());
  assert.equal(state.type, 'state'); assert.equal(state.rev, 'interop1'); assert.equal(state.plan, '{"name":"BC test"}');
});
