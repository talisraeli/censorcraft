import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  decodePayload,
  DOWNLINK_CHUNK,
  encodePayload,
  formatAck,
  formatFrame,
  formatPing,
  formatUplink,
  Frame,
  newId,
  parseAck,
  parseFrame,
  parsePing,
  parseUplink,
  Reassembler,
  ReliableSender,
  toFrames,
  UPLINK_CHUNK,
  utf8Decode,
  utf8Encode,
} from "../src/index";

const MATH = "∫₀¹ x² dx = 1/3, √(x²+1), A⁻¹, ∑ᵢ₌₁ⁿ i, λ ≤ π → ∞, θ ∈ ℝ, x ≠ y ≈ z";

describe("codec", () => {
  it("round-trips Unicode math through UTF-8", () => {
    expect(utf8Decode(utf8Encode(MATH))).toBe(MATH);
  });

  it("matches Node's UTF-8 and base64url implementations", () => {
    const text = `${MATH} 😀 \u0000 end`;
    expect(Buffer.from(utf8Encode(text)).equals(Buffer.from(text, "utf8"))).toBe(true);
    for (const sample of ["", "a", "ab", "abc", "abcd", text]) {
      const bytes = [...Buffer.from(sample, "utf8")];
      expect(base64UrlEncode(bytes)).toBe(Buffer.from(sample, "utf8").toString("base64url"));
      expect(base64UrlDecode(base64UrlEncode(bytes))).toEqual(bytes);
    }
  });

  it("handles astral characters and lone surrogates", () => {
    expect(utf8Decode(utf8Encode("𝑥 = 😀"))).toBe("𝑥 = 😀");
    expect(utf8Decode(utf8Encode("a\ud800b"))).toBe("a�b");
  });

  it("produces ASCII-only wire text", () => {
    const wire = encodePayload({ text: MATH });
    expect(wire).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePayload(wire)).toEqual({ text: MATH });
  });

  it("rejects damaged payloads", () => {
    expect(() => decodePayload("@@@")).toThrow();
    expect(() => decodePayload(encodePayload({ a: 1 }).slice(0, 5))).toThrow();
  });
});

describe("frames", () => {
  it("splits and reassembles a long Unicode message", () => {
    const message = { t: "q", text: MATH.repeat(40), opts: ["α", "β", "γ", "δ"] };
    const frames = toFrames(message, UPLINK_CHUNK);
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.chunk.length).toBeLessThanOrEqual(UPLINK_CHUNK);
    const re = new Reassembler();
    let out: unknown;
    for (const f of frames) {
      const parsed = parseFrame(formatFrame(f)) as Frame;
      const r = re.accept(parsed, 0);
      if (r.status === "complete") out = r.message;
    }
    expect(out).toEqual(message);
  });

  it("keeps every command under the chat and scriptevent limits", () => {
    const big = { text: "∑".repeat(5000) };
    for (const f of toFrames(big, UPLINK_CHUNK)) expect(`tell @s ${formatUplink(f)}`.length).toBeLessThan(512);
    for (const f of toFrames(big, DOWNLINK_CHUNK)) expect(formatFrame(f).length).toBeLessThan(2048);
  });

  it("tolerates out-of-order and duplicate frames", () => {
    const message = { n: "x".repeat(2000) };
    const frames = toFrames(message, 300);
    const re = new Reassembler();
    const shuffled = [...frames].reverse();
    expect(re.accept(shuffled[0] as Frame, 0).status).toBe("partial");
    expect(re.accept(shuffled[0] as Frame, 0).status).toBe("duplicate");
    let done: unknown;
    for (const f of shuffled.slice(1)) {
      const r = re.accept(f, 0);
      if (r.status === "complete") done = r.message;
    }
    expect(done).toEqual(message);
    // A retransmit of an already completed message is not delivered twice.
    expect(re.accept(frames[0] as Frame, 1).status).toBe("duplicate");
  });

  it("expires partial messages", () => {
    const frames = toFrames({ n: "x".repeat(1000) }, 300);
    const re = new Reassembler({ partialTtlMs: 1000 });
    re.accept(frames[0] as Frame, 0);
    let status = "";
    for (const f of frames.slice(1)) status = re.accept(f, 5000).status;
    expect(status).toBe("partial"); // first chunk was forgotten, so it never completes
  });

  it("finds uplink frames inside decorated chat text", () => {
    const [frame] = toFrames({ t: "hello" }, UPLINK_CHUNK) as [Frame];
    expect(parseUplink(formatUplink(frame))).toEqual(frame);
    expect(parseUplink(`[Steve] ${formatUplink(frame)}`)).toEqual(frame);
    expect(parseUplink("hello world")).toBeUndefined();
    expect(parseUplink("CZ1|not|a|frame|at all")).toBeUndefined();
  });

  it("rejects malformed frames", () => {
    expect(parseFrame("abc|0|1|QUJD")).toBeDefined();
    expect(parseFrame("abc|1|1|QUJD")).toBeUndefined(); // seq >= total
    expect(parseFrame("abc|0|0|QUJD")).toBeUndefined();
    expect(parseFrame("ABC|0|1|QUJD")).toBeUndefined(); // id must be lowercase base36
    expect(parseFrame("abc|0|1|QU JD")).toBeUndefined();
    expect(parseFrame("abc|0|1")).toBeUndefined();
  });

  it("formats acks and pings", () => {
    expect(parseAck(formatAck({ mid: "ab12", seq: 3 }))).toEqual({ mid: "ab12", seq: 3 });
    expect(parseAck("nope")).toBeUndefined();
    expect(parsePing(formatPing("sess1"))).toEqual({ session: "sess1", version: 1 });
  });

  it("generates valid ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBeGreaterThan(490);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{1,12}$/);
  });
});

describe("ReliableSender", () => {
  it("resolves true once every frame is acknowledged", async () => {
    const sent: Frame[] = [];
    const sender = new ReliableSender({ maxChunk: 50 }, (f) => sent.push(f));
    const done = sender.send({ text: "y".repeat(300) }, 0);
    expect(sent.length).toBeGreaterThan(1);
    for (const f of sent) sender.ack(f.mid, f.seq);
    await expect(done).resolves.toBe(true);
    expect(sender.inFlight).toBe(0);
  });

  it("retransmits unacknowledged frames and reports the attempt number", async () => {
    const attempts: number[] = [];
    const sender = new ReliableSender({ maxChunk: 500, retryMs: 1000, maxAttempts: 3 }, (_f, attempt) => attempts.push(attempt));
    const done = sender.send({ a: 1 }, 0);
    sender.tick(500);
    expect(attempts).toEqual([1]);
    sender.tick(1000);
    expect(attempts).toEqual([1, 2]);
    sender.tick(2000);
    expect(attempts).toEqual([1, 2, 3]);
    sender.tick(3000); // out of attempts
    await expect(done).resolves.toBe(false);
  });

  it("survives a transmit function that throws", async () => {
    let calls = 0;
    let last: Frame | undefined;
    const sender = new ReliableSender({ maxChunk: 500, retryMs: 10 }, (f) => {
      calls++;
      if (calls === 1) throw new Error("player offline");
      last = f;
    });
    const done = sender.send({ a: 1 }, 0);
    sender.tick(20);
    sender.ack((last as Frame).mid, 0);
    await expect(done).resolves.toBe(true);
  });

  it("abortAll fails everything in flight", async () => {
    const sender = new ReliableSender({ maxChunk: 500 }, () => {});
    const done = sender.send({ a: 1 }, 0);
    sender.abortAll();
    await expect(done).resolves.toBe(false);
  });
});
