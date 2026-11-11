import { Difficulty, QuestionFormat } from "@censorcraft/shared";
import type { StoredQuestion, Verdict } from "./engine";

export interface TestItem {
  question: StoredQuestion;
  /** Grading starts as soon as the answer arrives; the result is withheld until the end. */
  verdict?: Promise<Verdict>;
}

export interface TestState {
  tid: string;
  topic: string;
  custom: boolean;
  plan: { difficulty: Difficulty; preferredFormat?: QuestionFormat }[];
  items: TestItem[];
}

export interface Session {
  playerId: string;
  playerName: string;
  /** Unanswered practice questions by qid (normally at most one). */
  questions: Map<string, StoredQuestion>;
  /** Stems of recently asked questions, to avoid repeats. */
  recentStems: string[];
  test?: TestState;
  lastActive: number;
  /** Serializes this player's requests. */
  queue: Promise<void>;
}

/** Per-player state, keyed by the player's id. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(playerId: string, playerName?: string): Session {
    let session = this.sessions.get(playerId);
    if (!session) {
      session = {
        playerId,
        playerName: playerName ?? playerId,
        questions: new Map(),
        recentStems: [],
        lastActive: this.now(),
        queue: Promise.resolve(),
      };
      this.sessions.set(playerId, session);
    }
    if (playerName) session.playerName = playerName;
    session.lastActive = this.now();
    return session;
  }

  peek(playerId: string): Session | undefined {
    return this.sessions.get(playerId);
  }

  remember(session: Session, question: StoredQuestion): void {
    session.recentStems.push(question.wire.text);
    if (session.recentStems.length > 12) session.recentStems.shift();
  }

  /** Forget unanswered questions and any running test (player left / cancelled). */
  clearActive(playerId: string): void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    session.questions.clear();
    session.test = undefined;
  }

  /** Drop idle sessions and stale unanswered questions. Returns how many sessions were removed. */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - session.lastActive > this.idleTimeoutMs) {
        this.sessions.delete(id);
        removed++;
        continue;
      }
      for (const [qid, q] of session.questions) {
        if (now - q.createdAt > this.idleTimeoutMs) session.questions.delete(qid);
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}
