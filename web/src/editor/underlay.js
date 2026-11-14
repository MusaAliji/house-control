// A picture of a floor plan under the editor's plan, to trace the rooms over.
// The picture is a tool of this device: it is kept here (IndexedDB), per home and floor, and is
// never part of the home itself, so it does not sync, grow the plan file or change the 3D model.
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { place, calibrate, move, turn, scaleAbout, extent, heightOf, distance } from './underlayMath.js';

const SVG = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};

const MAX_SIDE = 2400; // pixels: a floor plan is read at this size, no larger
const DB = 'house-trace';

/* ---------- storage: one record per home and floor ---------- */

function db() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('images');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function store(mode, run) {
  const conn = await db();
  try {
    return await new Promise((resolve, reject) => {
      const tx = conn.transaction('images', mode);
      const req = run(tx.objectStore('images'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { conn.close(); }
}
const readRecord = (key) => store('readonly', (s) => s.get(key)).catch(() => null);
const writeRecord = (key, value) => store('readwrite', (s) => s.put(value, key)).catch(() => {});
const deleteRecord = (key) => store('readwrite', (s) => s.delete(key)).catch(() => {});

/* ---------- reading a picture ---------- */

// Decodes a picture, shrinks it to a size that is easy to keep, and flattens it on white.
export async function readPicture(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const hh = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, hh);
    ctx.drawImage(img, 0, 0, w, hh);
    return { src: canvas.toDataURL('image/jpeg', 0.88), aspect: hh / w };
  } finally { URL.revokeObjectURL(url); }
}

/* ---------- the tool ---------- */

/**
 * `plan` is the editor's SVG, `planPoint(ev)` turns a pointer event into plan metres, `view()` is the
 * box on show, and `redraw()` asks the editor to draw the plan again.
 */
export function createUnderlay({ plan, planPoint, view, redraw, toast }) {
  let key = null;
  let u = null; // the geometry, or null without a picture
  let src = '';
  let hidden = false;
  let open = false;
  let mode = 'idle'; // 'idle' | 'move' | 'scale'
  let points = [];
  let drag = null;
  let saveTimer = 0;

  const image = sv('image', { preserveAspectRatio: 'none', 'pointer-events': 'none', class: 'p-underlay' });
  const marks = sv('g', { class: 'p-trace-marks', 'pointer-events': 'none' });
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const card = h('div.trace-card');
  card.hidden = true;
  const button = h('button', { title: 'Trace a floor plan picture', 'aria-label': 'Trace a floor plan picture', onclick: () => toggle() }, icon('image', 16, 2));

  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (key && u) writeRecord(key, { src, u, hidden }); }, 400);
  };

  function paint() {
    plan.classList.toggle('trace-move', mode === 'move');
    plan.classList.toggle('trace-scale', mode === 'scale');
    const visible = !!u && !hidden;
    plan.classList.toggle('tracing', visible);
    image.style.display = visible ? '' : 'none';
    if (!visible) { marks.replaceChildren(); return; }
    image.setAttribute('href', src);
    image.setAttribute('x', u.cx - u.w / 2);
    image.setAttribute('y', u.cz - heightOf(u) / 2);
    image.setAttribute('width', u.w);
    image.setAttribute('height', heightOf(u));
    image.setAttribute('opacity', u.opacity);
    image.setAttribute('transform', `rotate(${u.rot} ${u.cx} ${u.cz})`);
    // Tapped points: crosses a few pixels wide, and the line between them.
    const r = 9 / (plan.getScreenCTM()?.a || 60);
    marks.replaceChildren(
      ...(points.length === 2 ? [sv('line', { x1: points[0][0], y1: points[0][1], x2: points[1][0], y2: points[1][1], class: 'p-trace-line' })] : []),
      ...points.flatMap(([x, z]) => [
        sv('line', { x1: x - r, y1: z, x2: x + r, y2: z, class: 'p-trace-cross' }),
        sv('line', { x1: x, y1: z - r, x2: x, y2: z + r, class: 'p-trace-cross' })]));
  }

  const change = () => { paint(); persist(); };

  function setMode(next) {
    mode = mode === next ? 'idle' : next;
    points = [];
    renderCard();
    paint();
  }

  function toggle(force) {
    open = force ?? !open;
    if (!open) { mode = 'idle'; points = []; }
    card.hidden = !open;
    button.classList.toggle('on', open);
    renderCard();
    paint();
  }

  async function choose(file) {
    if (!file) return;
    try {
      const picture = await readPicture(file);
      src = picture.src;
      u = place(view(), picture.aspect);
      hidden = false;
      mode = 'idle';
      points = [];
      renderCard();
      change();
      redraw();
      toast('Picture added. Set its scale so the rooms you trace come out the right size.');
    } catch {
      toast('Could not read that picture. Try a PNG or a JPEG.', true);
    }
  }
  input.addEventListener('change', () => { choose(input.files?.[0]); input.value = ''; });

  function remove() {
    const was = key;
    u = null; src = ''; points = []; mode = 'idle';
    if (was) deleteRecord(was);
    renderCard(); paint(); redraw();
  }

  /* ---------- the card ---------- */

  const slider = (min, max, step, value, oninput) => h('input', { type: 'range', min, max, step, value, oninput: (ev) => oninput(Number(ev.target.value)) });
  const tool = (name, label, on, run, title) => h(`button.btn${on ? '.primary' : ''}`, { title, onclick: run }, icon(name, 14, 2.2), label);

  function renderCard() {
    const head = h('div.trace-head', h('b', 'Trace a picture'), h('button.trace-x', { 'aria-label': 'Close', onclick: () => toggle(false) }, icon('close', 14, 2.4)));
    if (!u) {
      card.replaceChildren(head,
        h('p.note', 'Put a picture of a floor plan under the plan, set its scale, then draw the rooms over it. The picture stays on this device and is not part of your home.'),
        h('button.btn.primary.wide', { onclick: () => input.click() }, icon('image', 14, 2.2), 'Choose a picture…'), input);
      return;
    }
    const modes = h('div.trace-row',
      tool(hidden ? 'eye' : 'eyeOff', hidden ? 'Show' : 'Hide', false, () => { hidden = !hidden; renderCard(); change(); }),
      tool('move', 'Move', mode === 'move', () => setMode('move'), 'Drag the picture into place'),
      tool('ruler', 'Set scale', mode === 'scale', () => setMode('scale'), 'Tap two ends of something you know the length of'));
    // While moving or setting the scale only the mode and what to do show, so the plan stays in sight.
    const kids = mode !== 'idle' ? [head, modes] : [head, modes,
      h('label.trace-field', h('span', 'See-through'), slider(0.1, 1, 0.05, u.opacity, (v) => { u = { ...u, opacity: v }; change(); })),
      h('div.trace-row', h('span.trace-label', `Turn ${u.rot}°`),
        h('button.btn', { onclick: () => { u = turn(u, -90); renderCard(); change(); } }, '−90°'),
        h('button.btn', { onclick: () => { u = turn(u, -0.5); renderCard(); change(); } }, '−0.5°'),
        h('button.btn', { onclick: () => { u = turn(u, 0.5); renderCard(); change(); } }, '+0.5°'),
        h('button.btn', { onclick: () => { u = turn(u, 90); renderCard(); change(); } }, '+90°'))];
    if (mode === 'move') kids.push(h('p.note', 'Drag on the plan to move the picture.'));
    if (mode === 'scale') {
      if (points.length < 2) {
        kids.push(h('p.note', points.length ? 'Now tap the other end.' : 'Tap one end of a wall, a door or anything you know the length of, then the other end.'));
      } else {
        const length = h('input', { type: 'number', min: 0.1, step: 0.05, inputmode: 'decimal', placeholder: 'metres', 'aria-label': 'Real length in metres' });
        const apply = () => {
          const metres = Number(length.value);
          if (!(metres > 0)) { toast('Type how long it really is, in metres.', true); return; }
          u = calibrate(u, points[0], points[1], metres);
          mode = 'idle'; points = [];
          renderCard(); change(); redraw();
          toast(`Scale set: that stretch is now ${metres} m on the plan.`);
        };
        length.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') apply(); });
        kids.push(h('p.note', `Those two points are ${Math.round(distance(points[0], points[1]) * 100) / 100} m apart on the plan. How long are they really?`),
          h('div.trace-row', length, h('span.trace-label', 'm'), h('button.btn.primary', { onclick: apply }, 'Apply')));
        queueMicrotask(() => length.focus());
      }
    }
    if (mode === 'idle') {
      kids.push(h('div.trace-row',
        h('button.btn', { onclick: () => input.click() }, 'Replace…'),
        h('button.btn.danger', { onclick: remove }, icon('trash', 14, 2.2), 'Remove')));
    }
    kids.push(input);
    card.replaceChildren(...kids);
  }

  /* ---------- tapping and dragging on the plan, ahead of the editor's own handlers ---------- */

  const take = (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
  plan.addEventListener('pointerdown', (ev) => {
    if (!u || hidden || mode === 'idle' || !ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    take(ev);
    if (mode === 'scale') {
      points = points.length >= 2 ? [planPoint(ev)] : [...points, planPoint(ev)];
      renderCard(); paint();
    } else {
      plan.setPointerCapture?.(ev.pointerId);
      drag = { id: ev.pointerId, last: planPoint(ev) };
    }
  }, true);
  plan.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    take(ev);
    const p = planPoint(ev);
    u = move(u, p[0] - drag.last[0], p[1] - drag.last[1]);
    drag.last = p;
    change();
  }, true);
  const lift = (ev) => { if (drag && ev.pointerId === drag.id) { take(ev); drag = null; } };
  plan.addEventListener('pointerup', lift, true);
  plan.addEventListener('pointercancel', lift, true);

  // On a computer, ⌥ + wheel scales the picture about the pointer without touching the plan.
  plan.addEventListener('wheel', (ev) => {
    if (!u || hidden || !ev.altKey) return;
    ev.stopImmediatePropagation(); ev.preventDefault();
    u = scaleAbout(u, planPoint(ev), Math.exp(-ev.deltaY * 0.004));
    change();
  }, { capture: true, passive: false });

  return {
    button,
    card,
    /** The nodes to draw, in order, right after the grid. */
    nodes: () => { paint(); return u && !hidden ? [image, marks] : []; },
    /** The picture's outline on the plan, when it is showing: an empty floor fits the view to it. */
    outline: () => (u && !hidden ? extent(u) : null),
    /** Called with the home's name and floor on every draw: loads that floor's picture when it changes. */
    sync(next) {
      if (next === key) return;
      key = next; u = null; src = ''; hidden = false; mode = 'idle'; points = []; drag = null;
      renderCard(); paint();
      const asked = next;
      readRecord(next).then((rec) => {
        if (key !== asked || !rec?.src || !rec.u) return;
        src = rec.src; u = rec.u; hidden = !!rec.hidden;
        renderCard(); redraw();
      });
    },
  };
}
