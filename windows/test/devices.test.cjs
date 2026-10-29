'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { DeviceHub, HomeAssistantService, HueService, TuyaService, SmartLifeService, DeviceFailure, TuyaMapper, InfraredRemote, Transport, request, LiveUpdates } = require('../src/devices.cjs');
const store = initial => { const values = new Map(Object.entries(initial || {})); return { get: key => values.get(key), set: (key, value) => values.set(key, value) }; };
const bulb = new Set(['switch_led', 'work_mode', 'bright_value_v2', 'temp_value_v2', 'colour_data_v2']);
const ranges = { bright_value_v2: [10, 1000], temp_value_v2: [0, 1000] };
test('Tuya light range, white mode and colour scale match Swift vectors', () => {
  assert.deepEqual(TuyaMapper.lightCommands({ on: true, brightness: .5 }, {}, {}, bulb, ranges), [{ code: 'switch_led', value: true }, { code: 'bright_value_v2', value: 505 }]);
  assert.deepEqual(TuyaMapper.lightState([{ code: 'switch_led', value: true }, { code: 'bright_value_v2', value: 505 }], ranges), { on: true, brightness: .5 });
  assert.deepEqual(TuyaMapper.lightCommands({ temp: 6500 }, {}, {}, bulb, ranges), [{ code: 'work_mode', value: 'white' }, { code: 'temp_value_v2', value: 1000 }]);
  assert.deepEqual(JSON.parse(TuyaMapper.lightCommands({ color: '#ff0000' }, { brightness: .8 }, {}, bulb, ranges)[1].value), { h: 0, s: 1000, v: 800 });
});
test('infrared ordering, capability ranges and temperature scaling match Swift', () => {
  const codes = new Set(['PowerOn', 'PowerOff', 'T', 'M', 'F']);
  assert.deepEqual(TuyaMapper.acCommands({ on: true, mode: 'heat', target: 24 }, {}, codes), [{ code: 'PowerOn', value: 'PowerOn' }, { code: 'M', value: 1 }, { code: 'T', value: 24 }]);
  assert.deepEqual(TuyaMapper.features(codes, { M: [0, 1], F: [0, 2] }), { infrared: true, modes: ['cool', 'heat'], fans: ['auto', 'low', 'medium'], sleep: false, eco: false, swing: false });
  assert.equal(TuyaMapper.sensor([{ code: 'va_temperature', value: 235 }]), 23.5);
});
test('infrared changes defer while off, then replay after power on', async () => {
  const remote = new InfraredRemote(0), sent = [];
  await remote.apply('ac', { fan: 'high' }, { on: false, fan: 'high' }, c => sent.push(c)); assert.equal(sent.length, 0);
  await remote.apply('ac', { on: true }, { on: true, fan: 'high' }, c => sent.push(c)); assert.deepEqual(sent.map(c => c.code), ['PowerOn', 'F']);
});
test('infrared retries after restoring mode and reports only failed fields', async () => {
  const remote = new InfraredRemote(0), sent = []; let mode = 2;
  const send = c => { sent.push(c.code); if (c.code === 'T' && (mode === 2 || c.value === 31)) throw new DeviceFailure('Unsupported', '2008'); if (c.code === 'M') mode = c.value; };
  const state = { on: true, mode: 'cool', target: 25, fan: 'high' };
  await remote.apply('ac', { target: 25 }, state, send); assert.equal(sent[0], 'T'); assert.ok(sent.includes('M')); assert.equal(sent.at(-1), 'T');
  await assert.rejects(remote.apply('ac', { target: 31 }, state, send), e => e.fields.join() === 'target');
});
test('Smart Life encrypted transport authenticates responses', () => {
  const id = '11111111-2222-3333-4444-555555555555', hash = crypto.createHash('md5').update(id + 'refresh-token').digest('hex'), secret = crypto.createHmac('sha256', id).update(hash).digest('hex').slice(0, 16), plain = '{"homeId":"42"}';
  const encrypted = Transport.encrypt(plain, secret, 'ABCDEFGHJKMN'); assert.ok(encrypted.startsWith('QUJDREVGR0hKS01O')); assert.equal(Transport.decrypt(encrypted, secret), plain);
  const damaged = Buffer.from(encrypted, 'base64'); damaged[15] ^= 1; assert.throws(() => Transport.decrypt(damaged.toString('base64'), secret));
});
test('Home Assistant mappings preserve unavailable, colour, climate and Fahrenheit states', () => {
  assert.deepEqual(HomeAssistantService.reading({ entity_id: 'light.x', state: 'unavailable' }), { online: false });
  assert.equal(HomeAssistantService.reading({ entity_id: 'sensor.x', state: '77', attributes: { unit_of_measurement: '°F' } }).temperature, 25);
  const reading = HomeAssistantService.reading({ entity_id: 'climate.x', state: 'heat_cool', attributes: { hvac_modes: ['off', 'heat_cool'], fan_modes: ['Auto', 'Quiet', 'Medium', 'Turbo'], target_temp_low: 20, target_temp_high: 24, current_temperature: 23, fan_mode: 'Quiet', swing_modes: ['off', 'vertical'], swing_mode: 'vertical', preset_modes: ['eco'], preset_mode: 'eco' } });
  assert.deepEqual(reading.ac, { on: true, mode: 'auto', target: 22, roomTemp: 23, fan: 'low', swing: 'swing', eco: true });
  assert.deepEqual(reading.features.fans, ['auto', 'low', 'medium', 'turbo']);
});
test('real loopback HA validates token, routes commands, and merges sensor polling', async t => {
  const calls = [], server = http.createServer((req, res) => { let body = ''; req.on('data', c => body += c); req.on('end', () => { calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) }); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url === '/api/config' ? { location_name: 'Lab', version: '2026.10' } : req.url === '/api/states' ? [{ entity_id: 'light.lab', state: 'on', attributes: { brightness: 128 } }, { entity_id: 'sensor.temp', state: '77', attributes: { unit_of_measurement: '°F' } }] : [])); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const hub = new DeviceHub(store()); await hub.homeAssistant.connect(`http://127.0.0.1:${server.address().port}`, 'token');
  hub.setLinks({ lights: [{ id: 'lamp', link: { service: 'homeassistant', id: 'light.lab' } }], acs: [{ id: 'ac', sensor: { service: 'homeassistant', id: 'sensor.temp' } }] });
  assert.deepEqual(await hub.command({ id: 'lamp', patch: { brightness: .5, color: '#ff0000' } }), { ok: true });
  const sent = calls.find(c => c.path === '/api/services/light/turn_on'); assert.deepEqual(sent.body, { brightness_pct: 50, rgb_color: [255, 0, 0], entity_id: 'light.lab' }); assert.equal(sent.auth, 'Bearer token');
  const polled = await hub.poll(); assert.equal(polled.acs.ac.roomTemp, 25); assert.equal(polled.lights.lamp.on, true); assert.deepEqual(polled.errors, {});
  assert.equal(hub.servicesInfo.homeassistant.name, 'Lab'); assert.equal(hub.shareableConnections().homeassistant.token, 'token');
});
test('HTTP redirect is rejected without sending credentials to redirected host', async t => {
  let received = 0; const server = http.createServer((req, res) => { received++; res.writeHead(302, { Location: '/secret' }); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  await assert.rejects(request('GET', `http://127.0.0.1:${server.address().port}/`, null, { Authorization: 'Bearer private' }), e => e.code === '302'); assert.equal(received, 1);
});
test('device errors return rollback fields and HomeKit has explicit Windows limitation', async () => {
  const hub = new DeviceHub(store()); hub.setLinks({ lights: [{ id: 'lamp', link: { service: 'homekit', id: 'apple' } }] });
  assert.match((await hub.command({ id: 'lamp', patch: { on: true } })).error, /unavailable on Windows/); assert.equal(hub.servicesInfo.homekit.supported, false);
});
test('commands targeting same physical device are serialized', async () => {
  const hub = new DeviceHub(store({ homeassistant: { url: 'http://lab', token: 'private' } })); let active = 0, maximum = 0;
  hub.homeAssistant.send = async () => { active++; maximum = Math.max(active, maximum); await new Promise(r => setTimeout(r, 10)); active--; };
  hub.setLinks({ lights: [{ id: 'one', link: { service: 'homeassistant', id: 'light.same' } }, { id: 'two', link: { service: 'homeassistant', id: 'light.same' } }] });
  await Promise.all([hub.command({ id: 'one', patch: { on: true } }), hub.command({ id: 'two', patch: { on: false } })]); assert.equal(maximum, 1); assert.equal(hub.locks.size, 0);
});
test('Tuya signs exact canonical query and JSON and refreshes token', async () => {
  const calls = [], service = new TuyaService(store(), async (method, url, body, headers) => { calls.push({ method, url, body, headers }); return { success: true, result: url.includes('/token?') ? { access_token: 'access', expire_time: 3600 } : true }; });
  service.save('client', 'secret', 'eu'); await service.send('light/one', [{ code: 'switch', value: true }]); assert.equal(calls.length, 2);
  const call = calls[1], path = '/v1.0/iot-03/devices/light%2Fone/commands', digest = crypto.createHash('sha256').update(JSON.stringify(call.body)).digest('hex'), signed = `clientaccess${call.headers.t}POST\n${digest}\n\n${path}`;
  assert.equal(call.headers.sign, crypto.createHmac('sha256', 'secret').update(signed).digest('hex').toUpperCase()); assert.equal(call.headers.access_token, 'access');
});
test('Smart Life QR completion persists credentials and outbound envelope signature', async () => {
  const saved = store(), calls = [], service = new SmartLifeService(saved, async (method, url, body, headers) => { calls.push({ method, url, body, headers }); if (url.includes('/qrcode/')) return { success: true, t: Date.now(), result: { access_token: 'access', refresh_token: 'refresh', expire_time: 7200, endpoint: 'https://cloud.example', uid: 'uid' } }; return { success: true, result: [] }; });
  assert.equal(await service.finishLogin('token', 'user'), true); assert.equal(saved.get('smartlife').accessToken, 'access'); await service.send('lamp', [{ code: 'switch', value: true }]);
  const call = calls.at(-1), headers = call.headers, md5 = crypto.createHash('md5').update(headers['X-requestId'] + 'refresh').digest('hex'), secret = crypto.createHmac('sha256', headers['X-requestId']).update(md5).digest('hex').slice(0, 16);
  assert.deepEqual(JSON.parse(Transport.decrypt(call.body.encdata, secret)), { commands: [{ code: 'switch', value: true }] });
  const text = Object.entries(headers).filter(([k, v]) => k !== 'X-sign' && v).map(([k, v]) => `${k}=${v}`).join('||') + call.body.encdata;
  assert.equal(headers['X-sign'], crypto.createHmac('sha256', md5).update(text).digest('hex'));
});
test('Hue emits CLIP v2 body and requires a pin before using a saved key', async () => {
  const calls = [], hue = new HueService(store({ hue: { host: 'bridge', key: 'private', certificate: 'pin' } }), async (...args) => { calls.push(args); return { data: [], errors: [] }; });
  await hue.send('light', 'bulb', { on: true, brightness: .5, temp: 4000 }, {}); assert.deepEqual(calls[0][2], { on: { on: true }, dimming: { brightness: 50 }, color_temperature: { mirek: 250 } }); assert.equal(calls[0][4].certificate, 'pin');
  hue.adopt({ host: 'bridge', key: 'private' }); await assert.rejects(hue.get('light'), /Pair this Hue Bridge again/); assert.equal(calls.length, 1);
});
const waitFor = async (condition, message) => { const limit = Date.now() + 2000; while (!condition() && Date.now() < limit) await new Promise(r => setTimeout(r, 5)); assert.ok(condition(), message); };
test('HA live socket authenticates, filters watched entities, reconnects and cancels on stop', async t => {
  const { WebSocketServer } = require('ws'); const server = http.createServer(), wss = new WebSocketServer({ server });
  const sockets = [], messages = []; wss.on('connection', socket => { sockets.push(socket); socket.send('{"type":"auth_required"}'); socket.on('message', raw => { const m = JSON.parse(raw); messages.push(m); if (m.type === 'auth') socket.send('{"type":"auth_ok"}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { for (const socket of sockets) socket.terminate(); wss.close(); server.close(); });
  let changes = 0; const hub = new DeviceHub(store({ homeassistant: { url: `http://127.0.0.1:${server.address().port}`, token: 'test-secret' } }), { onStale: () => changes++, live: { debounceDelay: 10, retryDelay: 15 } }); t.after(() => hub.stop());
  hub.setLinks({ lights: [{ id: 'lamp', link: { service: 'homeassistant', id: 'light.watched' } }] }); hub.start();
  await waitFor(() => messages.some(m => m.type === 'subscribe_events'), 'subscribed'); assert.equal(messages[0].access_token, 'test-secret');
  const emit = entity_id => sockets.at(-1).send(JSON.stringify({ type: 'event', event: { data: { entity_id } } }));
  emit('light.unwatched'); await new Promise(r => setTimeout(r, 25)); assert.equal(changes, 0);
  emit('light.watched'); emit('light.watched'); await waitFor(() => changes === 1, 'debounced event');
  sockets.at(-1).terminate(); await waitFor(() => sockets.length === 2, 'reconnected'); hub.stop(); const count = sockets.length;
  await new Promise(r => setTimeout(r, 45)); assert.equal(sockets.length, count); assert.equal(hub.live.timers.size, 0);
});
test('Hue SSE parses chunked events, filters resources and reconnects without stale callbacks', async t => {
  const responses = []; const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); responses.push(res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { for (const response of responses) response.destroy(); server.close(); });
  let changes = 0; const disconnected = { shareable: () => null }, hue = { shareable: () => ({ host: 'test', key: 'secret', certificate: 'pin' }) };
  const live = new LiveUpdates(disconnected, hue, () => changes++, { debounceDelay: 10, retryDelay: 15, openHue: (_config, receive) => http.get(`http://127.0.0.1:${server.address().port}/events`, receive) }); t.after(() => live.stop());
  live.start(new Set(), new Set(['watched'])); await waitFor(() => responses.length === 1, 'SSE connected');
  responses[0].write('data: [{"data":[{"id":"other"}]}]\r\n\r\n'); await new Promise(r => setTimeout(r, 25)); assert.equal(changes, 0);
  responses[0].write('data: [{"data":[{"id":"wat'); responses[0].write('ched"}]}]\r\n\r\n'); await waitFor(() => changes === 1, 'chunked SSE event');
  responses[0].end(); await waitFor(() => responses.length === 2, 'SSE reconnected');
  responses[1].write('data: [{"data":[{"id":"watched"}]}]\n\n'); live.stop(); await new Promise(r => setTimeout(r, 45)); assert.equal(changes, 1); assert.equal(live.timers.size, 0);
});
test('shared connections omit disconnected services; adoption clears missing platforms', () => {
  const hub = new DeviceHub(store({ homeassistant: { url: 'http://lab', token: 'secret' }, hue: { host: 'bridge', key: 'private', certificate: 'pin' } }));
  hub.adoptConnections({ homeassistant: { url: 'http://new', token: 'new-secret' } }); assert.equal(hub.hue.connected, false); assert.deepEqual(Object.keys(hub.shareableConnections()), ['homeassistant']);
});
test('signing out during Smart Life token refresh cannot restore the removed session', async () => {
  const original = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0, endpoint: 'https://cloud.example', uid: 'uid' };
  let resolveRefresh; const saved = store({ smartlife: original }), smart = new SmartLifeService(saved, () => new Promise(resolve => { resolveRefresh = resolve; }));
  const pending = smart.send('lamp', [{ code: 'switch', value: true }]); smart.signOut();
  resolveRefresh({ success: true, result: { accessToken: 'new', refreshToken: 'rotated', expireTime: 3600 } });
  await assert.rejects(pending, /Not signed in/); assert.equal(smart.connected, false); assert.equal(saved.get('smartlife'), null);
});

// Disposable self-signed fixture: no production credentials.
const hueTestKey = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDAhfXtsCvxPzgw
7byDdxP2k+B45YfgQiQ/2MrzMiqZ1Z43RjvULKXiVJEY2hSXW4gaomDgtFfPFbfy
4Xj9ezhlcuhMHbYRVZDBePtx2zRPxor47KDQuD0hvqThtn14tkhVCNC4ABdvlQdI
52Q1OW6cUK2k6BPgPi/t2FeCakbgnffR06XCgkGziB1T4PaajUHVbFd6f2+yPVJp
5cJeMGrkhnd4amFrBJpZ6O8PcZ329StXEGzv2jNzZc8uJAAyXlxx0Y1IREw1kB11
dp6wElOPnnUkOeSrMPVX7WYDWgo7AbSUgovq3UpdHEl7wakOmnrAPRoLVyQRn8N9
C6SuqBRNAgMBAAECggEACqyCrYpqbUYthdzwajOEalPZiqpjJaZVHysUWXZrETtc
OcFNmN5e1hUNNF0G7jtXaO6ew2aMRcF1AOTKUfducYV05p9xFDXzwB5GhpH6LQAb
fWCVK+1DCmdo+dCl1Tb5/Kjv9Xuf0QJotHyLvD2yab05W164l2KrQpsPgv4EbviK
X4GwwQ/3+OE9CcPorsQKm+fstmey90u2ojEj8t9Z0RfoV5Jv/rnNKDYw7Y/VC69J
mMYtn5IF7dNR7RJXwtvNxyOIUiJynUutb2eFTy8p4bl2kz6/3KGkmCorF6ANRLyN
9iWPz/dNkxTOw68hkt59AnbhEf/Cho3yKlBZf2K4MQKBgQD2nnFdBKviwLCSGiMS
dJIJB8/QR6shXIRrfAswxfdFD3zCAMt8Bdp3mUEiqvUC/R6br9krPCQOZL+aD/vP
So/+LM55JVzLfBTnqB9ydvRgZJ6vmywo9rHeuSepHOfb/hW74XQ7ngWAVnDDrEao
6bPQAZCuxEyWNsdLpsWN7wkTSQKBgQDH2L0MM9Wp9YonftzBHqNfap5+FikAqHWo
RABktqyTZPZxnr0v7PJX4ATTNXl/bTiCeUJuWm8gK9XjXKHPGV3yaAGsId0g2ksA
mjppbzqM1tnYcB/wPO7iozpS2BAdM+F1rFxqnQNc7xNijE77oo3UxlxqFp1zup08
G5DR96c05QKBgQDzeg21pe0E2vP36jICAHBE1h+HI5qCP1LEwxxRNMEgv1+OMTaz
5RuAxB8YWOu33aogToX7N07pnvHC6lDSoGx0pkvaMtbgVkpVQxh465Psrqoz+OCq
OJP2rZnITi9idAGFEdqtGR+ZSr3dkPHZxZCupTzwLgDmtIIh4C5eKEYvcQKBgQCQ
sVIe9aCrT4XZlraKdH5g5TcfnzfMrCuTyrhmMwS8KwtrtDzR6EKGcUHNEhiHtDKH
9PeuInf22QYheb4Fzh4BFmCvmk0aLjLDmubT056WvjA3zuaw780d9oSR2rHAEwIY
StUWs9vte4OThHbjJgx+k6fxf7I8Sk7xaBvwidhcKQKBgQDqSA2lVmK/Ak9RLNN5
obIOmkWQ3kYeeddX+z7EaQXbM3CsuLGOm0YpJ1CnKVVX7qKJbVJHjFqdeaDYYVpj
rp75SgmaH1juEktqdLg9Dzw/Z528jH5biYi5yvj0n3+I4nrEm6isI1ABQfDVkbup
VAzYBgFBF8Z60HeKV5iosMA9ow==
-----END PRIVATE KEY-----`;
const hueTestCert = `-----BEGIN CERTIFICATE-----
MIIDFzCCAf+gAwIBAgIUEj3h7vBu3949YlqfxTOrQpYa9/QwDQYJKoZIhvcNAQEL
BQAwGzEZMBcGA1UEAwwQSG91c2VDb250cm9sVGVzdDAeFw0yNjEwMTUxMzI0MzZa
Fw0zNjEwMTIxMzI0MzZaMBsxGTAXBgNVBAMMEEhvdXNlQ29udHJvbFRlc3QwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDAhfXtsCvxPzgw7byDdxP2k+B4
5YfgQiQ/2MrzMiqZ1Z43RjvULKXiVJEY2hSXW4gaomDgtFfPFbfy4Xj9ezhlcuhM
HbYRVZDBePtx2zRPxor47KDQuD0hvqThtn14tkhVCNC4ABdvlQdI52Q1OW6cUK2k
6BPgPi/t2FeCakbgnffR06XCgkGziB1T4PaajUHVbFd6f2+yPVJp5cJeMGrkhnd4
amFrBJpZ6O8PcZ329StXEGzv2jNzZc8uJAAyXlxx0Y1IREw1kB11dp6wElOPnnUk
OeSrMPVX7WYDWgo7AbSUgovq3UpdHEl7wakOmnrAPRoLVyQRn8N9C6SuqBRNAgMB
AAGjUzBRMB0GA1UdDgQWBBQhWHFs13OLwrS96KgR2cYWzIEifjAfBgNVHSMEGDAW
gBQhWHFs13OLwrS96KgR2cYWzIEifjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQAEGCkjEMUiYzHQuplDhNYK8Yamp1TlTZG+kv3l5COH6qoapdpv
+DqiMkf1y1DW8IhYFBJo3h61hsy/GC71eM9Li5/2uuevK8Iv7MGq+OpfxNiqI3YB
kivkNoOiYtKn6OKPvL6Tg6hUv3RhlLWTZE65/s2pOzwsNWxm2+L5Ykr5RUeKy705
sOI3+6+IGKJP9Lw9zTwfU7h1hNHZpSCgaLyfEKFP5PutJ8HhPidFxjtses9I9GW+
YaHph5Ks3IKRd0B3CP3pw1I08jiFa5SomMRIMvqQadmmbX0GKuqjEtDvZ8EVVD3/
8OxVSEoKO9wPIXKt7DGvSu7CVdWv+NsJA6s4
-----END CERTIFICATE-----`;
test('Hue pin verifies TLS before a private key is sent to an unexpected bridge', async t => {
  const https = require('node:https'); let requests = 0;
  const server = https.createServer({ key: hueTestKey, cert: hueTestCert }, (req, res) => { requests++; assert.equal(req.headers['hue-application-key'], 'private'); res.setHeader('Content-Type', 'application/json'); res.end('{"data":[],"errors":[]}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const certificate = crypto.createHash('sha256').update(new crypto.X509Certificate(hueTestCert).raw).digest('hex');
  const hue = new HueService(store({ hue: { host: `127.0.0.1:${server.address().port}`, key: 'private', certificate } }));
  assert.deepEqual(await hue.get('light'), []); assert.equal(requests, 1);
  hue.adopt({ ...hue.config, certificate: '0'.repeat(64) });
  await assert.rejects(hue.get('light'), /certificate changed/); assert.equal(requests, 1, 'wrong certificate must not receive any HTTP request or key');
});
