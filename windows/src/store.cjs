'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_PLAN = 8 * 1024 * 1024 - 65536;
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, data, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function validatePlan(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  if (bytes.length > MAX_PLAN) throw new Error('Floor plan is too large for phone sync.');
  const plan = JSON.parse(bytes.toString('utf8'));
  if (!plan || !Array.isArray(plan.rooms) || !plan.rooms.length) throw new Error('Choose a floor plan with a non-empty rooms list.');
  return { bytes, plan };
}
class PlanStore {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'plan.json');
    this.settingsFile = path.join(directory, 'settings.json');
    try { this.settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch { this.settings = {}; }
    if (!['home', 'studio', 'custom'].includes(this.settings.plan)) this.settings.plan = 'home';
    if (this.settings.plan === 'custom' && !this.custom()) this.settings.plan = 'home';
  }
  get activePlan() { return this.settings.plan; }
  custom() { try { return validatePlan(fs.readFileSync(this.file)).plan; } catch { return null; } }
  bytes() { return this.custom() ? fs.readFileSync(this.file) : null; }
  revision() { const bytes = this.bytes(); return bytes ? crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16) : ''; }
  setSetting(key, value) { this.settings[key] = value; atomicWrite(this.settingsFile, JSON.stringify(this.settings)); }
  select(plan) {
    if (!['home', 'studio'].includes(plan) && !(plan === 'custom' && this.custom())) throw new Error('Unknown floor plan.');
    this.setSetting('plan', plan);
  }
  save(data) { const { bytes, plan } = validatePlan(data); atomicWrite(this.file, bytes); this.select('custom'); return plan; }
  boot() { return { plan: this.activePlan, hasCustomPlan: !!this.custom(), ...(this.activePlan === 'custom' ? { config: this.custom() } : {}) }; }
}
class SecureStore {
  constructor(directory, safeStorage) { this.directory = directory; this.safeStorage = safeStorage; }
  file(name) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid secret name.');
    return path.join(this.directory, `${name}.protected`);
  }
  get(name) {
    const file = this.file(name);
    if (!fs.existsSync(file)) return null;
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    const envelope = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(file)));
    if (envelope.name !== name) throw new Error('Credential identity mismatch.');
    return envelope.value;
  }
  set(name, value) {
    const file = this.file(name);
    if (value == null) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    atomicWrite(file, this.safeStorage.encryptString(JSON.stringify({ name, value })));
  }
}
module.exports = { PlanStore, SecureStore, validatePlan, atomicWrite };
