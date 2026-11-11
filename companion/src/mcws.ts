import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { Logger } from "./logger";

/**
 * Minimal implementation of the Minecraft Bedrock WebSocket protocol (the one
 * behind `/connect`). Minecraft is the WebSocket *client*; this side sends
 * `subscribe` and `commandRequest` messages and receives events and command
 * responses. All messages are JSON: { header: {...}, body: {...} }.
 */

export interface CommandResult {
  /** 0 on success. Negative values mean the command failed (syntax, permissions...). */
  statusCode: number;
  statusMessage?: string;
}

export interface PlayerMessageEvent {
  message: string;
  sender: string;
  receiver: string;
  /** "chat", "say", "tell", "me", "title", ... */
  type: string;
}

export function buildSubscribe(eventName: string, requestId: string = randomUUID()): string {
  return JSON.stringify({
    header: { version: 1, requestId, messageType: "commandRequest", messagePurpose: "subscribe" },
    body: { eventName },
  });
}

export function buildCommand(commandLine: string, requestId: string = randomUUID()): string {
  return JSON.stringify({
    header: { version: 1, requestId, messageType: "commandRequest", messagePurpose: "commandRequest" },
    body: { version: 1, commandLine, origin: { type: "player" } },
  });
}

/** Extract a PlayerMessage event from any of the shapes different game versions use. */
export function parsePlayerMessage(packet: any): PlayerMessageEvent | undefined {
  const header = packet?.header;
  const body = packet?.body;
  if (!header || !body) return undefined;
  const name = header.eventName ?? body.eventName;
  if (header.messagePurpose !== "event" || name !== "PlayerMessage") return undefined;
  const p = body.properties ?? body;
  const message = p.message ?? p.Message;
  if (typeof message !== "string") return undefined;
  return {
    message,
    sender: String(p.sender ?? p.Sender ?? ""),
    receiver: String(p.receiver ?? p.Receiver ?? ""),
    type: String(p.type ?? p.MessageType ?? "chat"),
  };
}

export class MinecraftSocket {
  onPlayerMessage: ((event: PlayerMessageEvent) => void) | undefined;
  onClose: (() => void) | undefined;
  private readonly pending = new Map<string, { resolve: (r: CommandResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly log: Logger,
  ) {
    ws.on("message", (data) => this.handle(data.toString()));
    ws.on("close", () => this.shutdown());
    ws.on("error", (e) => {
      this.log.warn(`WebSocket error: ${e.message}`);
      this.shutdown();
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  subscribe(eventName: string): void {
    if (this.isOpen) this.ws.send(buildSubscribe(eventName));
  }

  /** Run a slash command as the connected player. Rejects on timeout or disconnect. */
  command(commandLine: string, timeoutMs = 6000): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      if (!this.isOpen) return reject(new Error("Minecraft is not connected"));
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Minecraft did not answer the command in time"));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.ws.send(buildCommand(commandLine, requestId), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this.shutdown();
  }

  private handle(text: string): void {
    let packet: any;
    try {
      packet = JSON.parse(text);
    } catch {
      return;
    }
    const purpose = packet?.header?.messagePurpose;
    if (purpose === "commandResponse") {
      const entry = this.pending.get(packet.header.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(packet.header.requestId);
      const code = Number(packet.body?.statusCode ?? 0);
      entry.resolve({ statusCode: Number.isFinite(code) ? code : -1, statusMessage: packet.body?.statusMessage });
      return;
    }
    if (purpose === "error") {
      const entry = this.pending.get(packet.header?.requestId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(packet.header.requestId);
        entry.resolve({ statusCode: Number(packet.body?.statusCode ?? -1), statusMessage: packet.body?.statusMessage });
      }
      return;
    }
    const event = parsePlayerMessage(packet);
    if (event) this.onPlayerMessage?.(event);
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Minecraft disconnected"));
    }
    this.pending.clear();
    this.onClose?.();
  }
}
