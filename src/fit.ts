// Least-squares affine fits: where the page saw taps (seen) against where AXe sent them (sent), page = A·sent + b.

export interface Pt {
  x: number;
  y: number;
}

/** Least-squares fit of v = a·x + b·y + c over the points; returns [a, b, c] (NaN if the points are collinear). */
export function fit(pts: Pt[], v: number[]): [number, number, number] {
  const s = { xx: 0, xy: 0, x: 0, yy: 0, y: 0, n: 0, vx: 0, vy: 0, v: 0 };
  pts.forEach((p, i) => {
    const vi = v[i] ?? 0;
    s.xx += p.x * p.x;
    s.xy += p.x * p.y;
    s.x += p.x;
    s.yy += p.y * p.y;
    s.y += p.y;
    s.n += 1;
    s.vx += vi * p.x;
    s.vy += vi * p.y;
    s.v += vi;
  });
  const m = [
    [s.xx, s.xy, s.x],
    [s.xy, s.yy, s.y],
    [s.x, s.y, s.n],
  ];
  const r = [s.vx, s.vy, s.v];
  const at = (q: number[][], i: number, j: number) => q[i]?.[j] ?? 0;
  const det = (q: number[][]) =>
    at(q, 0, 0) * (at(q, 1, 1) * at(q, 2, 2) - at(q, 1, 2) * at(q, 2, 1)) -
    at(q, 0, 1) * (at(q, 1, 0) * at(q, 2, 2) - at(q, 1, 2) * at(q, 2, 0)) +
    at(q, 0, 2) * (at(q, 1, 0) * at(q, 2, 1) - at(q, 1, 1) * at(q, 2, 0));
  const d = det(m);
  if (Math.abs(d) < 1e-9) return [Number.NaN, Number.NaN, Number.NaN];
  const col = (c: number) => det(m.map((row, i) => row.map((cell, j) => (j === c ? (r[i] ?? 0) : cell)))) / d;
  return [col(0), col(1), col(2)];
}

/** page = A·sent + b, A row-major [a, b; c, d]. */
export interface Affine {
  A: [number, number, number, number];
  b: Pt;
  /** The largest distance between a seen point and the fit's prediction. */
  residual: number;
}

export function apply(k: Pick<Affine, "A" | "b">, p: Pt): Pt {
  const [a, b, c, d] = k.A;
  return { x: a * p.x + b * p.y + k.b.x, y: c * p.x + d * p.y + k.b.y };
}

/** Fits page = A·sent + b; throws if there are fewer than 3 points or they lie on one line. */
export function fitAffine(sent: Pt[], seen: Pt[]): Affine {
  if (sent.length < 3 || sent.length !== seen.length) throw new Error("a fit needs 3 or more pairs of points");
  const fx = fit(
    sent,
    seen.map((p) => p.x),
  );
  const fy = fit(
    sent,
    seen.map((p) => p.y),
  );
  if ([...fx, ...fy].some(Number.isNaN)) throw new Error("the points lie on one line");
  const k = { A: [fx[0], fx[1], fy[0], fy[1]] as Affine["A"], b: { x: fx[2], y: fy[2] } };
  const residual = Math.max(
    ...sent.map((s, i) => {
      const p = apply(k, s);
      const q = seen[i] ?? p;
      return Math.hypot(p.x - q.x, p.y - q.y);
    }),
  );
  return { ...k, residual };
}

/** The point to send so the page sees `page`: A⁻¹·(page − b). Throws if A is singular. */
export function invert(k: Pick<Affine, "A" | "b">, page: Pt): Pt {
  const [a, b, c, d] = k.A;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) throw new Error("the calibration is singular");
  const x = page.x - k.b.x;
  const y = page.y - k.b.y;
  return { x: (d * x - b * y) / det, y: (-c * x + a * y) / det };
}
