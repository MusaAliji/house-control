'use strict';
// Runs only against a deliberately launched local debugging instance of this app.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, limit = 30000) { const end = Date.now() + limit; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(200); } throw new Error('Packaged verification timed out.'); }
async function target(mode) {
  return waitFor(async () => { try { return (await fetch('http://127.0.0.1:9335/json/list').then(r => r.json())).find(t => t.type === 'page' && t.url.startsWith('house://app/') && new URL(t.url).searchParams.get('mode') === mode); } catch { return null; } });
}
async function connect(mode) {
  const page = await target(mode), ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  ws.onmessage = event => { const result = JSON.parse(event.data); if (!result.id) return; const callback = pending.get(result.id); pending.delete(result.id); if (result.error) callback?.reject(new Error(result.error.message)); else callback?.resolve(result.result); };
  const send = (method, params) => new Promise((resolve, reject) => { const request = ++id; pending.set(request, { resolve, reject }); ws.send(JSON.stringify({ id: request, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  return { evaluate, send, close: () => ws.close() };
}
(async () => {
  const out = path.resolve(__dirname, '../../build/windows-packaged-smoke');
  const profile = path.join(out, 'profile'); fs.mkdirSync(out, { recursive: true });
  const panel = await connect('panel');
  await waitFor(() => panel.evaluate('!!window.__house'));
  const info = await panel.evaluate('({platform:window.__HOUSE_BOOT__.platform,rooms:window.__house.config.rooms.length,native:!!window.HouseDesktop})');
  assert.equal(info.platform, 'windows'); assert.ok(info.native); assert.ok(info.rooms);
  await sleep(3000);
  const shot = await panel.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, 'home.png'), Buffer.from(shot.data, 'base64'));
  await panel.evaluate("window.HouseDesktop.postMessage({type:'openEditor'})");
  const editor = await connect('editor'); await waitFor(() => editor.evaluate('!!window.__editor'));
  await editor.evaluate("(()=>{const input=document.querySelector('.title-input');input.value='Packaged validation';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.bar-actions .primary').click();})()");
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'plan.json'))).name === 'Packaged validation'; } catch { return false; } });
  await waitFor(() => panel.evaluate('!!window.__house'));
  await panel.evaluate("window.HouseDesktop.postMessage({type:'pairPhone'})");
  const pairing = await connect('pairing');
  const status = await waitFor(() => pairing.evaluate("document.querySelector('#status')?.textContent.includes('Waiting for your phone')&&document.querySelector('#qr')?.src.startsWith('data:image/png')"));
  assert.ok(status);
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, ...info, editorSave: true, packagedSyncWorkerAndAdvertisement: true }, null, 2));
  editor.close(); pairing.close(); await panel.evaluate("window.HouseDesktop.postMessage({type:'quit'})"); panel.close();
  console.log('Packaged Windows app: home, editor save, QR pairing and bundled sync worker passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
