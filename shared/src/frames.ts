import { decodePayload, encodePayload } from "./codec";

/** Bumped whenever the wire format changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Marker that precedes every add-on -> companion chat frame. */
export const UPLINK_PREFIX = "CZ1|";

/** /scriptevent ids used companion -> add-on. */
export const EVENT_NAMESPACE = "censor";
export const EVENT_MESSAGE = "censor:m";
export const EVENT_ACK = "censor:a";
export const EVENT_PING = "censor:p";
export const EVENT_GLYPHTEST = "censor:glyphtest";

/**
 * Chunk sizes (characters of base64url text per frame).
 *  - Uplink travels inside a chat/whisper command. Chat is capped at 512
 *    characters by the client, so we stay far below it.
 *  - Downlink travels as the /scriptevent message, capped at 2048 characters.
 */
export const UPLINK_CHUNK = 360;
export const DOWNLINK_CHUNK = 1500;

/** The companion pings this often; the add-on treats the link as down after PING_TIMEOUT_MS of silence. */
export const PING_INTERVAL_MS = 4000;
export const PING_TIMEOUT_MS = 13000;

export interface Frame {
  /** Message id, unique per sender (base36). */
  mid: string;
  /** 0-based chunk index. */
  seq: number;
  /** Total number of chunks of this message. */
  total: number;
  /** base64url slice. */
  chunk: string;
}

const ID_RE = /^[0-9a-z]{1,12}$/;

let idCounter = 0;
/** Short unique-enough message / request id (ASCII, base36). */
export function newId(): string {
  idCounter = (idCounter + 1) % 1296;
  const rand = Math.floor(Math.random() * 0x7fffffff).toString(36);
  return (rand + idCounter.toString(36).padStart(2, "0")).slice(-8);
}

/** Serialize a JSON message and split it into frames of at most `maxChunk` characters. */
export function toFrames(message: unknown, maxChunk: number, mid: string = newId()): Frame[] {
  const text = encodePayload(message);
  const total = Math.max(1, Math.ceil(text.length / maxChunk));
  const frames: Frame[] = [];
  for (let seq = 0; seq < total; seq++) {
    frames.push({ mid, seq, total, chunk: text.slice(seq * maxChunk, (seq + 1) * maxChunk) });
  }
  return frames;
}

/** `mid|seq|total|chunk` */
export function formatFrame(frame: Frame): string {
  return `${frame.mid}|${frame.seq}|${frame.total}|${frame.chunk}`;
}

export function parseFrame(text: string): Frame | undefined {
  const parts = text.trim().split("|");
  if (parts.length !== 4) return undefined;
  const [mid, seqText, totalText, chunk] = parts as [string, string, string, string];
  if (!ID_RE.test(mid) || !/^\d{1,4}$/.test(seqText) || !/^\d{1,4}$/.test(totalText)) return undefined;
  const seq = Number(seqText);
  const total = Number(totalText);
  if (total < 1 || total > 512 || seq >= total) return undefined;
  if (!/^[A-Za-z0-9_-]*$/.test(chunk)) return undefined;
  return { mid, seq, total, chunk };
}

/** Chat text for an uplink frame. */
export function formatUplink(frame: Frame): string {
  return UPLINK_PREFIX + formatFrame(frame);
}

/**
 * Find an uplink frame inside a chat message. The prefix may be preceded by
 * decoration added by the game (e.g. "[Steve] " for /say).
 */
export function parseUplink(chatMessage: string): Frame | undefined {
  const at = chatMessage.indexOf(UPLINK_PREFIX);
  if (at < 0) return undefined;
  const rest = chatMessage.slice(at + UPLINK_PREFIX.length).split(/\s/)[0] ?? "";
  return parseFrame(rest);
}

/** `mid|seq` acknowledgement body. */
export function formatAck(frame: Pick<Frame, "mid" | "seq">): string {
  return `${frame.mid}|${frame.seq}`;
}

export function parseAck(text: string): { mid: string; seq: number } | undefined {
  const m = /^([0-9a-z]{1,12})\|(\d{1,4})$/.exec(text.trim());
  return m ? { mid: m[1] as string, seq: Number(m[2]) } : undefined;
}

/** `session|protocolVersion` ping body. */
export function formatPing(session: string): string {
  return `${session}|${PROTOCOL_VERSION}`;
}

export function parsePing(text: string): { session: string; version: number } | undefined {
  const m = /^([0-9a-z]{1,12})\|(\d{1,4})$/.exec(text.trim());
  return m ? { session: m[1] as string, version: Number(m[2]) } : undefined;
}

export interface ReassemblerOptions {
  /** Drop partial messages older than this (ms). */
  partialTtlMs?: number;
  /** How long a completed message id is remembered for duplicate suppression (ms). */
  doneTtlMs?: number;
}

export type AcceptResult<T> =
  | { status: "partial" }
  | { status: "duplicate" }
  | { status: "invalid"; error: string }
  | { status: "complete"; message: T };

/**
 * Collects frames into messages. Tolerates duplicates (retransmits, or chat
 * events that are delivered twice) and out-of-order delivery.
 */
export class Reassembler<T = unknown> {
  private readonly partial = new Map<string, { parts: (string | undefined)[]; got: number; at: number }>();
  private readonly done = new Map<string, number>();
  private readonly partialTtlMs: number;
  private readonly doneTtlMs: number;

  constructor(options: ReassemblerOptions = {}) {
    this.partialTtlMs = options.partialTtlMs ?? 30_000;
    this.doneTtlMs = options.doneTtlMs ?? 120_000;
  }

  accept(frame: Frame, now: number): AcceptResult<T> {
    this.sweep(now);
    if (this.done.has(frame.mid)) return { status: "duplicate" };
    let entry = this.partial.get(frame.mid);
    if (!entry) {
      entry = { parts: new Array<string | undefined>(frame.total).fill(undefined), got: 0, at: now };
      this.partial.set(frame.mid, entry);
    }
    if (entry.parts.length !== frame.total) return { status: "invalid", error: "frame count mismatch" };
    if (entry.parts[frame.seq] !== undefined) return { status: "duplicate" };
    entry.parts[frame.seq] = frame.chunk;
    entry.got++;
    entry.at = now;
    if (entry.got < frame.total) return { status: "partial" };
    this.partial.delete(frame.mid);
    this.done.set(frame.mid, now);
    try {
      return { status: "complete", message: decodePayload<T>(entry.parts.join("")) };
    } catch (e) {
      return { status: "invalid", error: `payload decode failed: ${String(e)}` };
    }
  }

  private sweep(now: number): void {
    for (const [mid, entry] of this.partial) if (now - entry.at > this.partialTtlMs) this.partial.delete(mid);
    for (const [mid, at] of this.done) if (now - at > this.doneTtlMs) this.done.delete(mid);
  }
}
