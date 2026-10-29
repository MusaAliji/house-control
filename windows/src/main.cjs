'use strict';
const { app, BrowserWindow, Tray, Menu, dialog, ipcMain, nativeImage, protocol, net, shell, screen, clipboard, safeStorage, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const QRCode = require('qrcode');
const { PlanStore, SecureStore, validatePlan } = require('./store.cjs');
const { DesktopSync } = require('./sync-proxy.cjs');
const { DeviceHub } = require('./devices.cjs');
const { createAgent } = require('./agent.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'house', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.env.HOUSE_DATA_DIR) app.setPath('userData', path.resolve(process.env.HOUSE_DATA_DIR));
app.setAppUserModelId('com.housecontrol.windows');
const windows = new Map();
let plans, secrets, hub, sync, agent, tray, quitting = false, islandTimer, pollTimer, polling = false, loginTimer;
const assetRoot = path.resolve(__dirname, '../assets');
const name = process.env.HOUSE_COMPUTER_NAME || os.hostname();
let syncError = '';

function log(error) {
  // Log only diagnostics; never serialize commands, tokens, QR content or boot data.
  console.error(`[House Control] ${error?.message || error}`);
}
function invoke(win, method, ...args) {
  if (!win || win.isDestroyed() || !win.houseReady) return Promise.resolve(null);
  return win.webContents.executeJavaScript(`window.house?.[${JSON.stringify(method)}]?.(...${JSON.stringify(args)})`).catch(error => { log(error); return null; });
}
function notify(mode, method, ...args) { return invoke(windows.get(mode), method, ...args); }
function boot(mode) {
  return { ...plans.boot(), mode, platform: 'windows', tuya: hub.tuyaInfo, smartLife: hub.smartLifeInfo,
    services: hub.servicesInfo, agentLive: agent.status().state === 'live', agent: agent.status(),
    ...(mode === 'island' ? { island: { notchWidth: 190, notchHeight: 34, hasNotch: false } } : {}) };
}
function trusted(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || ![...windows.values()].includes(win) || event.senderFrame !== event.sender.mainFrame) return null;
  try { const url = new URL(event.senderFrame.url); if (url.protocol !== 'house:' || url.hostname !== 'app') return null; } catch { return null; }
  return win;
}
function windowFor(mode) {
  let win = windows.get(mode);
  if (win && !win.isDestroyed()) return win;
  const sizes = { panel: [490, 860], editor: [1240, 840], agent: [980, 820], pairing: [480, 660], login: [480, 630], island: [820, 470] };
  const [width, height] = sizes[mode];
  win = new BrowserWindow({ width, height, minWidth: mode === 'editor' ? 980 : 380, minHeight: mode === 'editor' ? 640 : 360,
    title: `House Control${mode === 'editor' ? ' — Edit Home' : mode === 'agent' ? ' — AI Access' : ''}`,
    icon: path.join(assetRoot, 'icon.png'), show: false,
    ...(mode === 'island' ? { frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false } : { backgroundColor: '#0a0e1a', autoHideMenuBar: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: mode !== 'panel' },
  });
  win.houseMode = mode;
  windows.set(mode, win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => log(new Error(`${mode} renderer stopped: ${details.reason}`)));
  win.webContents.on('did-start-loading', () => { win.houseReady = false; });
  win.on('close', event => {
    if (mode === 'panel' && !quitting) { event.preventDefault(); win.hide(); notify('panel', 'hidden'); }
  });
  win.on('closed', () => { windows.delete(mode); if (mode === 'island') { clearInterval(islandTimer); islandTimer = null; } });
  load(win);
  return win;
}
function load(win) {
  const page = ['pairing', 'login'].includes(win.houseMode) ? 'shell/pairing.html' : 'web/index.html';
  win.loadURL(`house://app/${page}?mode=${win.houseMode}`).catch(log);
}
function show(mode = 'panel') {
  const win = windowFor(mode);
  if (win.isMinimized()) win.restore();
  if (mode !== 'island') { win.show(); win.focus(); }
  if (win.houseReady && mode === 'panel') notify('panel', 'shown');
  return win;
}
function refreshLinks() { hub.setLinks(plans.activePlan === 'custom' ? plans.custom() : null); }
function broadcast() { return sync.broadcast().catch(log); }
function reload({ editor = false } = {}) {
  refreshLinks();
  for (const [mode, win] of windows) if (['panel', 'island'].includes(mode) || (editor && mode === 'editor')) load(win);
  broadcast(); buildTray();
}
async function savePlan(config) { plans.save(config); reload(); return { ok: true, path: plans.file }; }
async function importDialog(owner) {
  const result = await dialog.showOpenDialog(owner, { title: 'Choose a floor plan', filters: [{ name: 'House Control floor plan', extensions: ['json'] }], properties: ['openFile'] });
  if (result.canceled) return { cancelled: true };
  return { config: validatePlan(fs.readFileSync(result.filePaths[0])).plan };
}
async function loadPlan() { const result = await importDialog(show()); if (result.config) { await savePlan(result.config); reload({ editor: true }); } }
function snapshot() {
  return { macName: name, revision: plans.revision(), plan: plans.bytes()?.toString('utf8') || null,
    userCode: hub.smartLifeInfo.userCode || '', smartLifeConnected: !!hub.smartLifeInfo.connected,
    connections: hub.shareableConnections() };
}
async function pairingStatus() {
  const state = sync.state;
  if (!state.pairingLink) return;
  const qr = await QRCode.toDataURL(state.pairingLink, { width: 360, margin: 3 });
  await notify('pairing', 'pairingStatus', {
    title: 'Connect your Android phone',
    detail: 'On Android, open House Control → Settings → Pair with computer, then scan this code. Keep both devices on the same Wi-Fi. Saved home edits sync automatically.',
    status: state.connectedDevices.length ? `Connected: ${state.connectedDevices.join(', ')}` : syncError || (state.isAdvertised ? 'Waiting for your phone…' : 'Starting local network discovery…'), qr,
  });
}
async function pairPhone() { syncError = ''; await sync.enable(name); show('pairing'); await pairingStatus(); buildTray(); }
async function showLoginCode(content, device) {
  clearTimeout(loginTimer);
  if (typeof content !== 'string' || !content.startsWith('tuyaSmart--qrLogin?token=')) { windows.get('login')?.close(); return; }
  const value = { title: `Smart Life sign-in for ${device}`, detail: 'Open Smart Life on your phone, scan this code and confirm. Then return to House Control.', status: `Requested by ${device}`, qr: await QRCode.toDataURL(content, { width: 360, margin: 3 }), login: true };
  const win = show('login'); win.loginValue = value; await invoke(win, 'pairingStatus', value);
  loginTimer = setTimeout(() => windows.get('login')?.close(), 600000);
}
function toggleIsland() {
  const existing = windows.get('island');
  if (existing) { existing.close(); plans.setSetting('island', false); buildTray(); return; }
  const win = windowFor('island');
  const display = screen.getPrimaryDisplay();
  win.setPosition(Math.round(display.bounds.x + (display.bounds.width - 820) / 2), display.workArea.y);
  win.setAlwaysOnTop(true, 'floating'); win.setIgnoreMouseEvents(true, { forward: true }); win.showInactive();
  let expanded = false, leaveAt = 0;
  islandTimer = setInterval(() => {
    if (win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint(); const bounds = win.getBounds();
    const x = cursor.x - bounds.x, y = cursor.y - bounds.y;
    const inside = Math.abs(x - 410) < (expanded ? 332 : 165) && y >= 0 && y < (expanded ? 326 : 34);
    win.setIgnoreMouseEvents(!inside, { forward: true });
    if (inside) leaveAt = 0; else if (!leaveAt) leaveAt = Date.now();
    const next = inside || (expanded && Date.now() - leaveAt < 500);
    if (next !== expanded) { expanded = next; invoke(win, 'islandState', expanded ? 'expanded' : 'collapsed'); }
  }, 75);
  plans.setSetting('island', true); buildTray();
}
function guarded(action) { return () => Promise.resolve().then(action).catch(error => dialog.showErrorBox('House Control', error.message)); }
function buildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open House Control', click: () => show() },
    { label: 'Edit Home…', click: () => show('editor') },
    { label: 'Load Floor Plan…', click: guarded(loadPlan) },
    { label: 'Reveal Plan File', click: () => shell.showItemInFolder(plans.custom() ? plans.file : path.join(assetRoot, 'web/plans', `${plans.activePlan}.json`)) },
    { type: 'separator' },
    { label: 'Show Island', type: 'checkbox', checked: windows.has('island'), click: toggleIsland },
    { label: 'Pair Android / iPhone…', click: guarded(pairPhone) },
    ...sync.state.connectedDevices.map(device => ({ label: `${device} is connected`, enabled: false })),
    { label: agent.status().state === 'live' ? 'AI Access — Live' : 'AI Access…', click: () => show('agent') },
    { type: 'separator' }, { label: 'Reload', click: () => reload({ editor: true }) },
    { label: 'Quit House Control', click: () => app.quit() },
  ]));
}
async function handle(message, win) {
  const mode = win.houseMode;
  const type = message.type;
  if (type === 'ready') {
    win.houseReady = true;
    if (message.error) throw new Error(message.error);
    if (mode === 'panel') { await invoke(win, 'shown'); poll(); }
    else if (mode === 'island') notify('panel', 'share');
    else if (mode === 'pairing') pairingStatus();
    else if (mode === 'login' && win.loginValue) invoke(win, 'pairingStatus', win.loginValue);
    else if (mode === 'agent') invoke(win, 'agentStatus', agent.status());
    return { ok: true };
  }
  if (mode === 'pairing') {
    if (type === 'pair.copy') clipboard.writeText(sync.state.pairingLink || '');
    else if (type === 'pair.reset') {
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Reset pairing'], defaultId: 0, cancelId: 0, message: 'Reset pairing?', detail: 'Every paired phone will need to scan the new code.' });
      if (response === 1) { await sync.reset(name); await pairingStatus(); }
    } else if (type === 'pair.disable') { await sync.disable(); win.close(); buildTray(); }
    else throw new Error('Unknown pairing action.');
    return { ok: true };
  }
  if (type.startsWith('agent.') && mode === 'agent') { await agent.handle(message); return { ok: true }; }
  if (['summary', 'state'].includes(type) && ['panel', 'island'].includes(mode)) {
    if (type === 'state') {
      const state = { ...message }; delete state.type;
      for (const target of ['panel', 'island']) if (target !== mode) notify(target, 'adopt', state);
    }
    const summary = message.summary || message;
    if (summary.lightsOn != null) tray.setToolTip(`House Control · ${summary.lightsOn} lights on${summary.acOn ? ` · ${summary.acTarget}°` : ''}`);
    return { ok: true };
  }
  if (type === 'command' && ['panel', 'island'].includes(mode)) return hub.command(message);
  if (['panel', 'island'].includes(mode)) {
    switch (type) {
      case 'openEditor': show('editor'); return { ok: true };
      case 'openAgent': show('agent'); return { ok: true };
      case 'pairPhone': await pairPhone(); return { ok: true };
      case 'selectPlan': plans.select(message.plan); reload({ editor: true }); return { ok: true };
      case 'loadPlan': await loadPlan(); return { ok: true };
      case 'revealPlan': shell.showItemInFolder(plans.file); return { ok: true };
      case 'close': win.hide(); return { ok: true };
      case 'quit': app.quit(); return { ok: true };
    }
  }
  if (mode !== 'editor') throw new Error(`Unsupported ${mode} action.`);
  switch (type) {
    case 'savePlan': return savePlan(message.config);
    case 'importPlan': return importDialog(win);
    case 'exportPlan': {
      validatePlan(message.config);
      const result = await dialog.showSaveDialog(win, { defaultPath: 'home.json', filters: [{ name: 'Floor plan', extensions: ['json'] }] });
      if (result.canceled) return { cancelled: true };
      fs.writeFileSync(result.filePath, JSON.stringify(message.config, null, 2)); return { ok: true };
    }
    case 'services.info': return hub.servicesInfo;
    case 'devices.all': return hub.allDevices();
    case 'tuya.devices': return { devices: await hub.listDevices() };
    case 'tuya.save': await hub.saveTuya(message.accessId || '', message.accessSecret || '', message.region || 'eu'); return hub.tuyaInfo;
    case 'smartlife.begin': { const login = await hub.beginLogin(message.userCode || ''); return { token: login.token, qr: await QRCode.toDataURL(login.qrContent, { width: 300 }) }; }
    case 'smartlife.poll': { const connected = await hub.finishLogin(message.token || '', message.userCode || ''); if (connected) broadcast(); return { connected, info: hub.smartLifeInfo }; }
    case 'smartlife.signOut': hub.signOut(); broadcast(); return hub.smartLifeInfo;
    case 'services.discover': return { found: await hub.discover(message.service) };
    case 'homeassistant.connect': await hub.homeAssistant.connect(message.url || '', message.token || ''); break;
    case 'hue.pair': {
      try { await hub.hue.pair(message.host || '', message.bridgeId, message.name); }
      catch (error) { if (error.waiting || error.code === '101' || error.name === 'ButtonNotPressed') return { waiting: true }; throw error; }
      break;
    }
    case 'service.disconnect': {
      const services = { homeassistant: hub.homeAssistant, hue: hub.hue, smartlife: hub.smartLife, tuya: hub.tuya };
      if (!services[message.service]) throw new Error('This platform is unavailable on Windows.');
      services[message.service].disconnect(); break;
    }
    default: throw new Error(`Unknown editor action: ${type}`);
  }
  refreshLinks(); broadcast(); poll(); return hub.servicesInfo;
}
async function poll() {
  if (polling || !hub.canPoll) return;
  polling = true;
  try { const update = await hub.poll(); if (update) { await notify('panel', 'applyRemote', update); await notify('island', 'applyRemote', update); } }
  catch (error) { log(error); } finally { polling = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => show());
  app.whenReady().then(async () => {
    plans = new PlanStore(app.getPath('userData'));
    secrets = new SecureStore(app.getPath('userData'), safeStorage);
    hub = new DeviceHub(secrets, { onStale: () => poll() });
    sync = new DesktopSync({ store: secrets,
      nodePath: app.isPackaged ? path.join(process.resourcesPath, 'runtime/node.exe') : path.join(assetRoot, '../runtime/node.exe'),
      snapshot, onPeersChanged: () => { pairingStatus().catch(log); buildTray(); },
      onShowQR: (content, device) => showLoginCode(content, device).catch(log),
      onError: error => { syncError = error.message; pairingStatus().catch(log); log(error); },
    });
    agent = createAgent({
      request: async request => {
        const panel = windowFor('panel');
        if (!panel.houseReady) throw new Error('The home is loading. Try again shortly.');
        const response = await invoke(panel, 'agent', request);
        if (!response) throw new Error('The home did not respond.');
        return typeof response === 'string' ? JSON.parse(response) : response;
      },
      getPlan: () => ({ active: plans.activePlan, custom: plans.custom() }),
      savePlan,
      restorePlan: async snapshot => { if (snapshot.custom) plans.save(snapshot.custom); else if (fs.existsSync(plans.file)) fs.unlinkSync(plans.file); plans.select(snapshot.active); reload({ editor: true }); },
      settings: plans.settings.agent, saveSettings: value => plans.setSetting('agent', value),
      onStatus: value => { notify('agent', 'agentStatus', value); notify('panel', 'agentLive', value.state === 'live'); buildTray(); },
      clipboard: text => clipboard.writeText(text), openExternal: url => shell.openExternal(url),
      home: () => plans.custom()?.name || 'My home', dataDirectory: app.getPath('userData'),
    });
    protocol.handle('house', request => {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname);
      let base, suffix;
      if (relative.startsWith('/web/')) { base = path.join(assetRoot, 'web'); suffix = relative.slice(5); }
      else if (relative.startsWith('/shell/')) { base = __dirname; suffix = relative.slice(7); if (!['pairing.html', 'pairing.css', 'pairing.js'].includes(suffix)) return new Response('Not found', { status: 404 }); }
      else return new Response('Not found', { status: 404 });
      const file = path.resolve(base, suffix);
      if (!file.startsWith(base + path.sep)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    });
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'"],
    } }));
    ipcMain.on('house:boot', event => { const win = trusted(event); event.returnValue = win ? boot(win.houseMode) : {}; });
    ipcMain.on('house:message', async (event, message) => {
      const win = trusted(event);
      if (!win || !message || typeof message !== 'object' || typeof message.type !== 'string') return;
      if (JSON.stringify(message).length > 8 * 1024 * 1024) return;
      try { const result = await handle(message, win); if (Number.isSafeInteger(message.callId)) invoke(win, 'reply', message.callId, result ?? { ok: true }); }
      catch (error) { if (Number.isSafeInteger(message.callId)) invoke(win, 'reply', message.callId, { error: error.message }); else { log(error); if (!['summary', 'state'].includes(message.type)) dialog.showErrorBox('House Control', error.message); } }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'House Control', submenu: [
      { label: 'Home', accelerator: 'Ctrl+1', click: () => show() }, { label: 'Edit Home', accelerator: 'Ctrl+E', click: () => show('editor') },
      { label: 'Pair Phone', click: guarded(pairPhone) }, { label: 'AI Access', click: () => show('agent') }, { type: 'separator' }, { role: 'quit' },
    ] }, { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }]));
    tray = new Tray(nativeImage.createFromPath(path.join(assetRoot, 'icon.png')).resize({ width: 24, height: 24 }));
    tray.setToolTip('House Control'); tray.on('click', () => { const panel = windows.get('panel'); if (panel?.isVisible()) panel.hide(); else show(); });
    refreshLinks(); buildTray();
    await sync.start().catch(log);
    show(); hub.start(); pollTimer = setInterval(poll, 12000);
    if (plans.settings.island !== false && process.env.HOUSE_ISLAND !== '0') toggleIsland();
    screen.on('display-metrics-changed', () => { const island = windows.get('island'); if (island) { const display = screen.getPrimaryDisplay(); island.setPosition(Math.round(display.bounds.x + (display.bounds.width - 820) / 2), display.workArea.y); } });
    if (!app.isPackaged && process.env.HOUSE_SMOKE === '1') require('./smoke.cjs').run({ app, windows, show, plans, secrets, sync, agent, handle, invoke }).catch(error => { log(error); app.exit(1); });
  }).catch(error => { log(error); dialog.showErrorBox('House Control could not start', error.message); app.exit(1); });
}
app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true; clearInterval(pollTimer); clearInterval(islandTimer); clearTimeout(loginTimer); hub?.stop();
  Promise.allSettled([sync?.close(), agent?.close()]).finally(() => { tray?.destroy(); app.quit(); });
});
