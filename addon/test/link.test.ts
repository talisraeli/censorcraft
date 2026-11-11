import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The add-on's link layer, exercised against a minimal stand-in for
 * @minecraft/server (the real module only exists inside the game).
 */
const mc = vi.hoisted(() => {
  class Player {
    isValid = true;
    commands: string[] = [];
    constructor(readonly id: string) {}
    runCommand(command: string) {
      this.commands.push(command);
      return { successCount: 1 };
    }
  }
  const state = {
    Player,
    handlers: [] as ((event: { id: string; message: string; sourceEntity?: unknown }) => void)[],
    intervals: [] as (() => void)[],
    entities: new Map<string, unknown>(),
    properties: new Map<string, unknown>(),
  };
  return state;
});

vi.mock("@minecraft/server", () => ({
  Player: mc.Player,
  system: {
    afterEvents: { scriptEventReceive: { subscribe: (cb: (typeof mc.handlers)[number]) => void mc.handlers.push(cb) } },
    runInterval: (fn: () => void) => mc.intervals.push(fn),
  },
  world: {
    getEntity: (id: string) => mc.entities.get(id),
    getDynamicProperty: (key: string) => mc.properties.get(key),
    setDynamicProperty: (key: string, value: unknown) => void mc.properties.set(key, value),
  },
}));

import {
  DownlinkMsg,
  EVENT_ACK,
  EVENT_MESSAGE,
  EVENT_PING,
  formatAck,
  formatFrame,
  formatPing,
  Frame,
  parseUplink,
  Reassembler,
  toFrames,
  UplinkMsg,
} from "@censorcraft/shared";
import { link, LinkError } from "../src/link";

const player = new mc.Player("bridge-1");
mc.entities.set(player.id, player);
link.init();

const fire = (id: string, message: string, sourceEntity?: unknown) => mc.handlers.forEach((h) => h({ id, message, sourceEntity }));
const tick = () => mc.intervals.forEach((fn) => fn());
const ping = (session: string) => fire(EVENT_PING, formatPing(session), player);
const reassembler = new Reassembler<UplinkMsg>();

/** Play the companion: read new uplink commands, optionally ack them, return decoded messages. */
function drain(options: { ack?: boolean; only?: string } = {}): { messages: UplinkMsg[]; carriers: string[] } {
  const messages: UplinkMsg[] = [];
  const carriers: string[] = [];
  for (const command of player.commands.splice(0)) {
    const frame = parseUplink(command) as Frame;
    expect(frame).toBeDefined();
    const carrier = command.slice(0, command.indexOf("CZ1|")).trim();
    carriers.push(carrier);
    if (options.only && carrier !== options.only) continue;
    if (options.ack === false) continue; // the companion never saw this frame
    fire(EVENT_ACK, formatAck(frame));
    const result = reassembler.accept(frame, Date.now());
    if (result.status === "complete") messages.push(result.message);
  }
  return { messages, carriers };
}

function reply(message: DownlinkMsg, chunk = 40): void {
  for (const frame of toFrames(message, chunk)) fire(EVENT_MESSAGE, formatFrame(frame));
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
  player.commands.length = 0;
});

describe("add-on link layer", () => {
  it("is disconnected until the companion pings, then says hello by whispering to itself", () => {
    expect(link.connected).toBe(false);
    ping("s1");
    expect(link.connected).toBe(true);
    const { messages, carriers } = drain();
    expect(carriers).toEqual(["tell @s"]);
    expect(messages).toEqual([{ t: "hello", v: 1, s: "s1" }]);
    // Further pings of the same session do not repeat the hello (no chat noise).
    ping("s1");
    ping("s1");
    expect(player.commands).toEqual([]);
  });

  it("ignores pings that do not come from a player", () => {
    ping("s1");
    drain();
    fire(EVENT_PING, formatPing("zz"), undefined);
    expect(player.commands).toEqual([]);
  });

  it("sends a request, reassembles the chunked Unicode reply and resolves", async () => {
    ping("s1");
    drain();
    const pending = link.request({ t: "q.req", pid: "p1", pname: "Alex", topic: "Calculus 1", diff: "easy" });
    const { messages } = drain();
    expect(messages).toHaveLength(1);
    const request = messages[0] as Extract<UplinkMsg, { t: "q.req" }>;
    expect(request).toMatchObject({ t: "q.req", pid: "p1", topic: "Calculus 1", diff: "easy" });
    const question = { qid: "q1", fmt: "short" as const, text: "Evaluate ∫₀¹ x² dx. Is √(x²+1) ≤ λ?", hash: "abc", diff: "easy" as const, src: "syllabus" as const };
    reply({ t: "q", r: request.r, q: question });
    await expect(pending).resolves.toEqual({ t: "q", r: request.r, q: question });
  });

  it("falls back to /say when whispers are not acknowledged, and remembers the working mode", async () => {
    ping("s1");
    drain();
    const pending = link.request({ t: "q.ans", pid: "p1", qid: "q1", ans: "1/3" });
    expect(drain({ ack: false }).carriers).toEqual(["tell @s"]);
    vi.advanceTimersByTime(2100);
    tick();
    const retry = drain({ only: "say" });
    expect(retry.carriers).toEqual(["say"]);
    const request = retry.messages[0] as Extract<UplinkMsg, { t: "q.ans" }>;
    reply({ t: "v", r: request.r, qid: "q1", ok: true, score: 1, expl: "Yes.", hash: "abc" });
    await expect(pending).resolves.toMatchObject({ t: "v", ok: true });
    expect(mc.properties.get("censor:uplink_mode")).toBe(1);
    // The next message goes out with the mode that worked.
    link.notify({ t: "cancel", pid: "p1" });
    expect(drain().carriers).toEqual(["say"]);
  });

  it("fails pending requests as soon as the companion stops pinging", async () => {
    ping("s2");
    drain();
    const pending = link.request({ t: "q.req", pid: "p1", pname: "Alex", topic: "C", diff: "hard" });
    drain();
    tick();
    vi.advanceTimersByTime(14_000);
    expect(link.connected).toBe(false);
    tick();
    await expect(pending).rejects.toMatchObject({ failure: "disconnected" });
    await expect(link.request({ t: "q.req", pid: "p1", pname: "Alex", topic: "C", diff: "hard" })).rejects.toBeInstanceOf(LinkError);
  });

  it("times out a request that never gets a reply while the link stays up", async () => {
    ping("s3");
    drain();
    const pending = link.request({ t: "q.req", pid: "p1", pname: "Alex", topic: "C", diff: "hard" }, 5000);
    drain();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(1000);
      ping("s3");
      tick();
    }
    await expect(pending).rejects.toMatchObject({ failure: "timeout" });
  });

  it("reports an undelivered request when no uplink command is ever acknowledged", async () => {
    ping("s4");
    drain();
    const pending = link.request({ t: "q.req", pid: "p1", pname: "Alex", topic: "C", diff: "hard" });
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2100);
      ping("s4");
      tick();
    }
    await expect(pending).rejects.toMatchObject({ failure: "undelivered" });
    // Both carrier commands were tried.
    expect(new Set(drain({ ack: false }).carriers)).toEqual(new Set(["tell @s", "say"]));
  });
});
