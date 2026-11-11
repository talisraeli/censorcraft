import { createHash } from "node:crypto";
import {
  AnswerMsg,
  Difficulty,
  DownlinkMsg,
  ErrorCode,
  newId,
  QuestionFormat,
  QuestionRequestMsg,
  TEST_PASS_FRACTION,
  TEST_QUESTION_COUNT,
  TestAnswerMsg,
  TestResultItem,
  TestStartMsg,
  UplinkMsg,
} from "@censorcraft/shared";
import { WebSocketServer } from "ws";
import { AiError } from "./ai/provider";
import { Bridge } from "./bridge";
import { Engine, isCodeTopic, Verdict } from "./engine";
import { LimitError } from "./limits";
import { Logger } from "./logger";
import { MinecraftSocket } from "./mcws";
import { Session, SessionStore, TestState } from "./sessions";

export interface ServerOptions {
  host: string;
  port: number;
  engine: Engine;
  sessions: SessionStore;
  log: Logger;
  pingIntervalMs?: number;
}

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/** Never trust sizes or shapes of anything that came from the game. */
function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export class CompanionServer {
  private readonly servers: WebSocketServer[] = [];
  private readonly bridges = new Set<Bridge>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly o: ServerOptions) {}

  /** Start listening. "localhost" binds both IPv4 and IPv6 loopback. */
  async listen(): Promise<void> {
    const hosts = this.o.host === "localhost" ? ["127.0.0.1", "::1"] : [this.o.host];
    let bound = 0;
    let lastError: Error | undefined;
    for (const host of hosts) {
      try {
        await new Promise<void>((resolve, reject) => {
          const wss = new WebSocketServer({ host, port: this.o.port, maxPayload: 1024 * 1024 });
          wss.once("listening", () => {
            this.servers.push(wss);
            wss.on("connection", (ws, req) => this.accept(ws, req.socket.remoteAddress ?? "?"));
            wss.on("error", (e) => this.o.log.warn(`WebSocket server error: ${e.message}`));
            resolve();
          });
          wss.once("error", reject);
        });
        bound++;
      } catch (e) {
        lastError = e as Error;
        this.o.log.debug(`Could not listen on ${host}:${this.o.port}: ${lastError.message}`);
      }
    }
    if (bound === 0) {
      const code = (lastError as NodeJS.ErrnoException | undefined)?.code;
      throw new Error(
        code === "EADDRINUSE"
          ? `Port ${this.o.port} is already in use. Close the other program (another companion?) or change websocket.port in config.json.`
          : `Could not listen on ${this.o.host}:${this.o.port}: ${lastError?.message}`,
      );
    }
    this.sweepTimer = setInterval(() => this.o.sessions.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const bridge of this.bridges) bridge.stop();
    await Promise.all(
      this.servers.map(
        (wss) =>
          new Promise<void>((resolve) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => resolve());
          }),
      ),
    );
  }

  private accept(ws: import("ws").WebSocket, remote: string): void {
    const { log } = this.o;
    log.info(`Minecraft connected from ${remote}.`);
    const socket = new MinecraftSocket(ws, log);
    const bridge = new Bridge(socket, log, (message, b) => this.route(message, b), this.o.pingIntervalMs);
    this.bridges.add(bridge);
    socket.onClose = () => {
      bridge.stop();
      this.bridges.delete(bridge);
      log.info("Minecraft disconnected.");
    };
    bridge.start();
  }

  // ---- routing -------------------------------------------------------------

  private route(message: UplinkMsg, bridge: Bridge): void {
    const { log, sessions } = this.o;
    switch (message.t) {
      case "hello":
        log.debug(`Add-on hello (protocol v${message.v}).`);
        return;
      case "cancel":
        sessions.clearActive(str(message.pid, 64));
        return;
      case "q.req":
      case "q.ans":
      case "t.start":
      case "t.ans": {
        const pid = str(message.pid, 64);
        const r = str(message.r, 16);
        if (!pid || !r) return;
        const session = sessions.get(pid, "pname" in message ? str(message.pname, 40) : undefined);
        // One request at a time per player; different players run concurrently.
        session.queue = session.queue
          .then(() => this.handle(message, session))
          .then(
            (reply) => bridge.send(reply),
            (error) => bridge.send(this.errorReply(r, error)),
          )
          .then(() => undefined, () => undefined);
        return;
      }
      default:
        log.debug(`Ignoring unknown message type "${String((message as { t: unknown }).t)}".`);
    }
  }

  private async handle(message: UplinkMsg, session: Session): Promise<DownlinkMsg> {
    switch (message.t) {
      case "q.req":
        return this.onQuestionRequest(message, session);
      case "q.ans":
        return this.onAnswer(message, session);
      case "t.start":
        return this.onTestStart(message, session);
      case "t.ans":
        return this.onTestAnswer(message, session);
      default:
        throw new RequestError("bad_request", "I did not understand that request.");
    }
  }

  private topicOf(message: { topic: unknown }): string {
    const topic = str(message.topic, 80).replace(/\s+/g, " ").trim();
    if (!topic) throw new RequestError("bad_request", "Tell me which topic you want to study.");
    return topic;
  }

  private async onQuestionRequest(message: QuestionRequestMsg, session: Session): Promise<DownlinkMsg> {
    const { engine, sessions, log } = this.o;
    const topic = this.topicOf(message);
    const difficulty = DIFFICULTIES.includes(message.diff) ? message.diff : "easy";
    session.test = undefined;
    session.questions.clear();
    const question = await engine.generate({
      playerId: session.playerId,
      topic,
      custom: message.custom === true,
      difficulty,
      avoid: session.recentStems,
    });
    session.questions.set(question.wire.qid, question);
    sessions.remember(session, question);
    log.info(`${session.playerName}: ${difficulty} ${question.wire.fmt} question on "${topic}" (${question.wire.src}).`);
    return { t: "q", r: message.r, q: question.wire };
  }

  private async onAnswer(message: AnswerMsg, session: Session): Promise<DownlinkMsg> {
    const { engine, log } = this.o;
    const question = session.questions.get(str(message.qid, 16));
    if (!question) throw new RequestError("no_session", "I lost track of that question. Let us start a new one.");
    const verdict = await engine.grade(question, str(message.ans, 2000));
    session.questions.delete(question.wire.qid); // one graded attempt per question
    log.info(`${session.playerName}: answer ${verdict.ok ? "correct" : `incorrect (score ${verdict.score})`}.`);
    return { t: "v", r: message.r, qid: question.wire.qid, ok: verdict.ok, score: verdict.score, expl: verdict.explanation, hash: question.wire.hash };
  }

  private async onTestStart(message: TestStartMsg, session: Session): Promise<DownlinkMsg> {
    const topic = this.topicOf(message);
    const lastFormat: QuestionFormat = isCodeTopic(topic) ? "code" : "short";
    // Mixed difficulty and formats; starts gently.
    const plan: TestState["plan"] = [
      { difficulty: "easy", preferredFormat: "mc" },
      { difficulty: "medium", preferredFormat: "short" },
      { difficulty: "medium", preferredFormat: "mc" },
      { difficulty: "hard", preferredFormat: lastFormat },
      { difficulty: "hard", preferredFormat: "mc" },
    ].slice(0, TEST_QUESTION_COUNT) as TestState["plan"];
    session.questions.clear();
    session.test = { tid: newId(), topic, custom: message.custom === true, plan, items: [] };
    this.o.log.info(`${session.playerName}: started a test on "${topic}".`);
    return this.nextTestQuestion(message.r, session, session.test);
  }

  private async nextTestQuestion(r: string, session: Session, test: TestState): Promise<DownlinkMsg> {
    const step = test.plan[test.items.length] as TestState["plan"][number];
    const question = await this.o.engine.generate({
      playerId: session.playerId,
      topic: test.topic,
      custom: test.custom,
      difficulty: step.difficulty,
      preferredFormat: step.preferredFormat,
      avoid: [...session.recentStems, ...test.items.map((i) => i.question.wire.text)],
    });
    test.items.push({ question });
    this.o.sessions.remember(session, question);
    return { t: "t.q", r, tid: test.tid, idx: test.items.length, total: test.plan.length, q: question.wire };
  }

  private async onTestAnswer(message: TestAnswerMsg, session: Session): Promise<DownlinkMsg> {
    const { engine, log } = this.o;
    const test = session.test;
    if (!test || test.tid !== message.tid) throw new RequestError("no_session", "That exam is no longer running. Start a new one.");
    const current = test.items[test.items.length - 1];
    if (!current || current.question.wire.qid !== message.qid || current.verdict) {
      throw new RequestError("bad_request", "That answer does not match the current exam question.");
    }
    // Grade in the background; the verdict is withheld until the exam is over.
    const answer = str(message.ans, 2000);
    current.verdict = engine.grade(current.question, answer).catch(async (first) => {
      log.warn(`Grading an exam answer failed (${(first as Error).message}); retrying once.`);
      return engine.grade(current.question, answer).catch(
        (): Verdict => ({ ok: false, score: 0, explanation: "This answer could not be graded because the AI service failed." }),
      );
    });
    current.verdict.catch(() => {});

    if (test.items.length < test.plan.length) return this.nextTestQuestion(message.r, session, test);

    const verdicts = await Promise.all(test.items.map((i) => i.verdict as Promise<Verdict>));
    const items: TestResultItem[] = verdicts.map((v, i) => ({ n: i + 1, ok: v.ok, score: v.score, expl: v.explanation }));
    const score = Math.round(verdicts.reduce((sum, v) => sum + v.score, 0) * 100) / 100;
    const total = test.items.length;
    const pass = score / total >= TEST_PASS_FRACTION - 1e-9;
    const hash = createHash("sha1")
      .update(test.items.map((i) => i.question.wire.hash).join("|"))
      .digest("hex")
      .slice(0, 12);
    session.test = undefined;
    log.info(`${session.playerName}: finished the test with ${score}/${total} (${pass ? "passed" : "failed"}).`);
    return { t: "t.res", r: message.r, tid: test.tid, score, total, pct: Math.round((score / total) * 100), pass, hash, items };
  }

  // ---- errors --------------------------------------------------------------

  /** Convert any failure into a player-safe message. Details go to the companion log only. */
  private errorReply(r: string, error: unknown): DownlinkMsg {
    const { log } = this.o;
    let code: ErrorCode = "internal";
    let msg = "Something went wrong on my side. Please try again.";
    if (error instanceof RequestError) {
      code = error.code;
      msg = error.message;
    } else if (error instanceof LimitError) {
      code = "rate_limited";
      msg = error.message;
      log.info(`Limit reached: ${error.reason}`);
    } else if (error instanceof AiError) {
      log.error(`AI request failed [${error.kind}]: ${error.message}`);
      if (error.kind === "auth") {
        code = "ai_auth";
        msg = "My AI service refused the API key. Ask whoever runs the companion app to check its config.";
      } else if (error.kind === "quota") {
        code = "ai_quota";
        msg = "My AI service says the account is out of quota. Ask whoever runs the companion app to check billing.";
      } else if (error.kind === "network" || error.kind === "timeout") {
        code = "ai_network";
        msg = "I could not reach my AI service. Check the internet connection of the companion app and try again.";
      } else if (error.kind === "rate_limit") {
        code = "rate_limited";
        msg = "My AI service is busy right now. Give me a minute and try again.";
      } else {
        code = "ai_failed";
        msg = "I could not prepare that properly. Please try again.";
      }
    } else {
      log.error(`Unexpected error: ${(error as Error)?.stack ?? String(error)}`);
    }
    return { t: "err", r, code, msg };
  }
}

class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
