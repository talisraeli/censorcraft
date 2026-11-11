/**
 * Fake Minecraft client.
 *
 * Connects to the companion's WebSocket exactly like the game does after
 * `/connect`, answers `subscribe` / `commandRequest` messages, and plays the
 * role of the add-on by speaking the CensorCraft protocol:
 *   - /scriptevent censor:p|m|a commands are interpreted like the add-on would
 *   - uplink frames are emitted as PlayerMessage events (as if `/tell @s ...`)
 *
 * Run interactively:   pnpm fake-client
 * Options:             --url ws://localhost:8765  --topic "Calculus 1"
 *                      --difficulty easy|medium|hard|test  --answer "2x"  --count 1
 */
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  DownlinkMsg,
  EVENT_ACK,
  EVENT_MESSAGE,
  EVENT_PING,
  formatUplink,
  Frame,
  newId,
  parseAck,
  parseFrame,
  parsePing,
  PROTOCOL_VERSION,
  QuestionMsg,
  Reassembler,
  ReliableSender,
  TestQuestionMsg,
  TestResultMsg,
  UPLINK_CHUNK,
  UplinkMsg,
  VerdictMsg,
  WireQuestion,
} from "@censorcraft/shared";
import WebSocket from "ws";

type Request = UplinkMsg extends infer M ? (M extends { r: string } ? Omit<M, "r" | "pid"> : never) : never;

export interface FakeClientOptions {
  url: string;
  playerId?: string;
  playerName?: string;
  /** Drop the first N uplink frames to exercise retransmission. */
  dropUplinkFrames?: number;
  /** Report failure for scriptevent commands longer than this (exercises chunk-size fallback). */
  maxCommandLength?: number;
  /** PlayerMessage type to emit ("tell" like `/tell @s`, or "say"). */
  chatType?: string;
  log?: (line: string) => void;
}

export class FakeMinecraftClient {
  readonly playerId: string;
  readonly playerName: string;
  /** Every scriptevent command line received (for assertions). */
  readonly commands: string[] = [];
  /** Every decoded downlink message (for assertions). */
  readonly received: DownlinkMsg[] = [];
  linked = false;
  private ws!: WebSocket;
  private readonly subscriptions = new Set<string>();
  private readonly reassembler = new Reassembler<DownlinkMsg>();
  private readonly waiting = new Map<string, { resolve: (m: DownlinkMsg) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly sender: ReliableSender;
  private tick: NodeJS.Timeout | undefined;
  private session = "";
  private dropsLeft: number;
  private linkWaiters: (() => void)[] = [];

  constructor(private readonly options: FakeClientOptions) {
    this.playerId = options.playerId ?? "fake-player-1";
    this.playerName = options.playerName ?? "FakeSteve";
    this.dropsLeft = options.dropUplinkFrames ?? 0;
    this.sender = new ReliableSender({ maxChunk: UPLINK_CHUNK, retryMs: 400, maxAttempts: 5 }, (frame) => this.emitChat(frame));
  }

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.options.url);
    // Attach before "open": the companion's subscribe + first ping can arrive in the same packet as the handshake.
    this.ws.on("message", (data) => this.onPacket(data.toString()));
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (e) => reject(new Error(`Cannot connect to ${this.options.url}: ${e.message}. Is the companion running?`)));
    });
    this.ws.on("close", () => {
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error("connection closed"));
      }
      this.waiting.clear();
    });
    this.tick = setInterval(() => this.sender.tick(Date.now()), 100);
  }

  /** Resolves once the companion's ping was answered with a hello that got acknowledged. */
  waitLinked(timeoutMs = 5000): Promise<void> {
    if (this.linked) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the companion did not ping within the timeout")), timeoutMs);
      this.linkWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  close(): void {
    clearInterval(this.tick);
    this.sender.abortAll();
    this.ws?.close();
  }

  /** Send a request and wait for the reply that carries the same request id. */
  async request<T extends DownlinkMsg = DownlinkMsg>(body: Request, timeoutMs = 15000): Promise<T> {
    const r = newId();
    const message = { ...body, r, pid: this.playerId } as UplinkMsg;
    const reply = new Promise<DownlinkMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(r);
        reject(new Error(`no reply to ${message.t} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(r, { resolve, reject, timer });
    });
    const delivered = await this.sender.send(message, Date.now());
    if (!delivered) {
      const w = this.waiting.get(r);
      if (w) clearTimeout(w.timer);
      this.waiting.delete(r);
      throw new Error(`uplink frame for ${message.t} was never acknowledged`);
    }
    return (await reply) as T;
  }

  // Convenience wrappers ------------------------------------------------------

  askQuestion(topic: string, diff: "easy" | "medium" | "hard", custom = false) {
    return this.request<QuestionMsg>({ t: "q.req", pname: this.playerName, topic, diff, custom });
  }
  answer(qid: string, ans: string) {
    return this.request<VerdictMsg>({ t: "q.ans", qid, ans });
  }
  startTest(topic: string, custom = false) {
    return this.request<TestQuestionMsg>({ t: "t.start", pname: this.playerName, topic, custom });
  }
  answerTest(tid: string, qid: string, ans: string) {
    return this.request<TestQuestionMsg | TestResultMsg>({ t: "t.ans", tid, qid, ans }, 30000);
  }

  // Minecraft side --------------------------------------------------------------

  private onPacket(text: string): void {
    let packet: any;
    try {
      packet = JSON.parse(text);
    } catch {
      return;
    }
    const purpose = packet?.header?.messagePurpose;
    if (purpose === "subscribe") {
      this.subscriptions.add(packet.body?.eventName);
      return;
    }
    if (purpose !== "commandRequest") return;
    const line = String(packet.body?.commandLine ?? "").replace(/^\//, "");
    const statusCode = this.runCommand(line);
    this.ws.send(
      JSON.stringify({
        header: { version: 1, requestId: packet.header.requestId, messagePurpose: "commandResponse" },
        body: { statusCode, ...(statusCode === 0 ? {} : { statusMessage: "Syntax error" }) },
      }),
    );
  }

  /** Behaves like the add-on's scriptEventReceive handler. Returns the command status code. */
  private runCommand(line: string): number {
    const m = /^scriptevent\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    if (!m) return -2147483648;
    this.commands.push(line);
    if (this.options.maxCommandLength && line.length > this.options.maxCommandLength) return -2147352576;
    const [, id, body = ""] = m;
    if (id === EVENT_PING) {
      const ping = parsePing(body);
      if (ping && ping.session !== this.session) {
        this.session = ping.session;
        void this.sender.send({ t: "hello", v: PROTOCOL_VERSION, s: ping.session }, Date.now()).then((ok) => {
          if (!ok) return;
          this.linked = true;
          for (const w of this.linkWaiters.splice(0)) w();
        });
      }
    } else if (id === EVENT_ACK) {
      const ack = parseAck(body);
      if (ack) this.sender.ack(ack.mid, ack.seq);
    } else if (id === EVENT_MESSAGE) {
      const frame = parseFrame(body);
      if (frame) {
        const result = this.reassembler.accept(frame, Date.now());
        if (result.status === "complete") this.onDownlink(result.message);
      }
    }
    return 0;
  }

  private onDownlink(message: DownlinkMsg): void {
    this.received.push(message);
    const waiter = this.waiting.get(message.r);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiting.delete(message.r);
    waiter.resolve(message);
  }

  /** Deliver an uplink frame as the PlayerMessage event Minecraft would emit for `/tell @s <frame>`. */
  private emitChat(frame: Frame): void {
    if (this.dropsLeft > 0) {
      this.dropsLeft--;
      return;
    }
    if (!this.subscriptions.has("PlayerMessage") || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        header: { eventName: "PlayerMessage", messagePurpose: "event", version: 17104896 },
        body: { message: formatUplink(frame), receiver: this.playerName, sender: this.playerName, type: this.options.chatType ?? "tell" },
      }),
    );
  }
}

// ---- CLI --------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function printQuestion(q: WireQuestion, heading: string): void {
  console.log(`\n=== ${heading} [${q.diff}, ${q.fmt}, from ${q.src}] ===`);
  console.log(q.text);
  q.opts?.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
}

async function cli(): Promise<void> {
  const url = arg("url") ?? "ws://localhost:8765";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (prompt: string, preset?: string) => preset ?? (await rl.question(prompt)).trim();
  const client = new FakeMinecraftClient({ url });
  try {
    await client.connect();
    console.log(`Connected to ${url}. Waiting for the companion's ping...`);
    await client.waitLinked();
    console.log("Linked.");

    const topic = (await ask('Topic (e.g. "Calculus 1", "Linear Algebra", "C Fundamentals", or anything): ', arg("topic"))) || "Calculus 1";
    const difficulty = ((await ask("Difficulty (easy / medium / hard / test): ", arg("difficulty"))) || "easy").toLowerCase();
    const readAnswer = async (q: WireQuestion) => {
      const raw = await ask(q.fmt === "mc" ? "Your choice (1-4): " : "Your answer: ", arg("answer"));
      return q.fmt === "mc" ? String(Number(raw) - 1) : raw;
    };
    const fail = (m: DownlinkMsg) => {
      if (m.t === "err") throw new Error(`Censor says: ${m.msg} [${m.code}]`);
    };

    if (difficulty === "test") {
      console.log("Censor is thinking...");
      let step: DownlinkMsg = await client.startTest(topic);
      for (;;) {
        fail(step);
        if (step.t !== "t.q") break;
        printQuestion(step.q, `Exam question ${step.idx}/${step.total}`);
        const answer = await readAnswer(step.q);
        console.log("Censor is thinking...");
        step = await client.answerTest(step.tid, step.q.qid, answer);
      }
      if (step.t === "t.res") {
        console.log(`\n=== Exam result: ${step.score}/${step.total} (${step.pct}%) - ${step.pass ? "PASSED" : "not passed"} ===`);
        for (const item of step.items) console.log(`  Q${item.n}: ${item.ok ? "correct" : `score ${item.score}`} - ${item.expl}`);
      }
    } else {
      const count = Number(arg("count") ?? 1);
      for (let i = 0; i < count; i++) {
        console.log("Censor is thinking...");
        const q = await client.askQuestion(topic, (["easy", "medium", "hard"].includes(difficulty) ? difficulty : "easy") as "easy");
        fail(q);
        printQuestion(q.q, "Question");
        const answer = await readAnswer(q.q);
        console.log("Censor is grading...");
        const v = await client.answer(q.q.qid, answer);
        fail(v);
        console.log(`\n${v.ok ? "CORRECT" : v.score > 0 ? `PARTIAL CREDIT (${Math.round(v.score * 100)}%)` : "INCORRECT"} - ${v.expl}`);
      }
    }
  } finally {
    rl.close();
    client.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch((error) => {
    console.error(`\n${(error as Error).message}`);
    process.exitCode = 1;
  });
}
