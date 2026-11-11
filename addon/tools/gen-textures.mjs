// Generates the PLACEHOLDER textures for CensorCraft (no image tools or dependencies needed).
//
//   pnpm textures        (also runs as the first step of `pnpm build`)
//
// To use your own art: replace the PNG files listed at the bottom of this script with images of
// the same size and layout, then delete (or stop running) the matching block here so they are not
// overwritten. `pnpm build` only regenerates a file when CENSOR_KEEP_TEXTURES is not set:
//   set CENSOR_KEEP_TEXTURES=1 && pnpm build
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const RP = path.resolve(here, "../packs/RP");
const BP = path.resolve(here, "../packs/BP");

// ---- tiny PNG writer -----------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

class Image {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4); // transparent
  }
  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const [r, g, b, a = 255] = color;
    this.data.set([r, g, b, a], (y * this.width + x) * 4);
  }
  rect(x, y, w, h, color) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, typeof color === "function" ? color(i, j) : color);
  }
  toPng() {
    const raw = Buffer.alloc((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 4 + 1)] = 0; // filter: none
      raw.set(this.data.subarray(y * this.width * 4, (y + 1) * this.width * 4), y * (this.width * 4 + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
const shade = (c, f) => [Math.min(255, Math.round(c[0] * f)), Math.min(255, Math.round(c[1] * f)), Math.min(255, Math.round(c[2] * f)), c[3] ?? 255];
/** Deterministic speckle so flat colours look less plastic. */
const noisy = (color, amount = 0.06, seed = 1) => (i, j) => {
  const n = Math.sin((i + 1) * 12.9898 * seed + (j + 1) * 78.233) * 43758.5453;
  return shade(color, 1 + (n - Math.floor(n) - 0.5) * 2 * amount);
};

/**
 * Paint a Bedrock "box UV" layout at (u, v) for a cube of size w x h x d:
 *   row 1:        [d: -]   [w: top] [w: bottom]
 *   row 2 (h):    [d: side][w: FRONT (north)][d: side][w: back]
 */
function paintBox(img, u, v, w, h, d, faces) {
  const paint = (x, y, fw, fh, color) => img.rect(x, y, fw, fh, color);
  paint(u + d, v, w, d, faces.top ?? faces.all);
  paint(u + d + w, v, w, d, faces.bottom ?? faces.all);
  paint(u, v + d, d, h, faces.side ?? faces.all);
  paint(u + d, v + d, w, h, faces.front ?? faces.all);
  paint(u + d + w, v + d, d, h, faces.side ?? faces.all);
  paint(u + d + w + d, v + d, w, h, faces.back ?? faces.all);
}

function write(file, img) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, img.toPng());
  console.log(`  wrote ${path.relative(path.resolve(here, ".."), file)} (${img.width}x${img.height})`);
}

// ---- whiteboard: 3 blocks wide x 2 blocks high ------------------------------------------------------
// One custom block cannot be larger than 30 pixels, so the board is built from 6 blocks ("parts").
// The whole board is described once, in board pixels (x: -24..24, y: 0..32, front faces -z), and
// cut into one geometry per part. The texture (64x64) is shared by all parts:
//   (0,0)   46x29  writing surface (continuous across the parts)
//   (48,0)  8x8 frame     (56,0)  8x8 tray      (48,16) 16x16 back panel
//   (48,8)  4x4 apple     (52,8)  2x2 leaf      (54,8)  2x2 stem      (56,8) 4x2 marker
const BOARD_REGIONS = {
  frame: [48, 0, 8, 8],
  tray: [56, 0, 8, 8],
  back: [48, 16, 16, 16],
  apple: [48, 8, 4, 4],
  leaf: [52, 8, 2, 2],
  stem: [54, 8, 2, 2],
  marker: [56, 8, 4, 2],
};
/** [x0, y0, z0, x1, y1, z1, material] in board pixels. */
const BOARD_ELEMENTS = [
  [-24, 1, 7, 24, 32, 8, "back"],
  [-23, 2, 6.5, 23, 31, 7, "surface"],
  [-24, 31, 6, 24, 32, 7, "frame"],
  [-24, 1, 6, 24, 2, 7, "frame"],
  [-24, 2, 6, -23, 31, 7, "frame"],
  [23, 2, 6, 24, 31, 7, "frame"],
  [-24, 0, 3, 24, 1, 8, "tray"], // the ledge along the bottom border
  [3, 1, 3, 6, 4, 6, "apple"], // the apple sits on the ledge
  [4, 4, 4, 5, 5, 5, "stem"],
  [5, 4, 4, 7, 5, 5, "leaf"],
  [-15, 1, 4, -11, 2, 5, "marker"],
];
/** Part index -> [column, row]. Part 0 (bottom centre) is the block the player places. Keep in sync with src/boards.ts. */
const BOARD_PARTS = [[0, 0], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function whiteboardTexture() {
  const img = new Image(64, 64);
  img.rect(0, 0, 46, 29, noisy(hex("#f5f6f2"), 0.015, 3));
  // "Marker" writing so it reads as a used whiteboard.
  const blue = hex("#2c5fb8");
  const red = hex("#c23b3b");
  const green = hex("#2f8f4e");
  const line = (x, y, w, color) => img.rect(x, y, w, 1, color);
  line(4, 4, 14, blue);
  line(4, 6, 9, blue);
  line(4, 8, 12, blue);
  line(24, 4, 10, red);
  line(24, 6, 16, red);
  line(6, 14, 20, green);
  line(6, 16, 11, green);
  img.rect(32, 12, 1, 7, blue); // a little coordinate system
  img.rect(30, 17, 10, 1, blue);
  for (let i = 0; i < 6; i++) img.set(33 + i, 16 - i, red);
  line(5, 22, 8, blue);
  line(16, 22, 5, red);
  line(26, 23, 13, green);
  img.rect(48, 0, 8, 8, noisy(hex("#aeb4bd"), 0.05, 5));
  img.rect(56, 0, 8, 8, noisy(hex("#8d939d"), 0.05, 7));
  img.rect(48, 16, 16, 16, noisy(hex("#6a6f79"), 0.05, 11));
  const apple = hex("#d2281f");
  img.rect(48, 8, 4, 4, apple);
  img.rect(48, 11, 4, 1, shade(apple, 0.75));
  img.set(49, 9, hex("#ff8a7a"));
  img.rect(52, 8, 2, 2, hex("#3fa535"));
  img.set(53, 9, hex("#2e7d27"));
  img.rect(54, 8, 2, 2, hex("#6b4423"));
  img.rect(56, 8, 4, 2, hex("#2c5fb8"));
  img.rect(59, 8, 1, 2, hex("#e8e8e8"));
  return img;
}

function whiteboardGeometry() {
  const geometries = BOARD_PARTS.map(([column, row], part) => {
    const minX = column * 16 - 8;
    const minY = row * 16;
    const cubes = [];
    for (const [x0, y0, z0, x1, y1, z1, material] of BOARD_ELEMENTS) {
      // Clip the element to this part's block.
      const cx0 = Math.max(x0, minX);
      const cx1 = Math.min(x1, minX + 16);
      const cy0 = Math.max(y0, minY);
      const cy1 = Math.min(y1, minY + 16);
      if (cx1 <= cx0 || cy1 <= cy0) continue;
      const w = cx1 - cx0;
      const h = cy1 - cy0;
      const d = z1 - z0;
      let uv;
      if (material === "surface") {
        // Seen from the front, +x is on the viewer's left, so u runs against x.
        const blank = { uv: [0, 0], uv_size: [1, 1] };
        uv = { north: { uv: [23 - cx1, 31 - cy1], uv_size: [w, h] }, east: blank, west: blank, up: blank, down: blank };
      } else {
        const [u, v, rw, rh] = BOARD_REGIONS[material];
        const face = (a, b) => ({ uv: [u, v], uv_size: [Math.max(1, Math.min(a, rw)), Math.max(1, Math.min(b, rh))] });
        uv = { north: face(w, h), south: face(w, h), east: face(d, h), west: face(d, h), up: face(w, d), down: face(w, d) };
      }
      cubes.push({ origin: [cx0 - column * 16, cy0 - minY, z0], size: [w, h, d], uv });
    }
    return {
      description: {
        identifier: `geometry.censor.whiteboard.p${part}`,
        texture_width: 64,
        texture_height: 64,
        visible_bounds_width: 2,
        visible_bounds_height: 2.5,
        visible_bounds_offset: [0, 0.75, 0],
      },
      bones: [{ name: "board", pivot: [0, 0, 0], cubes }],
    };
  });
  return { format_version: "1.21.0", "minecraft:geometry": geometries };
}

// ---- Censor entity texture (64x64) ------------------------------------------------------------------
// Box-UV origins match models/entity/professor.geo.json.
function professor() {
  const img = new Image(64, 64);
  const skin = hex("#bd8b72");
  const skinDark = shade(skin, 0.82);
  const hair = hex("#3b2716"); // dark brown
  const robe = hex("#27304f");
  const trim = hex("#8c2f39");
  const shirt = hex("#e9e4d8");
  const trousers = hex("#3a3a44");
  const shoe = hex("#2a211c");

  // Head 8x10x8 at (0,0): bald front, grey hair on top, back and upper sides.
  paintBox(img, 0, 0, 8, 10, 8, { all: noisy(skin, 0.04, 2), top: noisy(hair, 0.05, 3), bottom: skinDark });
  img.rect(0, 8, 8, 3, noisy(hair, 0.05, 4)); // side
  img.rect(16, 8, 8, 3, noisy(hair, 0.05, 4)); // other side
  img.rect(24, 8, 8, 6, noisy(hair, 0.05, 6)); // back
  // Face on the front (x 8..15, y 8..17): brows, eyes, mouth line.
  img.rect(9, 12, 6, 1, hex("#5a4636"));
  img.rect(9, 13, 2, 1, hex("#ffffff"));
  img.rect(13, 13, 2, 1, hex("#ffffff"));
  img.set(10, 13, hex("#2e6b3a"));
  img.set(13, 13, hex("#2e6b3a"));
  img.rect(10, 16, 4, 1, skinDark);
  // Nose 2x4x2 at (24,0).
  paintBox(img, 24, 0, 2, 4, 2, { all: skinDark });

  // Body 8x12x6 at (16,20): shirt with a tie.
  paintBox(img, 16, 20, 8, 12, 6, { all: noisy(shirt, 0.03, 8) });
  img.rect(25, 26, 2, 8, trim); // tie on the front (front face starts at x 22)
  // Robe 8x18x6 at (0,38): dark academic gown with a coloured trim, open at the front.
  paintBox(img, 0, 38, 8, 18, 6, { all: noisy(robe, 0.05, 9) });
  img.rect(9, 44, 1, 18, trim);
  img.rect(10, 44, 1, 18, trim);
  img.rect(6, 59, 8, 3, shade(robe, 0.8));
  img.rect(0, 59, 6, 3, shade(robe, 0.8));
  img.rect(14, 59, 14, 3, shade(robe, 0.8));

  // Legs 4x12x4 at (0,22).
  paintBox(img, 0, 22, 4, 12, 4, { all: noisy(trousers, 0.05, 10), bottom: shoe });
  img.rect(0, 35, 16, 3, shoe);
  // Arms 3x12x4 at (44,22): gown sleeves, hands at the bottom.
  paintBox(img, 44, 22, 3, 12, 4, { all: noisy(robe, 0.05, 12), bottom: skin });
  img.rect(44, 35, 14, 3, noisy(skin, 0.04, 13));
  img.rect(44, 34, 14, 1, trim);

  // Pointer stick 1x12x1 at (60,0): wood with a white tip at the far (bottom) end.
  paintBox(img, 60, 0, 1, 12, 1, { all: hex("#8b5a2b") });
  img.rect(60, 11, 4, 2, hex("#f2f2f2"));
  img.rect(61, 0, 2, 1, hex("#6b4423"));

  // Glasses (per-face UVs): 3x3 lens = dark rim with a see-through centre, plus one rim pixel.
  const rim = hex("#141414");
  img.rect(34, 0, 3, 3, rim);
  img.set(35, 1, [0, 0, 0, 0]);
  img.set(38, 0, rim);
  return img;
}

// ---- pack icon (64x64) ------------------------------------------------------------------------------
function icon() {
  const img = new Image(64, 64);
  img.rect(0, 0, 64, 64, noisy(hex("#3b6ea5"), 0.04, 2));
  img.rect(8, 10, 48, 36, hex("#aeb4bd"));
  img.rect(11, 13, 42, 30, hex("#f5f6f2"));
  img.rect(16, 18, 18, 2, hex("#2c5fb8"));
  img.rect(16, 23, 12, 2, hex("#2c5fb8"));
  img.rect(20, 30, 22, 2, hex("#c23b3b"));
  img.rect(6, 46, 52, 5, hex("#8d939d"));
  img.rect(40, 37, 9, 9, hex("#d2281f"));
  img.rect(41, 38, 2, 2, hex("#ff8a7a"));
  img.rect(44, 34, 2, 3, hex("#6b4423"));
  img.rect(46, 34, 5, 2, hex("#3fa535"));
  return img;
}

// The whiteboard geometry is derived from the description above and is always regenerated.
const geoFile = path.join(RP, "models/blocks/whiteboard.geo.json");
mkdirSync(path.dirname(geoFile), { recursive: true });
writeFileSync(geoFile, JSON.stringify(whiteboardGeometry(), null, 2) + "\n");
console.log("Generated models/blocks/whiteboard.geo.json (6 parts).");

if (process.env.CENSOR_KEEP_TEXTURES) {
  console.log("CENSOR_KEEP_TEXTURES is set: keeping existing textures.");
} else {
  console.log("Generating placeholder textures:");
  write(path.join(RP, "textures/blocks/censor_whiteboard.png"), whiteboardTexture());
  write(path.join(RP, "textures/entity/censor_professor.png"), professor());
  write(path.join(RP, "pack_icon.png"), icon());
  write(path.join(BP, "pack_icon.png"), icon());
}
