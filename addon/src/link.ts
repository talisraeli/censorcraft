import { Player, system, world } from "@minecraft/server";
import {
  DownlinkMsg,
  EVENT_ACK,
  EVENT_MESSAGE,
  EVENT_NAMESPACE,
  EVENT_PING,
  formatUplink,
  Frame,
  newId,
  parseAck,
  parseFrame,
  parsePing,
  PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  Reassembler,
  ReliableSender,
  UPLINK_CHUNK,
  UplinkMsg,
} from "@censorcraft/shared";

/**
 * Commands that can carry an uplink frame. Both are visible to the companion
 * through the WebSocket "PlayerMessage" event.
 *  - "tell @s": a whisper to oneself. Only the bridge player sees it. Preferred.
 *  - "say":     visible to everyone. Only used as a fallback when whispers are
 *               not acknowledged (the working mode is remembered).
 */
const UPLINK_COMMANDS = ["tell @s", "say"] as const;
const MODE_PROPERTY = "censor:uplink_mode";

export type LinkFailure = "disconnected" | "timeout" | "undelivered";

export class LinkError extends Error {
  constructor(readonly failure: LinkFailure) {
    super(failure);
  }
}

type RequestBody = UplinkMsg extends infer M ? (M extends { r: string } ? Omit<M, "r"> : never) : never;

interface Waiter {
  resolve: (message: DownlinkMsg) => void;
  reject: (error: LinkError) => void;
  deadline: number;
}

/**
 * Add-on end of the protocol.
 *
 * The companion's commands run as the player who typed /connect, so that
 * player is the source entity of every /scriptevent. The add-on remembers
 * them as the "bridge player" and sends all uplink traffic (for every player
 * on the server) through whisper commands executed as the bridge player.
 */
class Link {
  private bridgeId: string | undefined;
  private lastPing = 0;
  private session = "";
  private mode = 0;
  private wasConnected = false;
  private readonly reassembler = new Reassembler<DownlinkMsg>();
  private readonly waiting = new Map<string, Waiter>();
  private readonly frameMode = new Map<string, number>();
  private readonly sender = new ReliableSender({ maxChunk: UPLINK_CHUNK, retryMs: 2000, maxAttempts: 4 }, (frame, attempt) =>
    this.transmit(frame, attempt),
  );

  /** Call once at script start (subscribing is allowed before the world has loaded). */
  init(): void {
    system.afterEvents.scriptEventReceive.subscribe(
      (event) => {
        try {
          if (event.id === EVENT_PING) this.onPing(event.message, event.sourceEntity);
          else if (event.id === EVENT_ACK) this.onAck(event.message);
          else if (event.id === EVENT_MESSAGE) this.onFrame(event.message);
        } catch (e) {
          console.warn(`[CensorCraft] link error: ${String(e)}`);
        }
      },
      { namespaces: [EVENT_NAMESPACE] },
    );
    system.runInterval(() => this.tick(), 10);
  }

  /** Call after the world has loaded (dynamic properties are available). */
  loadState(): void {
    const stored = world.getDynamicProperty(MODE_PROPERTY);
    if (typeof stored === "number" && stored >= 0 && stored < UPLINK_COMMANDS.length) this.mode = stored;
  }

  get connected(): boolean {
    return this.lastPing > 0 && Date.now() - this.lastPing < PING_TIMEOUT_MS && this.bridge() !== undefined;
  }

  /** Send a request and wait for the reply with the same request id. Rejects with LinkError. */
  async request(body: RequestBody, timeoutMs = 60_000): Promise<DownlinkMsg> {
    if (!this.connected) throw new LinkError("disconnected");
    const r = newId();
    const reply = new Promise<DownlinkMsg>((resolve, reject) => {
      this.waiting.set(r, { resolve, reject, deadline: Date.now() + timeoutMs });
    });
    reply.catch(() => {}); // rejection is also observed below; avoid an unhandled-rejection report
    const delivered = await this.sender.send({ ...body, r } as UplinkMsg, Date.now());
    if (!delivered) {
      const waiter = this.waiting.get(r);
      this.waiting.delete(r);
      const error = new LinkError(this.connected ? "undelivered" : "disconnected");
      waiter?.reject(error);
      throw error;
    }
    return reply;
  }

  /** Fire-and-forget message (still retried until acknowledged). */
  notify(message: UplinkMsg): void {
    if (!this.connected) return;
    void this.sender.send(message, Date.now());
  }

  private bridge(): Player | undefined {
    if (!this.bridgeId) return undefined;
    const entity = world.getEntity(this.bridgeId);
    return entity instanceof Player && entity.isValid ? entity : undefined;
  }

  private transmit(frame: Frame, attempt: number): void {
    const player = this.bridge();
    if (!player) throw new Error("no bridge player");
    // First attempt uses the remembered mode; each retry rotates to the next carrier command.
    const mode = (this.mode + attempt - 1) % UPLINK_COMMANDS.length;
    this.frameMode.set(`${frame.mid}|${frame.seq}`, mode);
    player.runCommand(`${UPLINK_COMMANDS[mode]} ${formatUplink(frame)}`);
  }

  private onPing(body: string, source: unknown): void {
    const ping = parsePing(body);
    if (!ping || !(source instanceof Player)) return;
    this.bridgeId = source.id;
    this.lastPing = Date.now();
    if (ping.session !== this.session) {
      // A new companion connection: announce ourselves (this also probes which uplink command works).
      this.session = ping.session;
      this.sender.abortAll();
      void this.sender.send({ t: "hello", v: PROTOCOL_VERSION, s: ping.session }, Date.now());
    }
  }

  private onAck(body: string): void {
    const ack = parseAck(body);
    if (!ack) return;
    const key = `${ack.mid}|${ack.seq}`;
    const mode = this.frameMode.get(key);
    this.frameMode.delete(key);
    if (mode !== undefined && mode !== this.mode) {
      this.mode = mode;
      try {
        world.setDynamicProperty(MODE_PROPERTY, mode);
      } catch {
        /* world not ready; the mode is rediscovered next time */
      }
    }
    this.sender.ack(ack.mid, ack.seq);
  }

  private onFrame(body: string): void {
    const frame = parseFrame(body);
    if (!frame) return;
    const result = this.reassembler.accept(frame, Date.now());
    if (result.status !== "complete") return;
    const message = result.message;
    if (!message || typeof message.r !== "string") return;
    const waiter = this.waiting.get(message.r);
    if (!waiter) return;
    this.waiting.delete(message.r);
    waiter.resolve(message);
  }

  private tick(): void {
    const now = Date.now();
    this.sender.tick(now);
    if (this.frameMode.size > 200) this.frameMode.clear();
    const connected = this.connected;
    if (this.wasConnected && !connected) {
      // The companion went away: fail everything that is waiting, right now.
      this.sender.abortAll();
      for (const waiter of this.waiting.values()) waiter.reject(new LinkError("disconnected"));
      this.waiting.clear();
    }
    this.wasConnected = connected;
    for (const [r, waiter] of this.waiting) {
      if (now > waiter.deadline) {
        this.waiting.delete(r);
        waiter.reject(new LinkError("timeout"));
      }
    }
  }
}

export const link = new Link();
