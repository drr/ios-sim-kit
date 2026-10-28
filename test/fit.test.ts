import assert from "node:assert/strict";
import { test } from "node:test";
import { type Affine, apply, fitAffine, invert, type Pt } from "../src/fit.ts";

const SENT: Pt[] = [
  { x: 200, y: 300 },
  { x: 400, y: 300 },
  { x: 200, y: 500 },
  { x: 400, y: 500 },
  { x: 310, y: 420 },
];

/** Where the page would see SENT under `k`, with a little deterministic noise. */
const seenUnder = (k: Pick<Affine, "A" | "b">, noise = 0) =>
  SENT.map((p, i) => {
    const q = apply(k, p);
    return { x: q.x + noise * Math.sin(i * 1.7), y: q.y + noise * Math.cos(i * 2.3) };
  });

function close(a: number[], b: number[], eps: number) {
  for (const [i, v] of a.entries()) assert.ok(Math.abs(v - (b[i] ?? Number.NaN)) < eps, `${a} ≉ ${b}`);
}

const CASES: [string, Pick<Affine, "A" | "b">][] = [
  ["identity", { A: [1, 0, 0, 1], b: { x: 0, y: 0 } }],
  ["pure offset (Safari's toolbar, a left-half window)", { A: [1, 0, 0, 1], b: { x: -10, y: -74 } }],
  ["90° rotation", { A: [0, 1, -1, 0], b: { x: 0, y: 834 } }],
  ["a scaled rotation (upstream AXe in landscape)", { A: [0, 0.689, -0.689, 0], b: { x: 12.5, y: 1001.3 } }],
];

for (const [name, k] of CASES)
  test(`fit and invert: ${name}`, () => {
    const exact = fitAffine(SENT, seenUnder(k));
    close(exact.A, k.A, 1e-9);
    close([exact.b.x, exact.b.y], [k.b.x, k.b.y], 1e-6);
    assert.ok(exact.residual < 1e-6);
    const noisy = fitAffine(SENT, seenUnder(k, 0.8));
    close(noisy.A, k.A, 0.02);
    assert.ok(noisy.residual < 2);
    for (const p of [
      { x: 0, y: 0 },
      { x: 123.4, y: 567.8 },
    ]) {
      const back = invert(exact, apply(exact, p));
      close([back.x, back.y], [p.x, p.y], 1e-6);
    }
  });

test("collinear points or too few are refused", () => {
  const line = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 50, y: 300 }));
  assert.throws(() => fitAffine(line, line), /one line/);
  assert.throws(() => fitAffine(SENT.slice(0, 2), SENT.slice(0, 2)), /3 or more/);
  assert.throws(() => invert({ A: [1, 2, 2, 4], b: { x: 0, y: 0 } }, { x: 1, y: 1 }), /singular/);
});
