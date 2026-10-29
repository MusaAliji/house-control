'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PlanStore, SecureStore } = require('../src/store.cjs');
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'house-store-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('invalid imports preserve the active plan and exact bytes determine the revision', t => {
  const dir = temp(t), store = new PlanStore(dir);
  const bytes = Buffer.from('{"rooms":[{"id":"room","rect":[0,0,4,4]}],"name":"My home"}\n');
  store.save(bytes); assert.deepEqual(store.bytes(), bytes); assert.equal(store.revision().length, 16);
  for (const invalid of ['{}', '{', '{"rooms":[]}', '{"rooms":{}}']) assert.throws(() => store.save(invalid));
  assert.deepEqual(store.bytes(), bytes); assert.equal(new PlanStore(dir).activePlan, 'custom');
  store.select('studio'); assert.equal(new PlanStore(dir).activePlan, 'studio');
  assert.throws(() => store.select('unknown'));
});
test('secret store refuses plaintext fallback and binds values to their identity', t => {
  const dir = temp(t);
  const codec = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text), decryptString: bytes => bytes.toString() };
  const store = new SecureStore(dir, codec);
  store.set('sync', { key: 'secret' }); assert.deepEqual(store.get('sync'), { key: 'secret' });
  fs.copyFileSync(store.file('sync'), store.file('hue')); assert.throws(() => store.get('hue'), /identity/);
  assert.throws(() => store.set('../escape', {}));
  codec.isEncryptionAvailable = () => false; assert.throws(() => store.set('sync', {}), /unavailable/);
  store.set('sync', null); assert.equal(store.get('sync'), null);
});
