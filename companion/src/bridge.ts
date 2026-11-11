import {
  DOWNLINK_CHUNK,
  DownlinkMsg,
  EVENT_ACK,
  EVENT_MESSAGE,
  EVENT_PING,
  formatAck,
  formatFrame,
  formatPing,
  newId,
  parseUplink,
  PING_INTERVAL_MS,
  Reassembler,
  toFrames,
  UplinkMsg,
} from "@censorcraft/shared";
import { Logger } from "./logger";
import { MinecraftSocket } from "./mcws";

const MIN_CHUNK = 200;
const FRAME_ATTEMPTS = 3;

/**
 * Protocol endpoint for one connected Minecraft client.
 *
 *  uplink   (add-on -> companion): chat frames seen through the PlayerMessage
 *           event; each frame is acknowledged with `/scriptevent censor:a`.
 *  downlink (companion -> add-on): `/scriptevent censor:m <frame>`; the
 *           command response is the acknowledgement, failed frames are retried.
 */
export class Bridge {
  /** Identifies this connection to the add-on (it re-announces itself when the id changes). */
  readonly session = newId();
  linked = false;
  private readonly reassembler = new Reassembler<UplinkMsg>();
  private pingTimer: NodeJS.Timeout | undefined;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private chunkSize = DOWNLINK_CHUNK;
  private warnedCommands = false;
  private stopped = false;

  constructor(
    private readonly socket: MinecraftSocket,
    private readonly log: Logger,
    private readonly onMessage: (message: UplinkMsg, bridge: Bridge) => void,
    private readonly pingIntervalMs: number = PING_INTERVAL_MS,
  ) {
    socket.onPlayerMessage = (event) => this.handleChat(event.message, event.type);
  }

  start(): void {
    this.socket.subscribe("PlayerMessage");
    const ping = () => {
      this.socket
        .command(`scriptevent ${EVENT_PING} ${formatPing(this.session)}`)
        .then((result) => {
          if (result.statusCode !== 0 && !this.warnedCommands) {
            this.warnedCommands = true;
            this.log.warn(
              `Minecraft refused /scriptevent (status ${result.statusCode}${result.statusMessage ? `: ${result.statusMessage}` : ""}). ` +
                "Enable cheats in the world and make sure the connected player is an operator.",
            );
          }
        })
        .catch(() => {
          /* disconnects are reported by the socket */
        });
    };
    ping();
    this.pingTimer = setInterval(ping, this.pingIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
  }

  /** Send a message to the add-on. Resolves false when it could not be delivered. */
  send(message: DownlinkMsg): Promise<boolean> {
    const run = this.sendQueue.then(() => this.deliver(message));
    this.sendQueue = run.catch(() => false);
    return run;
  }

  private async deliver(message: DownlinkMsg): Promise<boolean> {
    for (let round = 0; round < 4 && !this.stopped; round++) {
      const frames = toFrames(message, this.chunkSize);
      let failedStatus: number | undefined;
      for (const frame of frames) {
        const ok = await this.sendFrame(`scriptevent ${EVENT_MESSAGE} ${formatFrame(frame)}`);
        if (ok !== true) {
          failedStatus = ok;
          break;
        }
      }
      if (failedStatus === undefined) return true;
      // The command was rejected. If frames are long, the command length limit is the likely cause:
      // halve the chunk size and resend the whole message under a new id.
      if (this.chunkSize > MIN_CHUNK && frames.some((f) => f.chunk.length > MIN_CHUNK)) {
        this.chunkSize = Math.max(MIN_CHUNK, Math.floor(this.chunkSize / 2));
        this.log.warn(`Minecraft rejected a frame (status ${failedStatus}); retrying with ${this.chunkSize}-character chunks.`);
        continue;
      }
      break;
    }
    this.log.warn(`Could not deliver a "${message.t}" message to Minecraft.`);
    return false;
  }

  /** true = delivered; otherwise the last status code (or -1 for timeouts). */
  private async sendFrame(commandLine: string): Promise<true | number> {
    let last = -1;
    for (let attempt = 0; attempt < FRAME_ATTEMPTS; attempt++) {
      if (this.stopped || !this.socket.isOpen) return -1;
      try {
        const result = await this.socket.command(commandLine);
        if (result.statusCode === 0) return true;
        return result.statusCode; // a rejected command will not succeed by repeating it verbatim
      } catch {
        last = -1; // timeout: retry
      }
    }
    return last;
  }

  private handleChat(text: string, type: string): void {
    const frame = parseUplink(text);
    if (!frame) return;
    // Always acknowledge, including duplicates: the add-on may have missed the first ack.
    this.socket.command(`scriptevent ${EVENT_ACK} ${formatAck(frame)}`).catch(() => {});
    const result = this.reassembler.accept(frame, Date.now());
    if (result.status === "invalid") {
      this.log.warn(`Dropped a damaged frame from Minecraft (${result.error}).`);
      return;
    }
    if (result.status !== "complete") return;
    const message = result.message;
    if (!message || typeof message !== "object" || typeof (message as { t?: unknown }).t !== "string") return;
    if (!this.linked) {
      this.linked = true;
      this.log.info(`CensorCraft add-on linked (uplink arrives as "${type}" messages).`);
    }
    this.onMessage(message, this);
  }
}
