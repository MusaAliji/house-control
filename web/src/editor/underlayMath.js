// The geometry of the tracing image under the plan. Pure functions, no DOM.
// An underlay is { cx, cz, w, aspect, rot, opacity }: its centre and width in metres on the plan,
// its height over its width, its turn in degrees, and how see-through it is.

export const MIN_WIDTH = 0.5;
export const MAX_WIDTH = 400;

export const heightOf = (u) => u.w * u.aspect;
export const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** A new image: 80% of the part of the plan on show, in its middle. */
export function place(box, aspect) {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  const w = Math.min(box.w * 0.8, (box.h * 0.8) / a);
  return { cx: box.x + box.w / 2, cz: box.y + box.h / 2, w, aspect: a, rot: 0, opacity: 0.55 };
}

const clampWidth = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

/** Scales the image about a plan point, which stays where it is. */
export function scaleAbout(u, [px, pz], factor) {
  const w = clampWidth(u.w * factor);
  const f = w / u.w;
  return { ...u, w, cx: px + (u.cx - px) * f, cz: pz + (u.cz - pz) * f };
}

/** The two points A and B, tapped on the image, are `metres` apart in the real home. */
export function calibrate(u, a, b, metres) {
  const d = distance(a, b);
  if (!(d > 1e-6) || !(metres > 0) || !Number.isFinite(metres)) return u;
  return scaleAbout(u, a, metres / d);
}

export const move = (u, dx, dz) => ({ ...u, cx: u.cx + dx, cz: u.cz + dz });

/** Turns the image about its middle, kept within a half turn either way. */
export function turn(u, degrees) {
  let rot = (u.rot + degrees) % 360;
  if (rot > 180) rot -= 360;
  if (rot <= -180) rot += 360;
  return { ...u, rot: Math.round(rot * 100) / 100 };
}

/** The image's corners on the plan, turned: for fitting the view to it. */
export function corners(u) {
  const hw = u.w / 2;
  const hh = heightOf(u) / 2;
  const r = (u.rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, z]) => [u.cx + x * cos - z * sin, u.cz + x * sin + z * cos]);
}

export function extent(u) {
  const c = corners(u);
  const xs = c.map((p) => p[0]);
  const zs = c.map((p) => p[1]);
  return { minX: Math.min(...xs), minZ: Math.min(...zs), maxX: Math.max(...xs), maxZ: Math.max(...zs) };
}
