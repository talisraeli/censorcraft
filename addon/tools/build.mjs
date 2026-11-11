// Builds the CensorCraft add-on:
//   1. bundles src/main.ts (+ shared protocol, glyphs.json, rewards.json) into one script
//   2. copies the pack folders to addon/dist/CensorCraft_BP and addon/dist/CensorCraft_RP
//   3. zips them into .mcpack files and a combined .mcaddon
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const bpOut = path.join(dist, "CensorCraft_BP");
const rpOut = path.join(dist, "CensorCraft_RP");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(path.join(root, "packs/BP"), bpOut, { recursive: true });
cpSync(path.join(root, "packs/RP"), rpOut, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(bpOut, "scripts/main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  // Provided by the game at runtime.
  external: ["@minecraft/server", "@minecraft/server-ui"],
  // The script runtime reads UTF-8; keep ∫ √ ² ... as real characters rather than \u escapes.
  charset: "utf8",
  legalComments: "none",
  logLevel: "info",
});

// Sanity checks that catch the classic "pack does not load" mistakes at build time.
const manifest = (dir) => JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const bp = manifest(bpOut);
const rp = manifest(rpOut);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
for (const name of ["@minecraft/server", "@minecraft/server-ui"]) {
  const dep = bp.dependencies.find((d) => d.module_name === name);
  if (!dep || dep.version !== pkg.dependencies[name]) {
    throw new Error(`BP manifest depends on ${name} ${dep?.version}, but package.json pins ${pkg.dependencies[name]}. Keep them equal.`);
  }
}
if (!bp.dependencies.some((d) => d.uuid === rp.header.uuid) || !rp.dependencies.some((d) => d.uuid === bp.header.uuid)) {
  throw new Error("The BP and RP manifests must depend on each other's header uuid.");
}
for (const dir of [bpOut, rpOut]) {
  const walk = (d) =>
    readdirSync(d).flatMap((f) => (statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)]));
  for (const file of walk(dir).filter((f) => f.endsWith(".json"))) {
    try {
      JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Invalid JSON in ${path.relative(root, file)}: ${e.message}`);
    }
  }
}

function collect(dir, prefix = "") {
  const out = {};
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, collect(full, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = new Uint8Array(readFileSync(full));
  }
  return out;
}

const bpFiles = collect(bpOut);
const rpFiles = collect(rpOut);
writeFileSync(path.join(dist, "CensorCraft_BP.mcpack"), zipSync(bpFiles, { level: 9 }));
writeFileSync(path.join(dist, "CensorCraft_RP.mcpack"), zipSync(rpFiles, { level: 9 }));
const addon = {};
for (const [name, data] of Object.entries(bpFiles)) addon[`CensorCraft_BP/${name}`] = data;
for (const [name, data] of Object.entries(rpFiles)) addon[`CensorCraft_RP/${name}`] = data;
writeFileSync(path.join(dist, "CensorCraft.mcaddon"), zipSync(addon, { level: 9 }));

console.log(`\nBuilt add-on v${bp.header.version.join(".")} (needs Minecraft ${bp.header.min_engine_version.join(".")}+):`);
for (const f of ["CensorCraft.mcaddon", "CensorCraft_BP.mcpack", "CensorCraft_RP.mcpack"]) {
  console.log(`  addon/dist/${f}  (${Math.round(statSync(path.join(dist, f)).size / 1024)} KB)`);
}
