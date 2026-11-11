/**
 * Application messages. Field names are short because every byte travels
 * through chat / commands.
 *
 * SECURITY: nothing in the downlink types can carry a correct answer, a
 * reference solution or a grading rubric before grading. Those never leave the
 * companion; only the verdict and its explanation do.
 */

export type Difficulty = "easy" | "medium" | "hard";
export type QuestionFormat = "mc" | "short" | "code";

/** Question as the add-on sees it. */
export interface WireQuestion {
  qid: string;
  fmt: QuestionFormat;
  /** Question text (Unicode plain text, sanitized). */
  text: string;
  /** Exactly 4 options when fmt === "mc". */
  opts?: string[];
  /** Stable hash of the question, used by the add-on to dedupe rewards. */
  hash: string;
  diff: Difficulty;
  /** Where the question came from. */
  src: "material" | "syllabus";
}

// ---- add-on -> companion ---------------------------------------------------

export interface HelloMsg {
  t: "hello";
  v: number;
  /** Companion session id echoed from the ping. */
  s: string;
}
export interface QuestionRequestMsg {
  t: "q.req";
  r: string;
  pid: string;
  pname: string;
  topic: string;
  /** True when `topic` is free text typed by the player. */
  custom?: boolean;
  diff: Difficulty;
}
export interface AnswerMsg {
  t: "q.ans";
  r: string;
  pid: string;
  qid: string;
  /** For mc: the option index as a string ("0".."3"). Otherwise free text. */
  ans: string;
}
export interface TestStartMsg {
  t: "t.start";
  r: string;
  pid: string;
  pname: string;
  topic: string;
  custom?: boolean;
}
export interface TestAnswerMsg {
  t: "t.ans";
  r: string;
  pid: string;
  tid: string;
  qid: string;
  ans: string;
}
export interface CancelMsg {
  t: "cancel";
  pid: string;
}
export type UplinkMsg = HelloMsg | QuestionRequestMsg | AnswerMsg | TestStartMsg | TestAnswerMsg | CancelMsg;

// ---- companion -> add-on ---------------------------------------------------

export interface QuestionMsg {
  t: "q";
  r: string;
  q: WireQuestion;
}
export interface VerdictMsg {
  t: "v";
  r: string;
  qid: string;
  ok: boolean;
  /** 0..1. Only Hard questions produce values strictly between 0 and 1. */
  score: number;
  /** Short explanation of the reasoning (may reveal the answer - grading is over). */
  expl: string;
  hash: string;
}
export interface TestQuestionMsg {
  t: "t.q";
  r: string;
  tid: string;
  /** 1-based index. */
  idx: number;
  total: number;
  q: WireQuestion;
}
export interface TestResultItem {
  n: number;
  ok: boolean;
  score: number;
  expl: string;
}
export interface TestResultMsg {
  t: "t.res";
  r: string;
  tid: string;
  /** Sum of per-question scores. */
  score: number;
  total: number;
  /** 0..100 */
  pct: number;
  pass: boolean;
  /** Hash identifying this exam for reward dedupe. */
  hash: string;
  items: TestResultItem[];
}
export type ErrorCode =
  | "rate_limited"
  | "ai_auth"
  | "ai_quota"
  | "ai_network"
  | "ai_failed"
  | "bad_request"
  | "no_session"
  | "internal";
export interface ErrorMsg {
  t: "err";
  r: string;
  code: ErrorCode;
  /** Player-safe message. Never contains keys, paths or stack traces. */
  msg: string;
}
export type DownlinkMsg = QuestionMsg | VerdictMsg | TestQuestionMsg | TestResultMsg | ErrorMsg;

/** Number of questions in Test mode and the pass mark. */
export const TEST_QUESTION_COUNT = 5;
export const TEST_PASS_FRACTION = 0.8;
