import { Entity, Player, world } from "@minecraft/server";
import { ActionFormData, MessageFormData, ModalFormData } from "@minecraft/server-ui";
import { Difficulty, DownlinkMsg, TestResultMsg, WireQuestion } from "@censorcraft/shared";
import { showForm, startIndicator } from "./forms";
import { link, LinkError } from "./link";
import { loadStats, rewardPlayer, rewardStatus, saveStats, statsSummary, tierPreview } from "./rewards";
import { recordAnswer, recordTest } from "./rewardsLogic";
import { pick, S, TOPICS } from "./strings";

/** Players currently inside the study flow (prevents a second menu from a held right-click). */
const active = new Set<string>();

type Next = "next" | "topic" | "leave";
interface Topic {
  name: string;
  custom: boolean;
}

const say = (player: Player, text: string) => {
  if (player.isValid) player.sendMessage(S.say(text));
};

function react(censor: Entity, player: Player, mood: "happy" | "sad"): void {
  try {
    if (censor.isValid) {
      const at = censor.location;
      censor.dimension.spawnParticle(mood === "happy" ? "minecraft:villager_happy" : "minecraft:villager_angry", { x: at.x, y: at.y + 2.1, z: at.z });
      censor.playAnimation(mood === "happy" ? "animation.censor.nod" : "animation.censor.shake");
    }
    if (player.isValid) player.playSound(mood === "happy" ? "random.orb" : "mob.villager.no");
  } catch {
    /* cosmetic */
  }
}

/** Entry point: the player right-clicked Censor. */
export async function openStudy(player: Player, censor: Entity): Promise<void> {
  if (!player.isValid || active.has(player.id)) return;
  if (!link.connected) {
    for (const line of S.notConnected(S.defaultPort)) say(player, line);
    return;
  }
  const id = player.id;
  active.add(id);
  try {
    await studyLoop(player, censor);
  } catch (error) {
    if (error instanceof LinkError) {
      say(player, error.failure === "timeout" ? S.timedOut : error.failure === "undelivered" ? S.undelivered : S.linkLost);
    } else {
      console.warn(`[CensorCraft] study flow error: ${String(error)}${(error as Error)?.stack ? `\n${(error as Error).stack}` : ""}`);
    }
  } finally {
    active.delete(id);
    // Tell the companion to drop any unanswered question / running exam.
    link.notify({ t: "cancel", pid: id });
  }
}

async function studyLoop(player: Player, censor: Entity): Promise<void> {
  for (;;) {
    const topic = await chooseTopic(player);
    if (!topic) return say(player, S.goodbye);
    const difficulty = await chooseDifficulty(player, topic);
    if (!difficulty) return say(player, S.goodbye);

    if (difficulty === "test") {
      const next = await runTest(player, censor, topic);
      if (next === "leave") return say(player, S.goodbye);
      continue;
    }
    for (;;) {
      const next = await runQuestion(player, censor, topic, difficulty);
      if (next === "leave") return say(player, S.goodbye);
      if (next === "topic") break;
    }
  }
}

// ---- menus ------------------------------------------------------------------------

async function chooseTopic(player: Player): Promise<Topic | undefined> {
  const form = new ActionFormData().title(S.topicTitle).body(S.topicBody(statsSummary(loadStats(player))));
  for (const topic of TOPICS) form.button(topic);
  form.button(S.topicCustom);
  const response = await showForm(player, form);
  if (!response || response.selection === undefined) return undefined;
  if (response.selection < TOPICS.length) return { name: TOPICS[response.selection] as string, custom: false };

  const modal = new ModalFormData().title(S.customTitle).textField(S.customLabel, S.customPlaceholder).submitButton(S.customSubmit);
  const custom = await showForm(player, modal);
  if (!custom) return undefined;
  const text = String(custom.formValues?.find((v) => typeof v === "string") ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!text) {
    say(player, S.customEmpty);
    return chooseTopic(player);
  }
  return { name: text, custom: true };
}

async function chooseDifficulty(player: Player, topic: Topic): Promise<Difficulty | "test" | undefined> {
  const levels: Difficulty[] = ["easy", "medium", "hard"];
  const lines = [...levels.map((d) => S.difficultyLine(S.difficultyNames[d], tierPreview(d))), S.testLine(tierPreview("test"))];
  const form = new ActionFormData().title(S.difficultyTitle(topic.name)).body(S.difficultyBody(lines, rewardStatus(loadStats(player))));
  for (const d of levels) form.button(S.difficultyNames[d]);
  form.button(S.difficultyNames.test);
  const response = await showForm(player, form);
  if (!response || response.selection === undefined) return undefined;
  return response.selection < levels.length ? levels[response.selection] : "test";
}

// ---- asking -----------------------------------------------------------------------

/** Wait for the companion while showing an animated action-bar message. */
async function ask(player: Player, text: (dots: string) => string, send: () => Promise<DownlinkMsg>): Promise<DownlinkMsg | undefined> {
  const stop = startIndicator(player, text);
  let reply: DownlinkMsg;
  try {
    reply = await send();
  } finally {
    stop();
  }
  if (reply.t === "err") {
    say(player, S.errorPrefix + reply.msg);
    return undefined;
  }
  return reply;
}

/** Show a question. Returns the answer to send (option index or text), or undefined when the form was closed. */
async function presentQuestion(player: Player, question: WireQuestion, title: string): Promise<string | undefined> {
  const body = `${question.text}\n\n${question.src === "material" ? S.fromMaterial : S.fromSyllabus}`;
  if (question.fmt === "mc" && question.opts) {
    const form = new ActionFormData().title(title).body(body);
    question.opts.forEach((option, i) => form.button(S.optionLabel("ABCD"[i] ?? "?", option)));
    const response = await showForm(player, form);
    return response?.selection === undefined ? undefined : String(response.selection);
  }
  const code = question.fmt === "code";
  const form = new ModalFormData()
    .title(title)
    .label(body)
    .textField(code ? S.codeLabel : S.answerLabel, code ? S.codeHint : S.mathHint)
    .submitButton(S.submit);
  const response = await showForm(player, form);
  if (!response) return undefined;
  // Labels occupy slots in formValues too; the text field is the only string.
  return String(response.formValues?.find((v) => typeof v === "string") ?? "").slice(0, 800);
}

// ---- practice ----------------------------------------------------------------------

async function runQuestion(player: Player, censor: Entity, topic: Topic, difficulty: Difficulty): Promise<Next> {
  const reply = await ask(player, S.thinking, () =>
    link.request({ t: "q.req", pid: player.id, pname: player.name, topic: topic.name, custom: topic.custom, diff: difficulty }),
  );
  if (!reply || reply.t !== "q") return "topic";
  const question = reply.q;

  const answer = await presentQuestion(player, question, S.questionTitle(S.difficultyNames[difficulty]));
  if (answer === undefined) return "leave"; // closed the question: class dismissed

  const graded = await ask(player, S.grading, () => link.request({ t: "q.ans", pid: player.id, qid: question.qid, ans: answer }));
  if (!graded || graded.t !== "v") return "topic";

  const stats = recordAnswer(loadStats(player), graded.ok);
  const { decision, text: rewardText } = rewardPlayer(player, stats, difficulty, graded.score, graded.hash);
  const partial = !graded.ok && decision.partial;

  if (graded.ok) {
    react(censor, player, "happy");
    say(player, decision.stats.streak >= 3 && decision.stats.streak % 3 === 0 ? S.reactStreak(decision.stats.streak) : pick(S.reactCorrect));
  } else if (graded.score > 0) {
    react(censor, player, "happy");
    say(player, pick(S.reactPartial));
  } else {
    react(censor, player, "sad");
    say(player, pick(S.reactWrong));
  }

  const title = graded.ok ? S.verdictCorrect : graded.score > 0 || partial ? S.verdictPartial(Math.round(graded.score * 100)) : S.verdictWrong;
  const body = [graded.expl, rewardText, `§7${statsSummary(decision.stats)}`].filter(Boolean).join("\n\n");
  const form = new ActionFormData().title(title).body(body).button(S.next).button(S.changeTopic).button(S.leave);
  const response = await showForm(player, form);
  if (!response || response.selection === undefined || response.selection === 2) return "leave";
  return response.selection === 0 ? "next" : "topic";
}

// ---- test mode ------------------------------------------------------------------------

async function confirmQuit(player: Player): Promise<boolean> {
  const form = new MessageFormData().title(S.quitExamTitle).body(S.quitExamBody).button1(S.quitExamQuit).button2(S.quitExamKeep);
  const response = await showForm(player, form);
  // Closing the confirmation counts as quitting, so nobody gets trapped in an exam.
  return !response || response.selection === undefined || response.selection === 0;
}

async function runTest(player: Player, censor: Entity, topic: Topic): Promise<Next> {
  say(player, S.examIntro);
  let step = await ask(player, S.thinking, () =>
    link.request({ t: "t.start", pid: player.id, pname: player.name, topic: topic.name, custom: topic.custom }),
  );
  while (step && step.t === "t.q") {
    const current = step;
    let answer: string | undefined;
    for (;;) {
      answer = await presentQuestion(player, current.q, S.examQuestionTitle(current.idx, current.total));
      if (answer !== undefined) break;
      if (!player.isValid || (await confirmQuit(player))) {
        say(player, S.examQuit);
        return "leave";
      }
    }
    const last = current.idx >= current.total;
    const sent = answer;
    step = await ask(player, last ? S.grading : S.thinking, () =>
      // The final answer triggers grading of all five, which can take longer.
      link.request({ t: "t.ans", pid: player.id, tid: current.tid, qid: current.q.qid, ans: sent }, last ? 120_000 : 60_000),
    );
  }
  if (!step || step.t !== "t.res") return "topic";
  return showTestResult(player, censor, step);
}

async function showTestResult(player: Player, censor: Entity, result: TestResultMsg): Promise<Next> {
  const stats = recordTest(loadStats(player), result.pass);
  let rewardText = "";
  if (result.pass) {
    const rewarded = rewardPlayer(player, stats, "test", 1, `test:${result.hash}`);
    rewardText = rewarded.text;
    react(censor, player, "happy");
    say(player, S.reactExamPass);
    world.sendMessage(S.examPassedChat(player.name, result.pct));
  } else {
    saveStats(player, stats);
    react(censor, player, "sad");
    say(player, S.reactExamFail);
  }
  const body = [
    S.examScore(result.score, result.total, result.pct),
    rewardText,
    ...result.items.map((item) => S.examItem(item.n, item.ok, item.score, item.expl)),
  ]
    .filter(Boolean)
    .join("\n\n");
  const form = new ActionFormData().title(S.examResultTitle(result.pass)).body(body).button(S.changeTopic).button(S.leave);
  const response = await showForm(player, form);
  return response?.selection === 0 ? "topic" : "leave";
}
