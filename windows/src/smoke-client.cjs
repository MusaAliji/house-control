'use strict';
const tls = require('node:tls');
const { deriveKey, FrameDecoder, encodeFrame, CIPHER } = require('./sync.cjs');
process.on('message', ({ pairing, port, revision }) => {
  const socket = tls.connect({ host: '127.0.0.1', port, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: CIPHER,
    rejectUnauthorized: false, checkServerIdentity: () => undefined,
    pskCallback: () => ({ identity: 'housecontrol', psk: deriveKey(pairing) }),
  }, () => socket.write(encodeFrame({ type: 'hello', device: 'Desktop boundary probe', rev: '' })));
  const timer = setTimeout(() => { process.send({ error: 'TLS probe timed out' }); socket.destroy(); }, 10000);
  socket.on('error', error => { clearTimeout(timer); process.send({ error: error.message }); });
  const decoder = new FrameDecoder(state => { clearTimeout(timer); process.send({ plan: JSON.parse(state.plan), revision: state.rev, cipher: socket.getCipher().name }); socket.destroy(); });
  socket.on('data', chunk => { try { decoder.push(chunk); } catch (error) { process.send({ error: error.message }); socket.destroy(); } });
});
process.on('disconnect', () => process.exit(0));
