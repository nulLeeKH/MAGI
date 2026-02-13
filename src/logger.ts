const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: number =
  LEVELS[(Deno.env.get("LOG_LEVEL")?.toUpperCase() as Level)] ?? LEVELS.INFO;

function fmt(
  level: Level,
  tag: string,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  const fn = level === "ERROR"
    ? console.error
    : level === "WARN"
    ? console.warn
    : console.log;
  fn(`${ts} [${level}] [${tag}] ${msg}${metaStr}`);
}

export const log = {
  debug: (tag: string, msg: string, meta?: Record<string, unknown>) =>
    fmt("DEBUG", tag, msg, meta),
  info: (tag: string, msg: string, meta?: Record<string, unknown>) =>
    fmt("INFO", tag, msg, meta),
  warn: (tag: string, msg: string, meta?: Record<string, unknown>) =>
    fmt("WARN", tag, msg, meta),
  error: (tag: string, msg: string, meta?: Record<string, unknown>) =>
    fmt("ERROR", tag, msg, meta),
};
