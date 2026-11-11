import { Block, BlockPermutation, Dimension, Entity, ItemStack, system, Vector3, world } from "@minecraft/server";
import { S } from "./strings";

/**
 * Whiteboards and their professors.
 *
 * Approach A: Censor is a custom entity (censor:professor). "Claiming" swaps
 * the nearest jobless vanilla villager for a Censor; removing the whiteboard
 * swaps him back for a plain jobless villager. The whiteboard <-> Censor link
 * is persisted in dynamic properties on both sides:
 *   world  "censor:boards.N" : JSON list of { d, x, y, z, f, e } (main block, facing -> entity id)
 *   entity "censor:board"    : "<dimension>|x|y|z"              (entity -> board)
 */

export const BOARD_ID = "censor:whiteboard";
export const CENSOR_ID = "censor:professor";
const VILLAGER_ID = "minecraft:villager_v2";

const BOARDS_PROPERTY = "censor:boards";
const ENTITY_BOARD_PROPERTY = "censor:board";
const ENTITY_NAME_PROPERTY = "censor:original_name";

/** A jobless villager within this many blocks of a whiteboard (its bottom-centre block) takes the job. */
const CLAIM_RADIUS = 16;
/** Censor idles within TETHER_RADIUS; beyond it he walks back. */
const TETHER_RADIUS = 6;
/** Considered "back at the board" when this close. */
const ARRIVE_RADIUS = 3.5;
/** Last-resort teleport when walking back did not work for this long (ms). */
const COMMUTE_TIMEOUT_MS = 25_000;
/** Beyond this distance (or in another dimension) walking is pointless. */
const TELEPORT_RADIUS = 40;
const DIMENSIONS = ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"];

interface BoardRecord {
  d: string;
  x: number;
  y: number;
  z: number;
  /** Direction the board faces (needed to find its parts when the main block is already gone). */
  f?: "north" | "south" | "east" | "west";
  /** Entity id of the Censor that claimed this board. */
  e?: string;
}

interface Runtime {
  mode: "commute" | "idle" | "unknown";
  since: number;
  farChecks: number;
  missing: number;
}

const boards = new Map<string, BoardRecord>();
const runtime = new Map<string, Runtime>();
let dirty = false;
let loaded = false;

const keyOf = (d: string, x: number, y: number, z: number) => `${d}|${x}|${y}|${z}`;
const keyOfRecord = (r: BoardRecord) => keyOf(r.d, r.x, r.y, r.z);
const center = (r: BoardRecord): Vector3 => ({ x: r.x + 0.5, y: r.y, z: r.z + 0.5 });

function horizontalDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ---- persistence -----------------------------------------------------------

/** World dynamic properties hold at most 32767 characters each, so the list is split. */
const SAVE_CHUNK = 30_000;

function save(): void {
  dirty = false;
  const json = JSON.stringify([...boards.values()]);
  const parts = Math.max(1, Math.ceil(json.length / SAVE_CHUNK));
  for (let i = 0; i < parts; i++) world.setDynamicProperty(`${BOARDS_PROPERTY}.${i}`, json.slice(i * SAVE_CHUNK, (i + 1) * SAVE_CHUNK));
  for (let i = parts; world.getDynamicProperty(`${BOARDS_PROPERTY}.${i}`) !== undefined; i++) {
    world.setDynamicProperty(`${BOARDS_PROPERTY}.${i}`, undefined);
  }
}

function load(): void {
  let json = "";
  for (let i = 0; ; i++) {
    const part = world.getDynamicProperty(`${BOARDS_PROPERTY}.${i}`);
    if (typeof part !== "string") break;
    json += part;
  }
  boards.clear();
  if (json) {
    try {
      for (const r of JSON.parse(json) as BoardRecord[]) {
        if (typeof r?.d === "string" && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)) {
          boards.set(keyOfRecord(r), { d: r.d, x: r.x, y: r.y, z: r.z, ...(facingValue(r.f) ? { f: facingValue(r.f) } : {}), ...(typeof r.e === "string" ? { e: r.e } : {}) });
        }
      }
    } catch (e) {
      console.warn(`[CensorCraft] stored whiteboard list is corrupt and was reset: ${String(e)}`);
    }
  }
  loaded = true;
}

function facingValue(value: unknown): BoardRecord["f"] {
  return value === "north" || value === "south" || value === "east" || value === "west" ? value : undefined;
}

// ---- helpers ------------------------------------------------------------------

function dimensionOf(record: BoardRecord): Dimension | undefined {
  try {
    return world.getDimension(record.d);
  } catch {
    return undefined;
  }
}

/** The block at a record's location, or undefined when its chunk is not loaded. */
function blockOf(record: BoardRecord): Block | undefined {
  try {
    return dimensionOf(record)?.getBlock(record);
  } catch {
    return undefined; // LocationInUnloadedChunkError / out of bounds
  }
}

function entityOf(record: BoardRecord): Entity | undefined {
  if (!record.e) return undefined;
  try {
    const entity = world.getEntity(record.e);
    return entity?.isValid ? entity : undefined;
  } catch {
    return undefined;
  }
}

function isJoblessVillager(entity: Entity): boolean {
  try {
    if (!entity.isValid || entity.typeId !== VILLAGER_ID) return false;
    // In villager_v2 the profession is the variant: 0 = unskilled (jobless). Nitwits are 14.
    if (entity.getComponent("minecraft:variant")?.value !== 0) return false;
    if (entity.getComponent("minecraft:is_baby")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Unit vector pointing out of the front of the board. */
function frontOf(block: Block): Vector3 {
  let facing: unknown;
  try {
    facing = (block.permutation.getAllStates() as Record<string, unknown>)["minecraft:cardinal_direction"];
  } catch {
    facing = undefined;
  }
  switch (facing) {
    case "south":
      return { x: 0, y: 0, z: 1 };
    case "east":
      return { x: 1, y: 0, z: 0 };
    case "west":
      return { x: -1, y: 0, z: 0 };
    default:
      return { x: 0, y: 0, z: -1 };
  }
}

/** A free spot to stand, preferably two blocks in front of the board. */
function standSpot(record: BoardRecord): Vector3 {
  const block = blockOf(record);
  const dim = dimensionOf(record);
  const f = block ? frontOf(block) : { x: 0, y: 0, z: 1 };
  const side = { x: -f.z, y: 0, z: f.x };
  const candidates: Vector3[] = [];
  for (const forward of [2, 1, 3]) {
    for (const lateral of [0, 1, -1]) {
      for (const dy of [0, 1, -1]) {
        candidates.push({ x: record.x + f.x * forward + side.x * lateral, y: record.y + dy, z: record.z + f.z * forward + side.z * lateral });
      }
    }
  }
  for (const c of candidates) {
    try {
      const feet = dim?.getBlock(c);
      const head = dim?.getBlock({ x: c.x, y: c.y + 1, z: c.z });
      const floor = dim?.getBlock({ x: c.x, y: c.y - 1, z: c.z });
      if (feet?.isAir && head?.isAir && floor && !floor.isAir && !floor.isLiquid) return { x: c.x + 0.5, y: c.y, z: c.z + 0.5 };
    } catch {
      /* unloaded */
    }
  }
  return { x: record.x + 0.5 + f.x, y: record.y, z: record.z + 0.5 + f.z };
}

function playersNear(record: BoardRecord, radius: number): boolean {
  try {
    return (dimensionOf(record)?.getPlayers({ location: center(record), maxDistance: radius }).length ?? 0) > 0;
  } catch {
    return false;
  }
}

function puff(dimension: Dimension, location: Vector3, particle: string): void {
  try {
    dimension.spawnParticle(particle, { x: location.x, y: location.y + 1.2, z: location.z });
  } catch {
    /* cosmetic */
  }
}

function sayNearby(dimension: Dimension, location: Vector3, text: string): void {
  try {
    for (const player of dimension.getPlayers({ location, maxDistance: 16 })) player.sendMessage(S.say(text));
  } catch {
    /* cosmetic */
  }
}

// ---- claiming and reverting -----------------------------------------------------

/** Turn a jobless villager into this board's Censor. */
function claim(record: BoardRecord, villager: Entity): void {
  const dimension = villager.dimension;
  const location = villager.location;
  const yaw = villager.getRotation().y;
  const originalName = villager.nameTag;
  const censor = dimension.spawnEntity(CENSOR_ID, location, { initialRotation: yaw, initialPersistence: true });
  villager.remove();
  censor.nameTag = S.name;
  censor.setDynamicProperty(ENTITY_BOARD_PROPERTY, keyOfRecord(record));
  if (originalName) censor.setDynamicProperty(ENTITY_NAME_PROPERTY, originalName);
  record.e = censor.id;
  dirty = true;
  // He spawns where the villager stood and walks to his board (see the tether loop).
  runtime.set(censor.id, { mode: "commute", since: Date.now(), farChecks: 0, missing: 0 });
  puff(dimension, location, "minecraft:villager_happy");
  sayNearby(dimension, location, S.claimed);
}

/** Turn a Censor back into a normal jobless villager: no name, glasses, stick, tether or special behaviour. */
export function revert(censor: Entity, announce = true): void {
  if (!censor.isValid) return;
  const dimension = censor.dimension;
  const location = censor.location;
  const yaw = censor.getRotation().y;
  const originalName = censor.getDynamicProperty(ENTITY_NAME_PROPERTY);
  runtime.delete(censor.id);
  censor.remove();
  let villager: Entity;
  try {
    villager = dimension.spawnEntity(VILLAGER_ID, location, { initialRotation: yaw });
  } catch (e) {
    console.warn(`[CensorCraft] could not respawn the villager: ${String(e)}`);
    return;
  }
  if (typeof originalName === "string" && originalName) villager.nameTag = originalName;
  // The default spawn event may roll a baby or a nitwit; make him an adult without a profession.
  system.runTimeout(() => {
    try {
      if (!villager.isValid) return;
      if (villager.getComponent("minecraft:is_baby")) villager.triggerEvent("minecraft:ageable_grow_up");
      if (villager.getComponent("minecraft:variant")?.value !== 0) villager.triggerEvent("minecraft:become_unskilled");
    } catch {
      /* vanilla event names changed: he is still a normal villager */
    }
  }, 2);
  puff(dimension, location, "minecraft:villager_angry");
  if (announce) sayNearby(dimension, location, S.boardGone);
}

function tryClaim(record: BoardRecord): void {
  const dimension = dimensionOf(record);
  if (!dimension) return;
  let villagers: Entity[];
  try {
    villagers = dimension.getEntities({ type: VILLAGER_ID, location: center(record), maxDistance: CLAIM_RADIUS, closest: 12 });
  } catch {
    return;
  }
  const villager = villagers.find(isJoblessVillager);
  if (!villager) return;
  try {
    claim(record, villager);
  } catch (e) {
    console.warn(`[CensorCraft] claiming a villager failed: ${String(e)}`);
  }
}

// ---- the 3 x 2 multi-block structure -------------------------------------------------

/**
 * A whiteboard is 3 blocks wide and 2 high: six `censor:whiteboard` blocks that
 * differ in their `censor:part` state. Part 0 (bottom centre) is the block the
 * player places and the one the registry is keyed by.
 * [column, row] per part; column +1 is the model's +x. Keep in sync with tools/gen-textures.mjs.
 */
const PARTS: readonly (readonly [number, number])[] = [[0, 0], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
const PART_STATE = "censor:part";
const FACING_STATE = "minecraft:cardinal_direction";
type Facing = "north" | "south" | "east" | "west";

function statesOf(permutation: BlockPermutation): Record<string, unknown> {
  try {
    return permutation.getAllStates() as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function partOf(permutation: BlockPermutation): number {
  const part = statesOf(permutation)[PART_STATE];
  return typeof part === "number" && part >= 0 && part < PARTS.length ? part : 0;
}

export function facingOf(permutation: BlockPermutation): Facing | undefined {
  const facing = statesOf(permutation)[FACING_STATE];
  return facing === "north" || facing === "south" || facing === "east" || facing === "west" ? facing : undefined;
}

function frontVector(facing: Facing): Vector3 {
  switch (facing) {
    case "south":
      return { x: 0, y: 0, z: 1 };
    case "east":
      return { x: 1, y: 0, z: 0 };
    case "west":
      return { x: -1, y: 0, z: 0 };
    default:
      return { x: 0, y: 0, z: -1 };
  }
}

/** World locations of all six parts, indexed by part number. */
function partLocations(main: Vector3, facing: Facing): Vector3[] {
  const f = frontVector(facing);
  // World direction of the model's +x axis for this rotation.
  const side = { x: -f.z, z: f.x };
  return PARTS.map(([column, row]) => ({ x: main.x + side.x * column, y: main.y + row, z: main.z + side.z * column }));
}

/** Location of part 0, given the location of any part. */
function mainLocation(location: Vector3, part: number, facing: Facing): Vector3 {
  const f = frontVector(facing);
  const side = { x: -f.z, z: f.x };
  const [column, row] = PARTS[part] as readonly [number, number];
  return { x: Math.floor(location.x) - side.x * column, y: Math.floor(location.y) - row, z: Math.floor(location.z) - side.z * column };
}

/** Is there room for the other five parts around a main block placed at `main`? */
export function hasRoomForBoard(dimension: Dimension, main: Vector3, facing: Facing): boolean {
  const spots = partLocations(main, facing);
  for (let part = 1; part < spots.length; part++) {
    try {
      const block = dimension.getBlock(spots[part] as Vector3);
      if (!block || !block.isAir) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Remove every part of a board (no drops: parts have an empty loot table). */
function clearParts(dimension: Dimension, main: Vector3, facing: Facing): void {
  for (const spot of partLocations(main, facing)) {
    try {
      const block = dimension.getBlock(spot);
      if (block?.typeId === BOARD_ID) block.setType("minecraft:air");
    } catch {
      /* unloaded: the validation pass cleans up later */
    }
  }
}

// ---- registration -------------------------------------------------------------------

/**
 * A main whiteboard block (part 0) now exists here: build the other five parts
 * around it and register the board. Idempotent.
 */
export function completeBoard(block: Block): void {
  if (!loaded || !block.isValid || block.typeId !== BOARD_ID) return;
  const permutation = block.permutation;
  if (partOf(permutation) !== 0) return;
  const facing = facingOf(permutation) ?? "north";
  const key = keyOf(block.dimension.id, block.location.x, block.location.y, block.location.z);
  if (boards.has(key)) return;

  const spots = partLocations(block.location, facing);
  for (let part = 1; part < spots.length; part++) {
    try {
      const target = block.dimension.getBlock(spots[part] as Vector3);
      if (!target) continue;
      if (target.typeId === BOARD_ID && partOf(target.permutation) === part) continue;
      if (!target.isAir) continue; // no room (e.g. /setblock into a wall): validation removes the incomplete board
      target.setPermutation(BlockPermutation.resolve(BOARD_ID, { [PART_STATE]: part, [FACING_STATE]: facing }));
    } catch (e) {
      console.warn(`[CensorCraft] could not place whiteboard part ${part}: ${String(e)}`);
    }
  }

  const record: BoardRecord = { d: block.dimension.id, x: block.location.x, y: block.location.y, z: block.location.z, f: facing };
  boards.set(key, record);
  dirty = true;
  tryClaim(record);
}

/**
 * A whiteboard block at `location` was removed (any part, by any means).
 * Removes the rest of the board, drops one whiteboard item, and turns its
 * Censor back into a villager. Idempotent: later calls for the same board do nothing.
 */
export function breakBoard(dimensionId: string, location: Vector3, permutation?: BlockPermutation, dropItem = true): void {
  if (!loaded) return;
  const part = permutation ? partOf(permutation) : 0;
  let facing = permutation ? facingOf(permutation) : undefined;
  const main = facing ? mainLocation(location, part, facing) : { x: Math.floor(location.x), y: Math.floor(location.y), z: Math.floor(location.z) };
  const key = keyOf(dimensionId, main.x, main.y, main.z);
  const record = boards.get(key);
  facing = facing ?? record?.f;

  let dimension: Dimension | undefined;
  try {
    dimension = world.getDimension(dimensionId);
  } catch {
    dimension = undefined;
  }
  if (!record) {
    // Not (or no longer) a registered board. If the main block is gone too, sweep up stray parts.
    try {
      if (dimension && facing && dimension.getBlock(main)?.typeId !== BOARD_ID) clearParts(dimension, main, facing);
    } catch {
      /* unloaded */
    }
    return;
  }
  boards.delete(key);
  dirty = true;
  if (dimension && facing) clearParts(dimension, main, facing);
  if (dimension && dropItem) {
    try {
      dimension.spawnItem(new ItemStack(BOARD_ID, 1), { x: main.x + 0.5, y: main.y + 0.5, z: main.z + 0.5 });
    } catch {
      /* unloaded */
    }
  }
  const censor = entityOf(record);
  // If he is not loaded right now, the orphan sweep reverts him as soon as he is.
  if (censor) revert(censor);
}

/** Every loaded part of a registered board is still in place. */
function isIntact(record: BoardRecord, main: Block): boolean {
  if (main.typeId !== BOARD_ID || partOf(main.permutation) !== 0) return false;
  const facing = facingOf(main.permutation) ?? record.f ?? "north";
  const spots = partLocations(record, facing);
  for (let part = 1; part < spots.length; part++) {
    let block: Block | undefined;
    try {
      block = main.dimension.getBlock(spots[part] as Vector3);
    } catch {
      continue; // unloaded: cannot tell yet
    }
    if (!block) continue;
    if (block.typeId !== BOARD_ID || partOf(block.permutation) !== part) return false;
  }
  return true;
}

// ---- periodic validation (safety net) ------------------------------------------------

/**
 * Checks every stored whiteboard whose chunk is loaded. Catches every removal
 * the events missed (/setblock, /fill, structure blocks, anything that happened
 * while the chunk was unloaded) and world reloads.
 */
function validate(): void {
  for (const record of [...boards.values()]) {
    const block = blockOf(record);
    if (!block) continue; // chunk not loaded: check again later
    if (!isIntact(record, block)) {
      breakBoard(record.d, record, block.typeId === BOARD_ID ? block.permutation : undefined);
      continue;
    }
    if (record.e) {
      const censor = entityOf(record);
      if (censor) {
        getRuntime(censor.id).missing = 0;
      } else if (playersNear(record, 24)) {
        // The area is loaded and simulated but he does not exist any more (e.g. /kill): free the board.
        const rt = getRuntime(record.e);
        if (++rt.missing >= 8) {
          runtime.delete(record.e);
          record.e = undefined;
          dirty = true;
        }
      }
    }
    if (!record.e) tryClaim(record);
  }

  // Orphans: a Censor whose board no longer exists (or that was summoned by hand) becomes a villager again.
  for (const id of DIMENSIONS) {
    let professors: Entity[];
    try {
      professors = world.getDimension(id).getEntities({ type: CENSOR_ID });
    } catch {
      continue;
    }
    for (const censor of professors) {
      const key = censor.getDynamicProperty(ENTITY_BOARD_PROPERTY);
      const record = typeof key === "string" ? boards.get(key) : undefined;
      if (record && record.e === censor.id) continue;
      if (record && !record.e) {
        record.e = censor.id; // the board lost track of him; re-link
        dirty = true;
        continue;
      }
      revert(censor, false);
    }
  }
  if (dirty) save();
}

// ---- tether: stay near the whiteboard ----------------------------------------------

function getRuntime(id: string): Runtime {
  let rt = runtime.get(id);
  if (!rt) {
    rt = { mode: "unknown", since: Date.now(), farChecks: 0, missing: 0 };
    runtime.set(id, rt);
  }
  return rt;
}

function setMode(censor: Entity, rt: Runtime, mode: "commute" | "idle"): void {
  rt.mode = mode;
  rt.since = Date.now();
  rt.farChecks = 0;
  try {
    censor.triggerEvent(mode === "commute" ? "censor:start_commute" : "censor:arrive");
  } catch {
    /* entity definition mismatch; the teleport fallback still keeps him in range */
  }
}

function teleportToBoard(censor: Entity, record: BoardRecord): void {
  const dimension = dimensionOf(record);
  if (!dimension) return;
  try {
    censor.teleport(standSpot(record), { dimension, facingLocation: { x: record.x + 0.5, y: record.y + 1.2, z: record.z + 0.5 } });
  } catch {
    /* target chunk unloaded: try again on a later tick */
  }
}

function tether(): void {
  const now = Date.now();
  for (const record of boards.values()) {
    const censor = entityOf(record);
    if (!censor) continue;
    const rt = getRuntime(censor.id);
    const target = center(record);
    const sameDimension = censor.dimension.id === record.d;
    const distance = sameDimension ? horizontalDistance(censor.location, target) : Infinity;
    const vertical = sameDimension ? Math.abs(censor.location.y - record.y) : Infinity;

    if (!sameDimension || distance > TELEPORT_RADIUS || vertical > 12) {
      teleportToBoard(censor, record);
      setMode(censor, rt, "idle");
      continue;
    }

    if (rt.mode === "unknown") {
      // After a world reload: derive the state from where he is.
      setMode(censor, rt, distance <= TETHER_RADIUS ? "idle" : "commute");
      continue;
    }

    if (rt.mode === "commute") {
      if (distance <= ARRIVE_RADIUS) {
        setMode(censor, rt, "idle");
      } else if (now - rt.since > COMMUTE_TIMEOUT_MS) {
        // Walking back did not work (no path, fenced in, ...): last resort.
        teleportToBoard(censor, record);
        setMode(censor, rt, "idle");
      }
      continue;
    }

    // Idle.
    if (distance > TETHER_RADIUS) {
      if (++rt.farChecks >= 2) setMode(censor, rt, "commute");
      continue;
    }
    rt.farChecks = 0;
    // Face the whiteboard while standing still with nobody to talk to. (Near a player the
    // look_at_player behaviour turns him toward them instead.)
    try {
      const v = censor.getVelocity();
      const still = Math.abs(v.x) + Math.abs(v.z) < 0.01;
      const audience = censor.dimension.getPlayers({ location: censor.location, maxDistance: 6 }).length > 0;
      if (still && !audience && distance > 0.8) {
        const dx = target.x - censor.location.x;
        const dz = target.z - censor.location.z;
        censor.setRotation({ x: 0, y: (Math.atan2(-dx, dz) * 180) / Math.PI });
      }
    } catch {
      /* cosmetic */
    }
  }
  for (const id of runtime.keys()) {
    if (runtime.size <= boards.size + 16) break;
    runtime.delete(id); // forget state of long-gone entities
  }
}

// ---- wiring --------------------------------------------------------------------------

/** Validate soon (used after pistons and explosions, whose effects land a few ticks later). */
export function validateSoon(delayTicks = 4): void {
  system.runTimeout(() => {
    if (loaded) validate();
  }, delayTicks);
}

/** Start after the world has loaded. */
export function startBoards(): void {
  load();
  validate();
  system.runInterval(validate, 40);
  system.runInterval(tether, 20);
}

/** The Censor entity's whiteboard, if it is a properly linked professor. */
export function isLinkedCensor(entity: Entity): boolean {
  const key = entity.getDynamicProperty(ENTITY_BOARD_PROPERTY);
  return typeof key === "string" && boards.get(key)?.e === entity.id;
}
