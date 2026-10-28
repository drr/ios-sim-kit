// Just enough PNG to find things on screen by colour: decodes the 8-bit, non-interlaced RGB or RGBA images that
// `axe screenshot` and sips write. No dependencies.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

export function readPng(file: string): Image {
  return decodePng(readFileSync(file));
}

export function decodePng(buf: Buffer): Image {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (depth !== 8 || !channels || interlace !== 0)
        throw new Error(`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (cur[i - channels] as number) : 0;
      const b = prev[i] as number;
      const c = i >= channels ? (prev[i - channels] as number) : 0;
      const x = line[i] as number;
      let v: number;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${filter}`);
      cur[i] = v & 0xff;
    }
    for (let px = 0; px < width; px++) {
      const o = (y * width + px) * 4;
      out[o] = cur[px * channels] as number;
      out[o + 1] = cur[px * channels + 1] as number;
      out[o + 2] = cur[px * channels + 2] as number;
      out[o + 3] = channels === 4 ? (cur[px * channels + 3] as number) : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

export interface Pt {
  x: number;
  y: number;
}

/** Window lights: red, yellow, green, left to right, and the gap between centres; points, not pixels. */
export interface Lights {
  red: Pt;
  yellow: Pt;
  green: Pt;
  gap: number;
}

type Hue = "red" | "yellow" | "green";

/** Loose enough for the small, softened dots of the closed pill as well as the open buttons. */
function hue(r: number, g: number, b: number): Hue | null {
  if (b > 140) return null; // sky, wallpaper teal, white
  if (r > 190 && g < 150 && r - g > 70) return "red";
  if (r > 190 && g > 160) return "yellow";
  if (g > 160 && g - r > 50) return "green";
  return null;
}

/**
 * Finds iPadOS's window lights (the window-controls pill, closed or open) in `region` (points) of a screenshot that
 * is upright and `scale` pixels per point: three blobs, red then yellow then green, in a row and evenly spaced.
 * Returns the leftmost such row, or null.
 */
export function findLights(img: Image, scale: number, region: { x: number; y: number; w: number; h: number }) {
  const x0 = Math.max(0, Math.round(region.x * scale));
  const y0 = Math.max(0, Math.round(region.y * scale));
  const x1 = Math.min(img.width, Math.round((region.x + region.w) * scale));
  const y1 = Math.min(img.height, Math.round((region.y + region.h) * scale));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const mask: (Hue | null)[] = new Array(w * h).fill(null);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = ((y0 + y) * img.width + x0 + x) * 4;
      mask[y * w + x] = hue(img.data[o] as number, img.data[o + 1] as number, img.data[o + 2] as number);
    }
  // Connected blobs of one hue, as centres in points; tiny ones are antialiasing.
  const blobs: { hue: Hue; c: Pt; r: number }[] = [];
  const seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const kind = mask[i];
    if (!kind || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    let n = 0;
    let sx = 0;
    let sy = 0;
    while (stack.length) {
      const j = stack.pop() as number;
      const x = j % w;
      const y = (j - x) / w;
      n++;
      sx += x;
      sy += y;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] || mask[k] !== kind) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    const r = Math.sqrt(n / Math.PI) / scale;
    if (r >= 1.5) blobs.push({ hue: kind, c: { x: (x0 + sx / n) / scale, y: (y0 + sy / n) / scale }, r });
  }
  const of = (k: Hue) => blobs.filter((b) => b.hue === k).sort((a, b) => a.c.x - b.c.x);
  for (const red of of("red"))
    for (const yellow of of("yellow")) {
      const gap = yellow.c.x - red.c.x;
      if (gap <= 0 || gap > 60 || Math.abs(yellow.c.y - red.c.y) > 3) continue;
      const green = of("green").find(
        (g) => Math.abs(g.c.x - yellow.c.x - gap) < Math.max(3, gap * 0.2) && Math.abs(g.c.y - red.c.y) < 3,
      );
      if (green) return { red: red.c, yellow: yellow.c, green: green.c, gap } satisfies Lights;
    }
  return null;
}
