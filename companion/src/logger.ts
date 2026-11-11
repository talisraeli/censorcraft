const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

/**
 * Tiny console logger. Every line is passed through a redactor so that an API
 * key can never be printed, even if a provider echoes it inside an error.
 */
export class Logger {
  private secrets: string[] = [];

  constructor(
    private level: LogLevel = "info",
    private readonly sink: (line: string) => void = (line) => console.log(line),
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Register a secret; any occurrence is replaced with [REDACTED] in all output. */
  addSecret(secret: string | undefined): void {
    if (secret && secret.length >= 6) this.secrets.push(secret);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[REDACTED]");
    // Generic safety net for key-looking tokens.
    return out.replace(/\b(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, "$1…[REDACTED]").replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza…[REDACTED]");
  }

  debug(msg: string): void {
    this.write("debug", msg);
  }
  info(msg: string): void {
    this.write("info", msg);
  }
  warn(msg: string): void {
    this.write("warn", msg);
  }
  error(msg: string): void {
    this.write("error", msg);
  }

  private write(level: LogLevel, msg: string): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const time = new Date().toTimeString().slice(0, 8); // local time
    this.sink(`${time} ${level.toUpperCase().padEnd(5)} ${this.redact(msg)}`);
  }
}

export const silentLogger = new Logger("error", () => {});
