'use strict';
// Runs in the bundled standard Node runtime, whose OpenSSL supports TLS-PSK.
const { SyncServer } = require('./sync.cjs');
let server;
let snapshot = {};
function send(message) { if (process.connected) process.send(message); }
function state() {
  return { pairing: server.pairing, pairingLink: server.pairingLink,
    connectedDevices: server.connectedDevices, port: server.port,
    isEnabled: server.isEnabled, isAdvertised: server.isAdvertised };
}
process.on('message', async message => {
  try {
    let result;
    if (message.action === 'init') {
      let pairing = message.pairing;
      snapshot = message.snapshot;
      server = new SyncServer({
        store: { read: () => pairing, write: value => { pairing = value; send({ event: 'persist', value }); } },
        snapshot: () => snapshot,
        onPeersChanged: () => send({ event: 'state', state: state() }),
        onShowQR: (content, device) => send({ event: 'showQR', content, device }),
        onCatalog: (devices, device) => send({ event: 'catalog', devices, device }),
        onError: error => send({ event: 'failure', error: String(error.message || error) }),
      });
      await server.start();
    } else if (message.action === 'snapshot') { snapshot = message.value; server.broadcast(); }
    else if (['enable', 'reset', 'disable', 'stop'].includes(message.action)) result = await server[message.action](message.name);
    else throw new Error('Unknown sync worker operation.');
    send({ id: message.id, result, state: state() });
  } catch (error) { send({ id: message.id, error: error.message }); }
});
process.on('disconnect', () => { server?.stop().finally(() => process.exit(0)); if (!server) process.exit(0); });
