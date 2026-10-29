'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const boot = ipcRenderer.sendSync('house:boot');
contextBridge.exposeInMainWorld('__HOUSE_BOOT__', boot);
contextBridge.exposeInMainWorld('HouseDesktop', {
  postMessage(message) { ipcRenderer.send('house:message', message); },
});
