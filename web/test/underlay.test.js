import { test } from 'node:test';
import assert from 'node:assert/strict';
import { place, calibrate, scaleAbout, turn, extent, distance, heightOf } from '../src/editor/underlayMath.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('a new image fits inside 80% of the view and sits in its middle', () => {
  const u = place({ x: 0, y: 0, w: 10, h: 5 }, 2); // a tall image: height twice its width
  near(heightOf(u), 4); near(u.w, 2); near(u.cx, 5); near(u.cz, 2.5);
  const wide = place({ x: -2, y: 1, w: 10, h: 10 }, 0.5);
  near(wide.w, 8); near(wide.cx, 3); near(wide.cz, 6);
});
test('calibrating makes the two tapped points the real distance apart and keeps the first in place', () => {
  const u = { cx: 5, cz: 3, w: 4, aspect: 0.5, rot: 0, opacity: 1 };
  const a = [4, 3], b = [6, 3]; // 2 m apart on screen, really 5 m
  const c = calibrate(u, a, b, 5);
  near(c.w, 10); near(c.cx, 4 + (5 - 4) * 2.5); near(c.cz, 3);
  // A's place on the image is unchanged: its offset from the centre grew by the same factor.
  near((a[0] - c.cx) / c.w, (a[0] - u.cx) / u.w);
});
test('bad calibration input leaves the image alone', () => {
  const u = place({ x: 0, y: 0, w: 10, h: 10 }, 1);
  for (const m of [0, -3, NaN, Infinity]) assert.equal(calibrate(u, [1, 1], [2, 1], m), u);
  assert.equal(calibrate(u, [1, 1], [1, 1], 4), u);
});
test('scale is kept within sane limits', () => {
  const u = { cx: 0, cz: 0, w: 10, aspect: 1, rot: 0, opacity: 1 };
  near(scaleAbout(u, [0, 0], 1e9).w, 400); near(scaleAbout(u, [0, 0], 1e-9).w, 0.5);
});
test('turning wraps within a half turn and the extent follows the turn', () => {
  let u = { cx: 0, cz: 0, w: 4, aspect: 0.5, rot: 170, opacity: 1 };
  near(turn(u, 20).rot, -170); near(turn(u, -350).rot, 180); near(turn(u, 10).rot, 180); near(turn(u, 200).rot, 10);
  const quarter = extent({ ...u, rot: 90 });
  near(quarter.maxX - quarter.minX, 2); near(quarter.maxZ - quarter.minZ, 4);
  near(distance([0, 0], [3, 4]), 5);
});
