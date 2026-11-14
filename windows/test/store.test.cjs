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
test('earlier homes: a replaced home is kept, an edit once an hour, and restore keeps the one it replaces', t => {
  const dir = temp(t), store = new PlanStore(dir);
  const home = (name, ids, extra = '') => Buffer.from(JSON.stringify({ name, rooms: ids.map(id => ({ id })), extra }));
  store.save(home('A', ['a'])); assert.equal(store.earlierHomes().length, 0);
  store.save(home('A', ['a'])); assert.equal(store.earlierHomes().length, 0);
  store.save(home('B', ['b'])); assert.equal(store.earlierHomes().length, 1);
  store.save(home('B', ['b'], '1')); store.save(home('B', ['b'], '2')); // edits of the same home, within the hour
  assert.equal(store.earlierHomes().length, 1);
  const [kept] = store.earlierHomes(); assert.equal(kept.name, 'A'); assert.equal(kept.rooms, 1);
  store.restore(kept.id); assert.equal(store.custom().name, 'A');
  assert.ok(store.earlierHomes().some(h => h.name === 'B'));
  assert.throws(() => store.restore('missing.json'));
});
test('the bundled house demo can be selected', t => {
  const store = new PlanStore(temp(t)); store.select('house'); assert.equal(new PlanStore(store.directory).activePlan, 'house');
});
