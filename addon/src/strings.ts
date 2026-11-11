/**
 * Every player-facing string of the add-on lives in this file (English, LTR).
 * To localize later, swap this object; nothing else contains UI text.
 * "§" codes are Minecraft colour codes (§e yellow, §a green, §c red, §7 gray, §r reset).
 */

export const TOPICS = ["Calculus 1", "Linear Algebra", "C Fundamentals"] as const;

export const S = {
  name: "Prof. Censor",
  say: (text: string) => `§e<Prof. Censor>§r ${text}`,

  // ---- link / connection ---------------------------------------------------
  notConnected: (port: string) => [
    "My notes are out of reach - the companion app is not connected.",
    "§71. On your PC, in the CensorCraft folder, run: §fpnpm start",
    `§72. In Minecraft chat, type: §f/connect ws://localhost:${port}`,
    "§73. Cheats must be on, and 'Require Encrypted WebSockets' must be off (Settings > General).",
    "§7Then talk to me again.",
  ],
  defaultPort: "8765",
  linkLost: "I lost the connection to my notes mid-thought. Reconnect the companion app and talk to me again.",
  timedOut: "That took me far too long - something is wrong with my notes. Please try again in a moment.",
  undelivered: "I could not get my request through to the companion app. Is it still running?",
  busy: "One question at a time, please!",
  goodbye: "Class dismissed. Come back any time!",
  errorPrefix: "Hmm. ",

  // ---- forms -----------------------------------------------------------------
  topicTitle: "Professor Censor",
  topicBody: (stats: string) => `What shall we study today?\n\n§7${stats}`,
  topicCustom: "Custom topic...",
  customTitle: "Custom topic",
  customLabel: "Which topic do you want to study?",
  customPlaceholder: "e.g. Probability, Pointers in C, Eigenvalues",
  customSubmit: "Study",
  customEmpty: "You did not name a topic.",

  difficultyTitle: (topic: string) => topic,
  difficultyBody: (lines: string[], status: string) => `Choose a difficulty.\n\n${lines.join("\n")}\n\n§7${status}`,
  difficultyNames: { easy: "Easy", medium: "Medium", hard: "Hard", test: "Test (5 questions)" },
  difficultyLine: (name: string, preview: string) => `§l${name}§r: ${preview}`,
  testLine: (preview: string) => `§lTest§r: 5 mixed questions, no feedback until the end, pass at 80%.\n   Reward for passing: ${preview}`,
  statusLine: (rewardsLeft: number, cooldown: number) =>
    `Rewards left today: ${rewardsLeft}` + (cooldown > 0 ? ` | next reward possible in ${cooldown}s` : ""),

  thinking: (dots: string) => `§eProf. Censor is thinking${dots}`,
  grading: (dots: string) => `§eProf. Censor is grading${dots}`,

  questionTitle: (difficulty: string) => `Question - ${difficulty}`,
  examQuestionTitle: (index: number, total: number) => `Exam - question ${index} of ${total}`,
  fromMaterial: "§7(from your course material)§r",
  fromSyllabus: "§7(from the standard syllabus)§r",
  optionLabel: (letter: string, text: string) => `${letter}) ${text}`,
  answerLabel: "Your answer",
  codeLabel: "Your code (one line)",
  // Placeholders double as typing help: players have a keyboard, not a math palette.
  mathHint: "use sqrt(), ^ for powers, pi, inf, <=, 1/2",
  codeHint: "one line of C, e.g. int f(int x){return 2*x;}",
  submit: "Submit",

  verdictCorrect: "Correct!",
  verdictPartial: (percent: number) => `Partial credit (${percent}%)`,
  verdictWrong: "Not quite",
  rewardGranted: (items: string, xp: number) => `§aReward:§r ${items}${xp > 0 ? ` and ${xp} XP level${xp === 1 ? "" : "s"}` : ""}`,
  rewardDenied: {
    incorrect: "",
    duplicate: "§7No reward: you have already answered this question.",
    daily_cap: "§7No reward: you reached today's reward limit. Studying still counts!",
    cooldown: (seconds: number) => `§7No reward: rewards are on cooldown for another ${seconds}s.`,
  },
  statsLine: (correct: number, answered: number, streak: number, best: number) =>
    `Correct: ${correct}/${answered} | Streak: ${streak} (best ${best})`,
  statsWithTests: (line: string, passed: number, taken: number) => (taken > 0 ? `${line} | Exams passed: ${passed}/${taken}` : line),
  next: "Next question",
  changeTopic: "Change topic",
  leave: "Leave",

  examIntro: "Exam time: 5 questions, mixed difficulty. No feedback until the end. You pass at 80%. Good luck!",
  quitExamTitle: "Quit the exam?",
  quitExamBody: "If you quit now, your progress in this exam is lost and there is no reward.",
  quitExamKeep: "Keep going",
  quitExamQuit: "Quit exam",
  examQuit: "Exam abandoned. Come back when you are ready.",
  examResultTitle: (passed: boolean) => (passed ? "Exam passed!" : "Exam not passed"),
  examScore: (score: number, total: number, percent: number) => `Score: ${score} / ${total} (${percent}%). You need 80% to pass.`,
  examItem: (n: number, ok: boolean, score: number, explanation: string) =>
    `${ok ? "§a[OK]" : score > 0 ? `§e[${Math.round(score * 100)}%]` : "§c[X]"}§r Q${n}: ${explanation}`,
  examPassedChat: (name: string, percent: number) => `§6${name} passed Professor Censor's exam with ${percent}%!`,

  // ---- Censor's reactions ------------------------------------------------------
  reactCorrect: ["Excellent!", "Precisely right.", "Now that is what I call rigor!", "Correct - well reasoned.", "Splendid work!"],
  reactStreak: (n: number) => `That is ${n} in a row. Keep going!`,
  reactPartial: ["You are on the right track.", "Close - the idea is there.", "Partly right. Mind the details."],
  reactWrong: ["Not quite. Read the explanation and try another.", "Hmm, no. Every mistake is a lesson.", "Incorrect - but now you know why."],
  reactExamPass: "Outstanding! You have earned this.",
  reactExamFail: "Not this time. Review the explanations and try again.",

  // ---- claiming ------------------------------------------------------------------
  claimed: "A whiteboard! At last, a place to teach.",
  boardGone: "My whiteboard is gone...",
  noRoom: "§cA whiteboard needs a free space 3 blocks wide and 2 blocks high.",

  // ---- debug -----------------------------------------------------------------------
  glyphIntro: "§e[CensorCraft glyph test]§r Every allowlisted symbol is printed below. Anything that shows as a box or blank is unsupported: remove it from shared/glyphs.json.",
  glyphSample: "Sample: ∫₀¹ x² dx, √(x²+1), A⁻¹, x ≤ 3, ∑ᵢ₌₁ⁿ i, λ π θ ∞ → ∈ ≠ ≈",
  glyphNote: "§7Forms use the same font as chat. Debug tool only.",
};

export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}
