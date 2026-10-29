'use strict';
// Opt-in development verification. Uses a throwaway HOUSE_DATA_DIR.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('Desktop smoke verification timed out.'); }
async function capture(win, file) {
  if (win.houseMode === 'island') win.showInactive(); else { win.show(); win.focus(); }
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(1200);
    try { fs.writeFileSync(file, (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); return; }
    catch (error) { last = error; }
  }
  throw last;
}
async function run(ctx) {
  const { app, windows, show, plans, secrets, sync, agent, invoke } = ctx;
  const output = path.resolve(__dirname, '../../build/windows-smoke'); fs.mkdirSync(output, { recursive: true });
  const result = {};
  const panel = windows.get('panel');
  await waitFor(() => panel.houseReady);
  result.boot = await panel.webContents.executeJavaScript('({platform:window.__HOUSE_BOOT__.platform,native:!!window.HouseDesktop,rooms:window.__house.config.rooms.length,lights:window.__house.config.lights.length})');
  assert.equal(result.boot.platform, 'windows'); assert.ok(result.boot.native); assert.ok(result.boot.rooms > 0);
  await sleep(4000);
  await capture(panel, path.join(output, 'home.png'));
  // Exercise the actual renderer bridge and main-page action.
  await panel.webContents.executeJavaScript("window.HouseDesktop.postMessage({type:'openEditor'})");
  await waitFor(() => windows.get('editor')?.houseReady);
  const editor = windows.get('editor');
  result.editor = await editor.webContents.executeJavaScript('({title:document.title,text:document.body.innerText.slice(0,150)})');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/web/plans/home.json'))); config.name = 'Windows sync smoke';
  await editor.webContents.executeJavaScript(`(()=>{const input=document.querySelector('input.title-input');input.value=${JSON.stringify(config.name)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.bar-actions .primary').click();})()`);
  await waitFor(() => plans.custom()?.name === config.name);
  await waitFor(() => panel.houseReady); await sleep(1200);
  await capture(editor, path.join(output, 'editor.png'));
  secrets.set('smoke', 'synthetic-test-secret'); assert.equal(secrets.get('smoke'), 'synthetic-test-secret');
  assert.ok(!fs.readFileSync(secrets.file('smoke')).includes(Buffer.from('synthetic-test-secret'))); secrets.set('smoke', null); result.encryptedStore = true;
  // Use standard Node to exercise the packaged worker boundary and exact TLS cipher.
  await panel.webContents.executeJavaScript("window.HouseDesktop.postMessage({type:'pairPhone'})");
  await waitFor(() => sync.state.port && windows.get('pairing')?.houseReady);
  await waitFor(() => sync.state.isAdvertised);
  await sleep(500);
  await capture(windows.get('pairing'), path.join(output, 'pairing.png'));
  const child = fork(path.join(__dirname, 'smoke-client.cjs'), [], { execPath: path.join(__dirname, '../runtime/node.exe'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const received = new Promise((resolve, reject) => { child.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message)); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`Sync probe exited ${code}`)); }); });
  child.send({ pairing: sync.state.pairing, port: sync.state.port, revision: plans.revision() });
  const synced = await received; assert.equal(synced.plan.name, config.name); assert.equal(synced.revision, plans.revision());
  result.sync = { name: synced.plan.name, rooms: synced.plan.rooms.length, revision: synced.revision, cipher: synced.cipher };
  child.disconnect();
  show('agent'); await waitFor(() => windows.get('agent')?.houseReady);
  await agent.start('local'); assert.equal(agent.status().state, 'live');
  const tools = await fetch(`${agent.status().link}/api/tools`).then(r => r.json()); assert.ok(tools.tools.length > 0); result.agentTools = tools.tools.length;
  await agent.stop();
  const island = show('island'); island.showInactive(); await waitFor(() => island.houseReady); await invoke(island, 'islandState', 'expanded'); await sleep(3500);
  await capture(island, path.join(output, 'island.png'));
  result.passed = true; fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  if (process.env.HOUSE_ANDROID_PROBE === '1') {
    fs.writeFileSync(path.join(output, 'android-endpoint.json'), JSON.stringify({ port: sync.state.port, link: sync.state.pairingLink }));
    await waitFor(() => fs.existsSync(path.join(output, 'android-done')), 240000);
    result.androidProbeCompleted = true;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
  app.quit();
}
module.exports = { run };
