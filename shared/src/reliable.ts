import { Frame, toFrames } from "./frames";

export interface ReliableSenderOptions {
  /** Max characters of payload per frame. */
  maxChunk: number;
  /** Resend an unacknowledged frame after this long (ms). */
  retryMs?: number;
  /** Total transmissions per frame before the message is declared lost. */
  maxAttempts?: number;
}

interface PendingFrame {
  frame: Frame;
  attempts: number;
  lastSentAt: number;
}

interface PendingMessage {
  mid: string;
  frames: Map<number, PendingFrame>;
  onDone: (ok: boolean) => void;
}

/**
 * Transport-agnostic "send until acknowledged" state machine. The owner calls
 * `send()`, feeds acknowledgements into `ack()` and calls `tick(now)` at a
 * regular interval. `transmit(frame, attempt)` is called for every (re)send.
 *
 * Time is injected so the same code runs in the Bedrock script runtime, in
 * Node, and in unit tests.
 */
export class ReliableSender {
  private readonly pending = new Map<string, PendingMessage>();
  private readonly retryMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly options: ReliableSenderOptions,
    private readonly transmit: (frame: Frame, attempt: number) => void,
  ) {
    this.retryMs = options.retryMs ?? 2500;
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  /** Queue a message; resolves true when every frame was acknowledged, false when given up. */
  send(message: unknown, now: number): Promise<boolean> {
    const frames = toFrames(message, this.options.maxChunk);
    const mid = (frames[0] as Frame).mid;
    return new Promise<boolean>((resolve) => {
      const entry: PendingMessage = { mid, frames: new Map(), onDone: resolve };
      for (const frame of frames) entry.frames.set(frame.seq, { frame, attempts: 1, lastSentAt: now });
      this.pending.set(mid, entry);
      for (const frame of frames) this.safeTransmit(frame, 1);
    });
  }

  ack(mid: string, seq: number): void {
    const entry = this.pending.get(mid);
    if (!entry) return;
    entry.frames.delete(seq);
    if (entry.frames.size === 0) {
      this.pending.delete(mid);
      entry.onDone(true);
    }
  }

  tick(now: number): void {
    for (const entry of [...this.pending.values()]) {
      for (const p of entry.frames.values()) {
        if (now - p.lastSentAt < this.retryMs) continue;
        if (p.attempts >= this.maxAttempts) {
          this.pending.delete(entry.mid);
          entry.onDone(false);
          break;
        }
        p.attempts++;
        p.lastSentAt = now;
        this.safeTransmit(p.frame, p.attempts);
      }
    }
  }

  /** Fail everything that is still in flight (e.g. the link went down). */
  abortAll(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const entry of all) entry.onDone(false);
  }

  get inFlight(): number {
    return this.pending.size;
  }

  private safeTransmit(frame: Frame, attempt: number): void {
    try {
      this.transmit(frame, attempt);
    } catch {
      /* a failed transmit is simply retried on the next tick */
    }
  }
}
