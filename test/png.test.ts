import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { decodePng, findLights } from "../src/png.ts";

/** An RGB PNG of `rgb` (w×h×3), each row with the given filter (0 none, 1 sub, 2 up), encoded the way a writer does. */
function encode(w: number, h: number, rgb: Uint8Array, filter: (y: number) => number): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    const f = filter(y);
    rows.push(f);
    for (let i = 0; i < w * 3; i++) {
      const x = rgb[y * w * 3 + i] as number;
      const left = i >= 3 ? (rgb[y * w * 3 + i - 3] as number) : 0;
      const up = y > 0 ? (rgb[(y - 1) * w * 3 + i] as number) : 0;
      rows.push((x - (f === 1 ? left : f === 2 ? up : 0)) & 0xff);
    }
  }
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body, Buffer.alloc(4)]); // the decoder doesn't check CRCs
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A white w×h image (2 px per point) with discs of the given colours, centres and radii in points. */
function picture(w: number, h: number, discs: { c: [number, number, number]; x: number; y: number; r: number }[]) {
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (const d of discs)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if ((x / 2 - d.x) ** 2 + (y / 2 - d.y) ** 2 <= d.r ** 2) rgb.set(d.c, (y * w + x) * 3);
  return rgb;
}

const RED: [number, number, number] = [255, 11, 24];
const YELLOW: [number, number, number] = [255, 201, 0];
const GREEN: [number, number, number] = [0, 202, 72];

test("png: decodes RGB rows with none, sub and up filters", () => {
  const rgb = picture(40, 30, [{ c: RED, x: 10, y: 7, r: 4 }]);
  const img = decodePng(encode(40, 30, rgb, (y) => y % 3));
  assert.equal(img.width, 40);
  assert.equal(img.height, 30);
  for (let i = 0; i < 40 * 30; i++)
    assert.deepEqual([...img.data.subarray(i * 4, i * 4 + 4)], [...rgb.subarray(i * 3, i * 3 + 3), 255]);
  assert.throws(() => decodePng(Buffer.from("not a png at all")), /not a PNG/);
});

test("findLights: the closed pill and the open buttons, in points; nothing without all three", () => {
  const W = 400;
  const H = 200;
  const lit = (gap: number, r: number) =>
    decodePng(
      encode(
        W,
        H,
        picture(W, H, [
          { c: [40, 200, 200], x: 150, y: 40, r: 8 }, // teal wallpaper: not a light
          { c: RED, x: 30, y: 50, r },
          { c: YELLOW, x: 30 + gap, y: 50, r },
          { c: GREEN, x: 30 + 2 * gap, y: 50, r },
        ]),
        () => 0,
      ),
    );
  const all = { x: 0, y: 0, w: W / 2, h: H / 2 };
  const closed = findLights(lit(10, 3), 2, all);
  assert.ok(closed && Math.abs(closed.gap - 10) < 0.5 && Math.abs(closed.yellow.x - 40) < 0.5);
  const open = findLights(lit(35, 11), 2, all);
  assert.ok(open && Math.abs(open.green.x - 100) < 0.5 && Math.abs(open.green.y - 50) < 0.5);
  assert.equal(findLights(lit(35, 11), 2, { x: 0, y: 70, w: 200, h: 30 }), null); // outside the region
  const noGreen = picture(W, H, [
    { c: RED, x: 30, y: 50, r: 3 },
    { c: YELLOW, x: 40, y: 50, r: 3 },
  ]);
  assert.equal(findLights(decodePng(encode(W, H, noGreen, () => 0)), 2, all), null);
});
