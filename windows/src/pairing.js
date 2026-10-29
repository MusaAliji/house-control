'use strict';
window.house = { pairingStatus: update };
function update(value) {
  for (const key of ['title', 'detail', 'status']) document.getElementById(key).textContent = value[key] || '';
  if (value.qr) document.getElementById('qr').src = value.qr;
  document.getElementById('actions').hidden = !!value.login;
}
for (const action of ['copy', 'reset', 'disable']) document.getElementById(action).onclick = () => window.HouseDesktop.postMessage({ type: `pair.${action}` });
window.HouseDesktop.postMessage({ type: 'ready' });
