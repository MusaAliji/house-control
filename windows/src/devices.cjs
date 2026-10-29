'use strict';
// Source port of core's device services and Android's transport/mapping implementations.
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const tls = require('node:tls');
const enc = encodeURIComponent;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const hash = (algorithm, text) => crypto.createHash(algorithm).update(text).digest('hex');
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class DeviceFailure extends Error {
  constructor(message, code = '', fields = []) { super(message); this.code = String(code); this.fields = fields; }
}
function pinnedAgent(options) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (tlsOptions, callback) => {
    const socket = tls.connect({ ...tlsOptions, rejectUnauthorized: false });
    const failed = error => callback(error); socket.once('error', failed);
    socket.once('secureConnect', () => {
      socket.removeListener('error', failed);
      const cert = socket.getPeerCertificate();
      if (!cert.raw || options.certificate && hash('sha256', cert.raw) !== options.certificate) {
        const error = new DeviceFailure('Hue Bridge certificate changed. Pair again.');
        socket.destroy(); callback(error); return;
      }
      options.onCertificate?.(cert); callback(null, socket);
    });
    // Agent waits for certificate verification before writing credentials.
  };
  return agent;
}
function request(method, url, body, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return reject(new DeviceFailure('Invalid device address'));
    const data = body == null ? null : JSON.stringify(body);
    const agent = options.certificate || options.onCertificate ? pinnedAgent(options) : false;
    const req = (target.protocol === 'https:' ? https : http).request(target, {
      method, ...options, agent,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, res => {
      // Never follow redirects: bearer tokens and Hue keys must stay on the configured server.
      if (options.certificate) {
        const cert = res.socket.getPeerCertificate();
        if (!cert.raw || hash('sha256', cert.raw) !== options.certificate) { res.destroy(); return reject(new DeviceFailure('Hue Bridge certificate changed. Pair again.')); }
      }
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) res.destroy(new DeviceFailure('Device response is too large')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new DeviceFailure(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`, res.statusCode));
        if (options.raw) return resolve(text);
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new DeviceFailure('Device request timed out')));
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const Colors = {
  rgb(text) { return /^#?[0-9a-f]{6}$/i.test(text || '') ? (text.replace('#', '').match(/../g).map(x => parseInt(x, 16) / 255)) : null; },
  hex(c) { return '#' + c.map(x => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, '0')).join(''); },
  hsv(text) { const c = this.rgb(text); if (!c) return null; const [r, g, b] = c, hi = Math.max(...c), lo = Math.min(...c), d = hi - lo; let h = d === 0 ? 0 : hi === r ? 60 * ((g - b) / d % 6) : hi === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4); if (h < 0) h += 360; return [h, hi === 0 ? 0 : d / hi, hi]; },
  xy(text) { const c = this.rgb(text)?.map(v => v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92); if (!c) return null; const [r, g, b] = c, x = r * .4124 + g * .3576 + b * .1805, y = r * .2126 + g * .7152 + b * .0722, z = r * .0193 + g * .1192 + b * .9505; return x + y + z ? { x: x / (x + y + z), y: y / (x + y + z) } : { x: .3127, y: .329 }; },
  fromXY(x, y) { if (y <= 0) return '#ffffff'; const xx = x / y, z = (1 - x - y) / y, c = [xx * 3.2406 - 1.5372 - z * .4986, -xx * .9689 + 1.8758 + z * .0415, xx * .0557 - .204 + z * 1.057], top = Math.max(...c, 1e-9); return this.hex(c.map(v => Math.max(v / top, 0)).map(v => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055)); },
};
class Service {
  constructor(id, store, transport = request) { this.id = id; this.store = store; this.request = transport; const value = store.get(id); this.config = typeof value === 'string' ? JSON.parse(value) : value || null; }
  get connected() { return !!this.config; }
  adopt(config) { const next = config ? structuredClone(config) : null; this.store.set(this.id, next); this.config = next; this.onConfigChanged?.(); }
  shareable() { return this.config ? structuredClone(this.config) : null; }
  disconnect() { this.adopt(null); }
}
const modeNames = { cool: ['cool'], heat: ['heat'], dry: ['dry'], fan: ['fan_only'], auto: ['auto', 'heat_cool'] };
const modesFor = a => Object.fromEntries(Object.entries(modeNames).flatMap(([key, names]) => { const match = names.find(n => (a.hvac_modes || []).includes(n)); return match ? [[key, match]] : []; }));
function panelFan(value = '') { const n = value.toLowerCase(); return /turbo|max|strong|highest|powerful|boost|very high/.test(n) ? 'turbo' : n.includes('high') ? 'high' : /med|mid/.test(n) ? 'medium' : /low|quiet|silent/.test(n) ? 'low' : n.includes('auto') ? 'auto' : null; }
function fansFor(a) { const result = {}; for (const name of a.fan_modes || []) { const key = panelFan(name); if (key && !result[key] && name !== 'off') result[key] = name; } return result; }
class HomeAssistantService extends Service {
  constructor(store, transport) { super('homeassistant', store, transport); }
  info() { const c = this.config; return c ? { connected: true, url: c.url, name: c.name || 'Home Assistant', version: c.version || '' } : { connected: false }; }
  adopt(config) { super.adopt(config?.url && config?.token ? config : null); }
  async connect(raw, token) {
    if (!token?.trim()) throw new DeviceFailure('Paste a long-lived Home Assistant access token.');
    let url; try { url = new URL(raw.includes('://') ? raw.trim() : `http://${raw.trim()}`); } catch { throw new DeviceFailure('Invalid Home Assistant address'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new DeviceFailure('Invalid Home Assistant address');
    if (!url.port && url.protocol === 'http:' && (url.hostname.endsWith('.local') || url.hostname === 'homeassistant')) url.port = '8123';
    const c = { url: url.toString().replace(/\/$/, ''), token: token.trim() }, about = await this.call('GET', '/api/config', null, c);
    this.adopt({ ...c, name: about.location_name || 'Home Assistant', version: about.version || '' });
  }
  async call(method, path, body, candidate = this.config, raw = false) {
    if (!candidate) throw new DeviceFailure('Connect Home Assistant first');
    try { return await this.request(method, candidate.url + path, body, { Authorization: `Bearer ${candidate.token}` }, { raw }); }
    catch (e) { if (['401', '403'].includes(e.code)) throw new DeviceFailure('Home Assistant refused the token. Create a new long-lived access token and connect again.'); throw e; }
  }
  static device(raw) {
    const id = raw.entity_id, a = raw.attributes || {}, domain = id.split('.')[0], colors = a.supported_color_modes || [];
    const kind = ['light', 'switch'].includes(domain) ? 'light' : domain === 'climate' ? 'ac' : domain === 'sensor' && (a.device_class === 'temperature' || ['°C', '°F'].includes(a.unit_of_measurement)) ? 'sensor' : null;
    if (!kind) return null;
    const capabilities = domain !== 'light' ? [] : [...(colors.some(x => x !== 'onoff') ? ['brightness'] : []), ...(colors.includes('color_temp') ? ['temp'] : []), ...(colors.some(x => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(x)) ? ['color'] : [])];
    return { service: 'homeassistant', id, name: a.friendly_name || id, kind, online: !['unavailable', 'unknown'].includes(raw.state), capabilities, detail: `${domain} · ${colors.join(', ')}`, ...(kind === 'ac' ? { min: Math.max(10, a.min_temp ?? 10), max: Math.min(32, a.max_temp ?? 32) } : {}) };
  }
  static reading(raw) {
    const a = raw.attributes || {}, value = raw.state, out = { online: !['unavailable', 'unknown'].includes(value) };
    if (!out.online) return out;
    if (/^(light|switch)\./.test(raw.entity_id)) {
      const light = { on: value === 'on' }; if (value === 'on' && a.brightness != null) light.brightness = clamp(a.brightness / 255, .05, 1);
      if (a.color_mode === 'color_temp' && a.color_temp_kelvin != null) Object.assign(light, { temp: clamp(a.color_temp_kelvin, 2200, 6500), color: null });
      else if (['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(a.color_mode) && a.rgb_color) light.color = Colors.hex(a.rgb_color.map(x => x / 255));
      out.light = light;
    } else if (raw.entity_id.startsWith('climate.')) {
      const modes = modesFor(a), fans = fansFor(a), swings = a.swing_modes || [], presets = a.preset_modes || [], ac = { on: value !== 'off' };
      const mode = Object.keys(modes).find(k => modes[k] === value); if (mode) ac.mode = mode;
      const target = a.temperature ?? (a.target_temp_low != null && a.target_temp_high != null ? Math.round((a.target_temp_low + a.target_temp_high) / 2) : null);
      if (target != null) ac.target = target; if (a.current_temperature != null) ac.roomTemp = a.current_temperature;
      const fan = panelFan(a.fan_mode); if (fan && fans[fan]) ac.fan = fan;
      if (swings.length && own(a, 'swing_mode')) ac.swing = a.swing_mode === 'off' ? 'off' : 'swing';
      for (const key of ['sleep', 'eco']) if (presets.includes(key)) ac[key] = a.preset_mode === key;
      Object.assign(out, { ac, features: { modes: Object.keys(modeNames).filter(k => modes[k]), fans: ['auto', 'low', 'medium', 'high', 'turbo'].filter(k => fans[k]), swing: swings.includes('off') && swings.length > 1, sleep: presets.includes('sleep'), eco: presets.includes('eco') } });
    } else if (raw.entity_id.startsWith('sensor.') && Number.isFinite(Number(value))) out.temperature = a.unit_of_measurement === '°F' ? (Number(value) - 32) * 5 / 9 : Number(value);
    return out;
  }
  async devices() {
    const states = await this.call('GET', '/api/states'), rooms = {};
    try { const text = await this.call('POST', '/api/template', { template: "{% for e in states %}{{ e.entity_id }}\t{{ area_name(e.entity_id) or '' }}\n{% endfor %}" }, this.config, true); for (const line of text.split('\n')) { const [id, room] = line.split('\t'); if (room && room !== 'None') rooms[id] = room; } } catch {}
    return states.map(HomeAssistantService.device).filter(Boolean).map(d => ({ ...d, ...(rooms[d.id] ? { room: rooms[d.id] } : {}) })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }
  async read(ids) { return Object.fromEntries((await this.call('GET', '/api/states')).filter(s => ids.has(s.entity_id)).map(s => [s.entity_id, HomeAssistantService.reading(s)])); }
  async send(kind, id, patch, state) {
    const domain = id.split('.')[0], send = (service, body = {}) => this.call('POST', `/api/services/${domain}/${service}`, { ...body, entity_id: id });
    if (domain === 'switch') { if (own(patch, 'on')) await send(patch.on ? 'turn_on' : 'turn_off'); return; }
    if (domain === 'light') {
      if (patch.on === false) return send('turn_off');
      const body = {}; if (patch.brightness != null) body.brightness_pct = Math.round(clamp(patch.brightness, 0, 1) * 100); if (patch.temp != null) body.color_temp_kelvin = Math.round(patch.temp);
      const rgb = Colors.rgb(patch.color); if (rgb) body.rgb_color = rgb.map(x => Math.round(x * 255));
      if (Object.keys(body).length || patch.on) await send('turn_on', body); return;
    }
    if (domain !== 'climate') throw new DeviceFailure('This Home Assistant entity cannot be controlled');
    if (patch.on === false) return send('set_hvac_mode', { hvac_mode: 'off' });
    const a = (await this.call('GET', `/api/states/${enc(id)}`)).attributes || {}, modes = modesFor(a), fans = fansFor(a);
    if (patch.on || patch.mode) { const mode = modes[patch.mode || state.mode || 'cool'] || Object.values(modes)[0]; if (mode) await send('set_hvac_mode', { hvac_mode: mode }); }
    if (patch.target != null) await send('set_temperature', { temperature: patch.target });
    if (fans[patch.fan]) await send('set_fan_mode', { fan_mode: fans[patch.fan] });
    if (own(patch, 'swing')) await send('set_swing_mode', { swing_mode: patch.swing === 'off' ? 'off' : (a.swing_modes || []).find(x => x !== 'off') || 'on' });
    for (const key of ['sleep', 'eco']) if (own(patch, key)) await send('set_preset_mode', { preset_mode: patch[key] ? key : 'none' });
  }
}
class HueService extends Service {
  constructor(store, transport) { super('hue', store, transport); }
  info() { const c = this.config; return c ? { connected: true, host: c.host, name: c.name || 'Hue Bridge', bridgeId: c.bridgeId } : { connected: false }; }
  adopt(config) { super.adopt(config?.host && config?.key ? config : null); }
  async pair(raw, bridgeId, name) {
    let url; try { url = new URL(`https://${raw.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')}/api`); } catch { throw new DeviceFailure('Enter the bridge address'); }
    if (url.username || url.password || url.pathname !== '/api' || url.search || url.hash) throw new DeviceFailure('Enter the bridge address');
    let certificate; const c = { host: url.host, bridgeId, name: name || 'Hue Bridge' };
    const answer = (await this.request('POST', url.toString(), { devicetype: 'house_control#Windows', generateclientkey: true }, {}, { rejectUnauthorized: false, onCertificate: cert => { if (cert.raw) certificate = hash('sha256', cert.raw); } }))[0];
    if (answer?.error) { const error = new DeviceFailure(answer.error.type === 101 ? 'Press the round button on the Hue Bridge.' : answer.error.description, answer.error.type); if (answer.error.type === 101) error.waiting = true; throw error; }
    if (!answer?.success?.username || !certificate) throw new DeviceFailure('Hue Bridge returned no key or certificate');
    Object.assign(c, { key: answer.success.username, certificate }); const old = this.config; this.config = c;
    try { const bridge = (await this.get('bridge'))[0]; if (bridge) c.bridgeId = bridge.bridge_id; this.adopt(c); } catch (e) { this.config = old; throw e; }
  }
  async call(method, path, body) { const c = this.config; if (!c) throw new DeviceFailure('Pair a Hue Bridge first'); if (!c.certificate) throw new DeviceFailure('Pair this Hue Bridge again to establish its certificate'); const result = await this.request(method, `https://${c.host}${path}`, body, { 'hue-application-key': c.key }, { rejectUnauthorized: false, certificate: c.certificate }); if (result.errors?.length) throw new DeviceFailure(`Hue: ${result.errors[0].description}`); return result; }
  async get(type) { return (await this.call('GET', `/clip/v2/resource/${type}`)).data || []; }
  async devices() {
    const rooms = {}, hardware = {}, offline = new Set();
    for (const room of await this.get('room')) for (const child of room.children || []) rooms[child.rid] = room.metadata?.name;
    for (const device of await this.get('device')) hardware[device.id] = device;
    for (const conn of await this.get('zigbee_connectivity')) if (conn.status !== 'connected') offline.add(conn.owner?.rid);
    const lights = (await this.get('light')).map(l => ({ service: 'hue', id: l.id, name: l.metadata?.name || 'Hue light', kind: 'light', room: rooms[l.owner?.rid], online: !offline.has(l.owner?.rid), capabilities: [['dimming', 'brightness'], ['color_temperature', 'temp'], ['color', 'color']].filter(([k]) => own(l, k)).map(([, v]) => v), detail: l.metadata?.archetype || 'light' }));
    return [...lights, ...(await this.get('temperature')).map(s => ({ service: 'hue', id: s.id, name: hardware[s.owner?.rid]?.metadata?.name || 'Hue sensor', kind: 'sensor', room: rooms[s.owner?.rid], online: !offline.has(s.owner?.rid), capabilities: [], detail: 'temperature sensor' }))];
  }
  async read(ids) {
    const out = {};
    for (const raw of await this.get('light')) if (ids.has(raw.id)) { const light = {}; if (raw.on) light.on = raw.on.on; if (raw.dimming) light.brightness = clamp(raw.dimming.brightness / 100, .05, 1); if (raw.color_temperature?.mirek_valid && raw.color_temperature.mirek) Object.assign(light, { temp: clamp(1000000 / raw.color_temperature.mirek, 2200, 6500), color: null }); else if (raw.color?.xy) light.color = Colors.fromXY(raw.color.xy.x, raw.color.xy.y); out[raw.id] = { online: true, light }; }
    for (const raw of await this.get('temperature')) if (ids.has(raw.id)) out[raw.id] = { online: true, temperature: raw.temperature?.temperature_report?.temperature ?? raw.temperature?.temperature };
    return out;
  }
  async send(kind, id, patch, state) {
    if (kind !== 'light') throw new DeviceFailure('Hue has no air conditioners'); const body = {};
    if (own(patch, 'on')) body.on = { on: patch.on }; else if (state.on && ['brightness', 'temp', 'color'].some(k => own(patch, k))) body.on = { on: true };
    if (patch.brightness != null) body.dimming = { brightness: Math.round(clamp(patch.brightness, 0, 1) * 1000) / 10 };
    if (patch.temp != null) body.color_temperature = { mirek: Math.round(1000000 / Math.max(patch.temp, 1000)) };
    const xy = Colors.xy(patch.color); if (xy) body.color = { xy }; if (Object.keys(body).length) await this.call('PUT', `/clip/v2/resource/light/${enc(id)}`, body);
  }
}
const modes = { cool: 'cold', heat: 'hot', dry: 'wet', fan: 'wind', auto: 'auto' }, fans = { auto: 'auto', low: 'low', medium: 'mid', high: 'high', turbo: 'strong' };
const irModes = { cool: 0, heat: 1, auto: 2, fan: 3, dry: 4 }, irFans = { auto: 0, low: 1, medium: 2, high: 3, turbo: 3 };
const infrared = codes => codes.has('PowerOn') || codes.has('PowerOff');
const range = (code, ranges, floor = 0) => ranges[code]?.[1] > ranges[code]?.[0] ? ranges[code] : code.endsWith('_v2') ? [floor > 0 ? 10 : 0, 1000] : [floor, 255];
const inverse = (table, value) => Object.keys(table).find(k => table[k] === value);
const TuyaMapper = {
  infrared,
  lightCommands(patch, state, link, codes, ranges = {}) {
    const out = [], custom = link.codes || {}, add = (code, value) => out.push({ code, value });
    if (own(patch, 'on')) add(custom.switch || ['switch_led', 'switch_1', 'switch'].find(c => codes.has(c)) || 'switch_1', patch.on);
    if (patch.brightness != null) { const code = ['bright_value_v2', 'bright_value'].find(c => codes.has(c)); if (code) { const [lo, hi] = range(code, ranges, 25); add(code, Math.round(lo + clamp(patch.brightness, 0, 1) * (hi - lo))); } }
    if (patch.temp != null) { const code = ['temp_value_v2', 'temp_value'].find(c => codes.has(c)); if (code) { const [lo, hi] = range(code, ranges); if (codes.has('work_mode')) add('work_mode', 'white'); add(code, Math.round(lo + clamp((patch.temp - 2200) / 4300, 0, 1) * (hi - lo))); } }
    const hsv = Colors.hsv(patch.color), colorCode = ['colour_data_v2', 'colour_data'].find(c => codes.has(c));
    if (hsv && colorCode) { const scale = range(colorCode.endsWith('_v2') ? 'bright_value_v2' : 'bright_value', ranges)[1] > 255 ? 1000 : 255; if (codes.has('work_mode')) add('work_mode', 'colour'); add(colorCode, JSON.stringify({ h: Math.trunc(hsv[0]), s: Math.trunc(hsv[1] * scale), v: Math.trunc(Math.max(.01, state.brightness ?? 1) * scale) })); }
    return out;
  },
  lightState(status, ranges = {}) { const out = {}; for (const { code, value } of status) { if (['switch_led', 'switch_1', 'switch'].includes(code) && typeof value === 'boolean' && !own(out, 'on')) out.on = value; if (['bright_value_v2', 'bright_value'].includes(code)) { const [lo, hi] = range(code, ranges, 25); out.brightness = clamp((value - lo) / (hi - lo), .05, 1); } if (['temp_value_v2', 'temp_value'].includes(code)) { const [lo, hi] = range(code, ranges); out.temp = 2200 + clamp((value - lo) / (hi - lo), 0, 1) * 4300; } } return out; },
  infraredKeys(patch) { const out = []; if (own(patch, 'on')) { const code = patch.on ? 'PowerOn' : 'PowerOff'; out.push(['on', { code, value: code }]); } if (own(irModes, patch.mode)) out.push(['mode', { code: 'M', value: irModes[patch.mode] }]); if (patch.target != null) out.push(['target', { code: 'T', value: Math.trunc(patch.target) }]); if (own(irFans, patch.fan)) out.push(['fan', { code: 'F', value: irFans[patch.fan] }]); return out; },
  acCommands(patch, link, codes) { if (infrared(codes)) return this.infraredKeys(patch).map(([, c]) => c); const out = [], c = link.codes || {}, add = (code, value) => out.push({ code, value }); if (own(patch, 'on')) add(c.switch || ['switch', 'power', 'switch_1'].find(k => codes.has(k)) || 'switch', patch.on); if (patch.target != null) add(c.target || 'temp_set', Math.trunc(patch.target)); if (modes[patch.mode]) add(c.mode || 'mode', modes[patch.mode]); const fan = c.fan || ['fan_speed_enum', 'windspeed'].find(k => codes.has(k)); if (fan && fans[patch.fan]) add(fan, fans[patch.fan]); for (const key of ['sleep', 'eco']) if (own(patch, key) && codes.has(key)) add(key, patch[key]); return out; },
  acState(status) { const out = {}; for (const { code, value } of status) { if (['switch', 'power'].includes(code)) out.on = value; else if (code === 'temp_set') out.target = value; else if (code === 'temp_current') out.roomTemp = value; else if (code === 'mode' && inverse(modes, value)) out.mode = inverse(modes, value); else if (['fan_speed_enum', 'windspeed'].includes(code) && inverse(fans, value)) out.fan = inverse(fans, value); } return out; },
  sensor(status) { const value = status.find(dp => ['temp_current', 'va_temperature'].includes(dp.code))?.value; return typeof value === 'number' ? Math.abs(value) > 60 ? value / 10 : value : undefined; },
  features(codes, ranges = {}) { if (!codes.size) return null; const ir = infrared(codes), inRange = (value, key, max) => value >= (ranges[key]?.[0] ?? 0) && value <= (ranges[key]?.[1] ?? max); return { infrared: ir, modes: ir ? Object.keys(modes).filter(k => inRange(irModes[k], 'M', 4)) : codes.has('mode') ? Object.keys(modes) : [], fans: ir ? ['auto', 'low', 'medium', 'high'].filter(k => inRange(irFans[k], 'F', 3)) : codes.has('fan_speed_enum') || codes.has('windspeed') ? Object.keys(fans) : [], sleep: !ir && codes.has('sleep'), eco: !ir && codes.has('eco'), swing: false }; },
};
class InfraredRemote {
  constructor(spacing = 1000) { this.spacing = spacing; this.last = new Map(); this.deferred = new Map(); }
  async apply(id, patch, state, send) {
    const wanted = Object.fromEntries(['on', 'mode', 'target', 'fan'].filter(k => own(patch, k)).map(k => [k, patch[k]]));
    if (!state.on && !own(wanted, 'on')) { this.deferred.set(id, new Set([...(this.deferred.get(id) || []), ...Object.keys(wanted)])); return; }
    if (wanted.on) { for (const key of this.deferred.get(id) || []) if (!own(wanted, key) && own(state, key)) wanted[key] = state[key]; this.deferred.delete(id); }
    if (wanted.on === false) this.deferred.delete(id);
    const keys = TuyaMapper.infraredKeys(wanted); let replayed = false;
    const press = async command => { const wait = this.spacing - (Date.now() - (this.last.get(id) || 0)); if (wait > 0) await delay(wait); try { await send(command); } finally { this.last.set(id, Date.now()); } };
    for (let index = 0; index < keys.length;) { const [field, command] = keys[index]; try { await press(command); index++; } catch (error) { const pending = keys.slice(index).map(([key]) => key); if (error.code === '2008' && !replayed && state.on && field !== 'on') { replayed = true; const rest = { ...state }; for (const [key] of keys) delete rest[key]; for (const [, c] of TuyaMapper.infraredKeys(rest)) try { await press(c); } catch {} continue; } throw new DeviceFailure(error.code === '2008' ? 'This remote has no infrared code for that setting (Tuya code 2008)' : error.message, error.code, pending); } }
  }
}
const Transport = {
  encrypt(plain, secret, nonce = crypto.randomBytes(9).toString('base64')) { const iv = Buffer.from(nonce); if (iv.length !== 12) throw new DeviceFailure('Invalid Smart Life nonce'); const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(secret), iv); const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]); return iv.toString('base64') + body.toString('base64'); },
  decrypt(text, secret) { const data = Buffer.from(text, 'base64'); if (data.length <= 28) throw new DeviceFailure('Could not decode Smart Life response'); const decipher = crypto.createDecipheriv('aes-128-gcm', Buffer.from(secret), data.subarray(0, 12)); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString('utf8'); },
};
const CLIENT = 'HA_3y9q4ak7g4ephrvke', LOGIN = 'https://apigw.iotbing.com';
class SmartLifeService extends Service {
  constructor(store, transport) { super('smartlife', store, transport); this.knownCodes = {}; this.knownRanges = {}; }
  info() { return { connected: this.connected, userCode: this.config?.userCode || '', account: this.config?.username || '' }; }
  signOut() { this.disconnect(); this.knownCodes = {}; this.knownRanges = {}; }
  async beginLogin(userCode) { if (!userCode.trim()) throw new DeviceFailure('Enter the User Code from the Smart Life app first.'); const json = await this.request('POST', `${LOGIN}/v1.0/m/life/home-assistant/qrcode/tokens?clientid=${CLIENT}&usercode=${enc(userCode.trim())}&schema=haauthorize`); if (!json.success) this.fail(json); const token = json.result.qrcode; return { token, qrContent: `tuyaSmart--qrLogin?token=${token}` }; }
  async finishLogin(token, userCode) { const json = await this.request('GET', `${LOGIN}/v1.0/m/life/home-assistant/qrcode/tokens/${enc(token)}?clientid=${CLIENT}&usercode=${enc(userCode.trim())}`), r = json.result; if (!json.success || !r?.access_token) return false; this.adopt({ userCode: userCode.trim(), accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: (json.t || Date.now()) + (r.expire_time || 7200) * 1000, uid: r.uid || '', endpoint: r.endpoint, username: r.username || '' }); return true; }
  fail(json) { throw new DeviceFailure(json.code === 2001 || json.code === '2001' ? 'Device is offline — Smart Life cannot reach it over Wi-Fi (code 2001)' : `${json.msg || 'Smart Life request failed'} (code ${json.code})`, json.code); }
  async call(method, path, query = {}, body = {}, refresh = true) {
    if (!this.config) throw new DeviceFailure('Not signed in to Smart Life');
    if (refresh && this.config.expiresAt - 60000 < Date.now()) {
      // Share one refresh across concurrent device reads, retaining the old session on transient errors.
      if (!this.refreshing) { const original = this.config; this.refreshing = this.call('GET', `/v1.0/m/token/${enc(original.refreshToken)}`, {}, {}, false).then(r => { if (this.config === original) this.adopt({ ...original, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: Date.now() + (r.expireTime || 7200) * 1000, uid: r.uid || original.uid }); }).finally(() => { this.refreshing = null; }); }
      await this.refreshing;
    }
    if (!this.config) throw new DeviceFailure('Not signed in to Smart Life');
    const s = this.config, rid = crypto.randomUUID(), md5 = hash('md5', rid + s.refreshToken), secret = hmac(rid, md5).slice(0, 16), q = Object.keys(query).length ? Transport.encrypt(JSON.stringify(query), secret) : '', b = Object.keys(body).length ? Transport.encrypt(JSON.stringify(body), secret) : '';
    const headers = { 'X-appKey': CLIENT, 'X-requestId': rid, 'X-sid': '', 'X-time': String(Date.now()), 'X-token': s.accessToken };
    headers['X-sign'] = hmac(md5, Object.entries(headers).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('||') + q + b);
    const endpoint = new URL(s.endpoint); if (endpoint.protocol !== 'https:') throw new DeviceFailure('Smart Life endpoint must use HTTPS');
    const json = await this.request(method, s.endpoint.replace(/\/$/, '') + path + (q ? `?encdata=${enc(q)}` : ''), b ? { encdata: b } : null, headers);
    if (!json.success) this.fail(json); if (typeof json.result !== 'string') return json.result; const plain = Transport.decrypt(json.result, secret); try { return JSON.parse(plain); } catch { return plain; }
  }
  async listDevices() { const out = []; for (const home of await this.call('GET', '/v1.0/m/life/users/homes') || []) if (home.ownerId) for (const d of await this.call('GET', '/v1.0/m/life/ha/home/devices', { homeId: String(home.ownerId) }) || []) { const codes = (d.status || []).map(x => x.code); this.knownCodes[d.id] = new Set(codes); out.push({ id: d.id, name: d.name || d.id, category: d.category, product: d.product_name, online: d.online, codes, home: home.name }); } return out; }
  async status(ids) { const out = {}; for (let i = 0; i < ids.length; i += 20) for (const d of await this.call('GET', '/v1.0/m/life/ha/devices/detail', { devIds: ids.slice(i, i + 20).join(',') }) || []) if (d.status) { out[d.id] = d.status; this.knownCodes[d.id] = new Set([...(this.knownCodes[d.id] || []), ...d.status.map(dp => dp.code)]); } for (const id of ids) await this.prepare(id); return out; }
  async prepare(id) { if (this.knownRanges[id]) return; try { const spec = await this.call('GET', `/v1.1/m/life/${enc(id)}/specifications`), ranges = {}, codes = new Set(this.knownCodes[id] || []); for (const item of [...(spec.status || []), ...(spec.functions || [])]) { codes.add(item.code); try { const v = typeof item.values === 'string' ? JSON.parse(item.values) : item.values; if (v?.max > v?.min) ranges[item.code] = [v.min, v.max]; } catch {} } this.knownCodes[id] = codes; this.knownRanges[id] = ranges; } catch {} }
  async send(id, commands) { if (commands.length) await this.call('POST', `/v1.1/m/thing/${enc(id)}/commands`, {}, { commands }); }
  async diagnostics(ids) { const out = {}; for (const d of await this.call('GET', '/v1.0/m/life/ha/devices/detail', { devIds: ids.join(',') }) || []) { out[d.id] = { ...d }; for (const [key, path] of [['specification', `/v1.1/m/life/${enc(d.id)}/specifications`], ['strategy', `/v1.0/m/life/devices/${enc(d.id)}/status`]]) try { out[d.id][key] = await this.call('GET', path); } catch (e) { out[d.id][key + '_error'] = e.message; } } return out; }
}
const hosts = { eu: 'openapi.tuyaeu.com', 'eu-w': 'openapi-weaz.tuyaeu.com', us: 'openapi.tuyaus.com', 'us-e': 'openapi-ueaz.tuyaus.com', cn: 'openapi.tuyacn.com', in: 'openapi.tuyain.com', sg: 'openapi-sg.iotbing.com' };
class TuyaService extends Service {
  constructor(store, transport) { super('tuya', store, transport); this.token = ''; this.expiry = 0; this.knownCodes = {}; this.knownRanges = {}; }
  get connected() { return !!(this.config?.accessId && this.config?.accessSecret && hosts[this.config.region]); }
  info() { return { configured: this.connected, accessId: this.config?.accessId || '', region: this.config?.region || 'eu', hasSecret: !!this.config?.accessSecret }; }
  save(accessId, accessSecret, region) { if (accessId.trim() && !hosts[region]) throw new DeviceFailure('Select a valid Tuya region'); this.adopt(accessId.trim() ? { accessId: accessId.trim(), accessSecret: accessSecret.trim() || this.config?.accessSecret || '', region } : null); this.token = ''; this.expiry = 0; this.knownCodes = {}; this.knownRanges = {}; }
  async call(method, path, query = {}, body = null, authorized = true, retry = true) {
    if (!this.connected) throw new DeviceFailure('Tuya credentials are incomplete'); const c = this.config;
    if (authorized && (!this.token || this.expiry < Date.now() + 60000)) { if (!this.refreshing) this.refreshing = this.call('GET', '/v1.0/token', { grant_type: '1' }, null, false).then(r => { if (this.config !== c) throw new DeviceFailure('Tuya credentials changed. Retry the command.'); this.token = r.access_token; this.expiry = Date.now() + (r.expire_time || 3600) * 1000; }).finally(() => { this.refreshing = null; }); await this.refreshing; }
    const signed = path + (Object.keys(query).length ? '?' + Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&') : ''), t = String(Date.now()), access = authorized ? this.token : '';
    const sign = hmac(c.accessSecret, c.accessId + access + t + `${method}\n${hash('sha256', body == null ? '' : JSON.stringify(body))}\n\n${signed}`).toUpperCase();
    const json = await this.request(method, `https://${hosts[c.region]}${signed}`, body, { client_id: c.accessId, sign, t, sign_method: 'HMAC-SHA256', ...(authorized ? { access_token: access } : {}) });
    if (json.success) return json.result; if (authorized && retry && ['1010', '1011'].includes(String(json.code))) { this.token = ''; return this.call(method, path, query, body, true, false); } throw new DeviceFailure(`${json.msg || 'Tuya request failed'} (code ${json.code})`, json.code);
  }
  async listDevices() { const out = [], seen = new Set(); let last = ''; do { const r = await this.call('GET', '/v1.0/iot-01/associated-users/devices', { size: '50', ...(last ? { last_row_key: last } : {}) }); for (const d of r.devices || []) { const codes = (d.status || []).map(dp => dp.code); this.knownCodes[d.id] = new Set(codes); out.push({ id: d.id, name: d.name, category: d.category, product: d.product_name, online: d.online, codes }); } last = r.has_more ? r.last_row_key : ''; if (seen.has(last)) break; seen.add(last); } while (last); return out; }
  async status(ids) { const out = {}; for (let i = 0; i < ids.length; i += 20) for (const d of await this.call('GET', '/v1.0/iot-03/devices/status', { device_ids: ids.slice(i, i + 20).join(',') }) || []) if (d.status) { out[d.id] = d.status; this.knownCodes[d.id] = new Set(d.status.map(dp => dp.code)); } return out; }
  async prepare() {}
  async send(id, commands) { if (commands.length) await this.call('POST', `/v1.0/iot-03/devices/${enc(id)}/commands`, {}, { commands }); }
}
/** Streams notify the hub to re-read canonical state; polling remains the recovery path. */
class LiveUpdates {
  constructor(homeAssistant, hue, onChange, options = {}) {
    this.homeAssistant = homeAssistant; this.hue = hue; this.onChange = onChange;
    this.retryDelay = options.retryDelay ?? 15000; this.debounceDelay = options.debounceDelay ?? 350;
    this.WebSocket = options.WebSocket; this.openHue = options.openHue;
    this.generation = 0; this.timers = new Set(); this.socket = null; this.stream = null;
  }
  schedule(callback, wait) { const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, wait); timer.unref?.(); this.timers.add(timer); return timer; }
  stop() {
    this.generation++; this.signature = null;
    for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); this.changeTimer = null;
    const socket = this.socket; this.socket = null; socket?.terminate?.();
    if (socket && !socket.terminate) socket.close();
    this.stream?.destroy(); this.stream = null;
  }
  start(entities, resources) {
    const ha = this.homeAssistant.shareable(), hue = this.hue.shareable();
    const signature = JSON.stringify([ha, hue, [...entities].sort(), [...resources].sort()]);
    if (this.signature === signature) return;
    this.stop(); this.signature = signature; const generation = this.generation;
    if (ha && entities.size) this.connectHA(ha, entities, generation);
    if (hue?.certificate && resources.size) this.connectHue(hue, resources, generation);
  }
  changed(generation) {
    if (generation !== this.generation) return;
    if (this.changeTimer) { clearTimeout(this.changeTimer); this.timers.delete(this.changeTimer); }
    this.changeTimer = this.schedule(() => { this.changeTimer = null; if (generation === this.generation) this.onChange(); }, this.debounceDelay);
  }
  connectHA(config, entities, generation) {
    if (generation !== this.generation) return;
    let socket, retried = false, heartbeat;
    const retry = () => {
      if (heartbeat) { clearInterval(heartbeat); this.timers.delete(heartbeat); }
      if (retried || generation !== this.generation) return; retried = true;
      if (this.socket === socket) this.socket = null;
      this.schedule(() => this.connectHA(config, entities, generation), this.retryDelay);
    };
    try {
      const WebSocket = this.WebSocket || require('ws'), url = new URL(config.url + '/api/websocket');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(url, { handshakeTimeout: 12000, followRedirects: false, maxPayload: 8 * 1024 * 1024 }); this.socket = socket;
      socket.on('open', () => {
        if (generation !== this.generation) { socket.terminate(); return; }
        heartbeat = setInterval(() => { if (generation === this.generation && socket.readyState === 1) socket.ping(); }, 30000);
        heartbeat.unref?.(); this.timers.add(heartbeat);
      });
      socket.on('message', data => {
        if (generation !== this.generation) return; let message; try { message = JSON.parse(data.toString()); } catch { return; }
        if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: config.token }));
        else if (message.type === 'auth_ok') socket.send(JSON.stringify({ id: 1, type: 'subscribe_events', event_type: 'state_changed' }));
        else if (message.type === 'auth_invalid') { retried = true; socket.terminate(); }
        else if (message.type === 'event' && entities.has(message.event?.data?.entity_id)) this.changed(generation);
      });
      socket.on('error', () => { socket.terminate(); retry(); }); socket.on('close', retry);
    } catch { retry(); }
  }
  connectHue(config, resources, generation) {
    if (generation !== this.generation) return;
    let retried = false, req;
    const retry = () => { if (retried || generation !== this.generation) return; retried = true; if (this.stream === req) this.stream = null; req?.destroy(); this.schedule(() => this.connectHue(config, resources, generation), this.retryDelay); };
    try {
      const receive = res => {
        if (generation !== this.generation || res.statusCode !== 200) { res.destroy(); retry(); return; }
        res.setEncoding('utf8'); let pending = '', data = '';
        res.on('data', chunk => {
          if (generation !== this.generation) return;
          pending += chunk; if (pending.length > 1024 * 1024) { res.destroy(); retry(); return; }
          let at; while ((at = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, at).replace(/\r$/, ''); pending = pending.slice(at + 1);
            if (line.startsWith('data:')) data += line.slice(5).trimStart() + '\n';
            if (data.length > 1024 * 1024) { res.destroy(); retry(); return; }
            if (!line && data) { try { const events = JSON.parse(data); if (Array.isArray(events) && events.some(event => event.data?.some(resource => resources.has(resource.id)))) this.changed(generation); } catch {} data = ''; }
          }
        });
        res.on('error', retry); res.on('end', retry); res.on('close', retry);
      };
      if (this.openHue) req = this.openHue(config, receive);
      else {
        req = https.get(`https://${config.host}/eventstream/clip/v2`, { agent: pinnedAgent({ certificate: config.certificate }), rejectUnauthorized: false, headers: { Accept: 'text/event-stream', 'hue-application-key': config.key } }, receive);
        req.setTimeout(65000, () => { req.destroy(); retry(); });
      }
      this.stream = req; req.on('error', retry);
    } catch { retry(); }
  }
}
class DeviceHub {
  constructor(store, options = {}) { if (typeof options === 'function') options = { request: options }; this.smartLife = new SmartLifeService(store, options.request); this.smartlife = this.smartLife; this.tuya = new TuyaService(store, options.request); this.homeAssistant = new HomeAssistantService(store, options.request); this.hue = new HueService(store, options.request); this.services = [this.homeAssistant, this.hue]; this.links = {}; this.locks = new Map(); this.infrared = new InfraredRemote(options.irSpacing ?? 1000); this.onStale = options.onStale; this.live = new LiveUpdates(this.homeAssistant, this.hue, () => this.onStale?.(), options.live); this.running = false; for (const service of this.services) service.onConfigChanged = () => this.refreshLive(); }
  get cloud() { return this.smartLife.connected ? this.smartLife : this.tuya.connected ? this.tuya : null; }
  get connected() { return !!this.cloud || this.services.some(s => s.connected); }
  get canPoll() { return Object.keys(this.links).length > 0 && this.connected; }
  get hasLinks() { return Object.keys(this.links).length > 0; }
  get smartLifeInfo() { return this.smartLife.info(); }
  get tuyaInfo() { return this.tuya.info(); }
  get smartLifeUserCode() { return this.smartLife.config?.userCode || ''; }
  get isSmartLifeConnected() { return this.smartLife.connected; }
  get servicesInfo() { return { smartlife: { ...this.smartLife.info(), connected: !!this.cloud }, homeassistant: this.homeAssistant.info(), hue: this.hue.info(), homekit: { connected: false, supported: false, reason: 'Apple HomeKit is unavailable on Windows. Connect these devices through Home Assistant or Hue.' } }; }
  setLinks(plan) { const out = {}; for (const [kind, key] of [['light', 'lights'], ['ac', 'acs']]) for (const device of plan?.[key] || []) { const direct = device.link, tuya = device.tuya, sensor = device.sensor?.id ? device.sensor : null; if (!device.id) continue; if (direct?.id) out[device.id] = { kind, platform: direct.service, target: direct.id, data: direct, sensor }; else if (tuya?.deviceId) out[device.id] = { kind, platform: 'smartlife', target: tuya.deviceId, data: tuya, sensor }; else if (kind === 'ac' && sensor) out[device.id] = { kind, platform: '', target: '', data: {}, sensor }; } this.links = out; this.refreshLive(); }
  async command(message) {
    const link = this.links[message.id]; if (!link?.target) return { ok: true };
    const key = `${link.platform}:${link.target}`, previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const patch = message.patch || {}, state = message.state || {};
      try { if (link.platform === 'smartlife') { const c = this.cloud; if (!c) throw new DeviceFailure('Connect Smart Life first'); await c.prepare(link.target); const codes = c.knownCodes[link.target] || new Set(), ranges = c.knownRanges[link.target] || {}; if (link.kind === 'light') await c.send(link.target, TuyaMapper.lightCommands(patch, state, link.data, codes, ranges)); else if (infrared(codes)) await this.infrared.apply(link.target, patch, state, command => c.send(link.target, [command])); else await c.send(link.target, TuyaMapper.acCommands(patch, link.data, codes)); } else { const service = this.services.find(s => s.id === link.platform); if (!service) throw new DeviceFailure(`${link.platform} is unavailable on Windows. Connect this device through Home Assistant or Hue.`); if (!service.connected) throw new DeviceFailure(`Connect ${service.id} first`); await service.send(link.kind, link.target, patch, state); } return { ok: true }; } catch (e) { this.onStale?.(); return { ok: false, error: e.message || 'Device command failed', ...(e.fields?.length ? { failed: e.fields } : {}) }; }
    });
    this.locks.set(key, current); try { return await current; } finally { if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  async poll() {
    const snapshot = this.links, lights = {}, acs = {}, features = {}, errors = {}, c = this.cloud;
    const cloudLinks = Object.entries(snapshot).filter(([, l]) => l.platform === 'smartlife');
    if (c && cloudLinks.length) try { const ids = [...new Set(cloudLinks.flatMap(([, l]) => [l.target, l.data.sensorId]).filter(Boolean))], status = await c.status(ids); for (const [id, l] of cloudLinks) { const ranges = c.knownRanges[l.target] || {}; if (l.kind === 'light') { if (status[l.target]) lights[id] = TuyaMapper.lightState(status[l.target], ranges); } else { const f = TuyaMapper.features(c.knownCodes[l.target] || new Set(), ranges); if (f) features[id] = f; const state = status[l.target] ? TuyaMapper.acState(status[l.target]) : {}; const t = status[l.data.sensorId] && TuyaMapper.sensor(status[l.data.sensorId]); if (t != null) state.roomTemp = t; if (Object.keys(state).length) acs[id] = state; } } } catch (e) { errors.smartlife = e.message; }
    const readings = {};
    await Promise.all(this.services.filter(s => s.connected).map(async service => { const ids = new Set(Object.values(snapshot).flatMap(l => [l.platform === service.id ? l.target : '', l.sensor?.service === service.id ? l.sensor.id : '']).filter(Boolean)); if (ids.size) try { readings[service.id] = await service.read(ids); } catch (e) { errors[service.id] = e.message; } }));
    const cloudSensorIds = [...new Set(Object.values(snapshot).filter(l => l.sensor?.service === 'smartlife').map(l => l.sensor.id))]; let cloudSensors = {}; if (c && cloudSensorIds.length) try { cloudSensors = await c.status(cloudSensorIds); } catch (e) { errors.smartlife = e.message; }
    for (const [id, l] of Object.entries(snapshot)) { const reading = readings[l.platform]?.[l.target]; if (reading?.online) { if (reading.light) lights[id] = reading.light; if (reading.ac) acs[id] = { ...acs[id], ...reading.ac }; if (reading.features) features[id] = reading.features; } if (l.kind === 'ac' && l.sensor) { const t = l.sensor.service === 'smartlife' ? cloudSensors[l.sensor.id] && TuyaMapper.sensor(cloudSensors[l.sensor.id]) : readings[l.sensor.service]?.[l.sensor.id]?.temperature; if (t != null) acs[id] = { ...acs[id], roomTemp: t }; } }
    return { lights, acs, features, errors };
  }
  async listDevices() { if (!this.cloud) throw new DeviceFailure('Connect Smart Life first'); return this.cloud.listDevices(); }
  async allDevices() { const devices = [], errors = {}; if (this.cloud) try { for (const d of await this.cloud.listDevices()) { const codes = new Set(d.codes || []), kind = ['kt', 'ktkzq', 'infrared_ac'].includes(d.category) || infrared(codes) || codes.has('temp_set') ? 'ac' : ['wsdcg', 'wk', 'wnykq'].includes(d.category) || codes.has('temp_current') && !codes.has('switch_led') ? 'sensor' : 'light'; devices.push({ ...d, service: 'smartlife', kind, capabilities: [['brightness', ['bright_value', 'bright_value_v2']], ['temp', ['temp_value', 'temp_value_v2']], ['color', ['colour_data', 'colour_data_v2']]].filter(([, names]) => names.some(n => codes.has(n))).map(([key]) => key), detail: [d.product, d.category].filter(Boolean).join(' · ') }); } } catch (e) { errors.smartlife = e.message; } await Promise.all(this.services.filter(s => s.connected).map(async s => { try { devices.push(...await s.devices()); } catch (e) { errors[s.id] = e.message; } })); return { devices, errors }; }
  shareableConnections() { return Object.fromEntries(this.services.filter(s => s.connected).map(s => [s.id, s.shareable()])); }
  adoptConnections(shared) { for (const service of this.services) service.adopt(shared[service.id] || null); }
  beginLogin(userCode) { return this.smartLife.beginLogin(userCode); }
  finishLogin(token, userCode) { return this.smartLife.finishLogin(token, userCode); }
  signOut() { this.smartLife.signOut(); }
  saveTuya(id, secret, region) { return this.tuya.save(id, secret, region); }
  diagnostics(ids) { return this.smartLife.diagnostics(ids); }
  async discover(service) {
    if (!['hue', 'homeassistant'].includes(service)) return [];
    const found = await new Promise(resolve => {
      let bonjour, browser; const results = new Map();
      const finish = () => { browser?.stop(); bonjour?.destroy(); resolve([...results.values()]); };
      try {
        const { Bonjour } = require('bonjour-service'); bonjour = new Bonjour(undefined, () => {});
        browser = bonjour.find({ type: service === 'hue' ? 'hue' : 'home-assistant', protocol: 'tcp' }, entry => {
          let host = entry.addresses?.find(a => /^\d+\./.test(a)) || entry.host; if (!host) return;
          if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`;
          const txt = Object.fromEntries(Object.entries(entry.txt || {}).map(([k, v]) => [k, String(v)]));
          results.set(entry.fqdn || entry.name, service === 'hue' ? { name: entry.name, host: entry.port === 443 ? host : `${host}:${entry.port}`, bridgeId: txt.bridgeid || '' } : { name: txt.location_name || entry.name, url: txt.internal_url || txt.base_url || `http://${host}:${entry.port}`, version: txt.version || '' });
        });
        setTimeout(finish, 3000);
      } catch { finish(); }
    });
    if (service === 'hue' && !found.length) try { return (await this.hue.request('GET', 'https://discovery.meethue.com/')).map(b => ({ host: b.internalipaddress, bridgeId: b.id, name: 'Hue Bridge' })); } catch {}
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }
  refreshLive() { if (!this.running) return; const ids = platform => new Set(Object.values(this.links).flatMap(l => [l.platform === platform ? l.target : '', l.sensor?.service === platform ? l.sensor.id : '']).filter(Boolean)); this.live.start(ids('homeassistant'), ids('hue')); }
  start() { this.running = true; this.refreshLive(); }
  stop() { this.running = false; this.live.stop(); }
}
module.exports = { DeviceHub, DeviceFailure, HomeAssistantService, HueService, SmartLifeService, TuyaService, TuyaMapper, InfraredRemote, Transport, Colors, request, LiveUpdates };
