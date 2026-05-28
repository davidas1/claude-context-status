import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  pid: number;
  entrypoint: string;
  startedAt: number;
  /** mtime of the session file, used as a liveness/activity hint */
  sessionFileMtime: number;
  /** Resolved path to the JSONL transcript, if found */
  transcriptPath: string | null;
  /** mtime of the transcript — the real "last activity" signal */
  transcriptMtime: number;
  /**
   * Same title the native VS Code extension shows in its history panel and
   * chat-tab list. Sourced from the transcript's "ai-title" lines (Claude
   * generates one after the first turn). Falls back to the first user prompt
   * for fresh sessions that haven't been titled yet.
   */
  title: string | null;
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Best-effort transcript title for a session. Reads the tail for the latest
 * `ai-title` line (this is what the native extension's history panel shows);
 * if none, reads the head for the first user message and truncates that.
 */
function readSessionTitle(transcriptPath: string): string | null {
  // Tail scan for the most recent ai-title (sessions can be re-titled).
  const tail = readTail(transcriptPath, 64 * 1024);
  if (tail) {
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i].trim();
      if (!raw || raw[0] !== "{" || !raw.includes('"ai-title"')) continue;
      try {
        const o = JSON.parse(raw) as { type?: string; aiTitle?: string };
        if (o.type === "ai-title" && o.aiTitle) return o.aiTitle;
      } catch {
        /* fall through */
      }
    }
  }

  // Fallback: first user message text.
  const head = readHead(transcriptPath, 64 * 1024);
  if (head) {
    for (const line of head.split("\n")) {
      const raw = line.trim();
      if (!raw || raw[0] !== "{" || !raw.includes('"user"')) continue;
      try {
        const o = JSON.parse(raw) as {
          type?: string;
          message?: { content?: unknown };
        };
        if (o.type !== "user") continue;
        const text = extractUserText(o.message?.content);
        if (text && !isSystemWrapped(text)) return truncate(text, 80);
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/**
 * Skip first-user messages that are entirely system-injected wrappers
 * (e.g. <local-command-caveat>…, <command-name>…). These aren't the user's
 * own prompt, just CLI plumbing around slash-command runs.
 */
function isSystemWrapped(text: string): boolean {
  return /^\s*<[a-z-]+(?:\s|>)/i.test(text);
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  return null;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

function readTail(file: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    fd = fs.openSync(file, "r");
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function readHead(file: string, bytes: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.allocUnsafe(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Locate the JSONL transcript for a sessionId. The project-dir slug is a lossy
 * transform of cwd (/, _ and . all become -), so we can't reliably rebuild it.
 * Instead we search every project dir for {sessionId}.jsonl — the UUID is unique.
 */
function findTranscript(sessionId: string): string | null {
  const projectsRoot = path.join(claudeDir(), "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** A session is considered live if its pid is still running. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive)
    return err && err.code === "EPERM";
  }
}

export function listSessions(): SessionInfo[] {
  const sessionsDir = path.join(claudeDir(), "sessions");
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const file of files) {
    const full = path.join(sessionsDir, file);
    const raw = readJsonSafe<{
      sessionId?: string;
      cwd?: string;
      pid?: number;
      entrypoint?: string;
      startedAt?: number;
    }>(full);
    if (!raw?.sessionId || !raw.cwd || typeof raw.pid !== "number") {
      continue;
    }
    if (!isPidAlive(raw.pid)) {
      continue;
    }

    let sessionFileMtime = 0;
    try {
      sessionFileMtime = fs.statSync(full).mtimeMs;
    } catch {
      /* ignore */
    }

    const transcriptPath = findTranscript(raw.sessionId);
    let transcriptMtime = 0;
    let title: string | null = null;
    if (transcriptPath) {
      try {
        transcriptMtime = fs.statSync(transcriptPath).mtimeMs;
      } catch {
        /* ignore */
      }
      title = readSessionTitle(transcriptPath);
    }

    sessions.push({
      sessionId: raw.sessionId,
      cwd: raw.cwd,
      pid: raw.pid,
      entrypoint: raw.entrypoint ?? "unknown",
      startedAt: raw.startedAt ?? 0,
      sessionFileMtime,
      transcriptPath,
      transcriptMtime,
      title,
    });
  }
  return sessions;
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\/+$/, "");
}

/** True if `cwd` is inside (or equal to) one of the workspace folders. */
function matchesWorkspace(cwd: string, workspaceFolders: string[]): boolean {
  const c = normalize(cwd);
  return workspaceFolders.some((wf) => {
    const w = normalize(wf);
    return c === w || c.startsWith(w + path.sep);
  });
}

/**
 * Rank candidate sessions for a given set of workspace folders.
 * Sessions whose cwd matches the workspace come first, each group ordered by
 * most-recent transcript activity. When no workspace is given, all live
 * sessions are returned ordered by activity.
 */
export function rankSessions(
  sessions: SessionInfo[],
  workspaceFolders: string[]
): SessionInfo[] {
  const byActivity = (a: SessionInfo, b: SessionInfo) =>
    (b.transcriptMtime || b.sessionFileMtime) -
    (a.transcriptMtime || a.sessionFileMtime);

  if (workspaceFolders.length === 0) {
    return [...sessions].sort(byActivity);
  }

  const inWorkspace = sessions
    .filter((s) => matchesWorkspace(s.cwd, workspaceFolders))
    .sort(byActivity);
  const rest = sessions
    .filter((s) => !matchesWorkspace(s.cwd, workspaceFolders))
    .sort(byActivity);

  return [...inWorkspace, ...rest];
}

/**
 * Human-friendly label: the AI-generated title (what the native extension
 * shows in its history panel and tab list). Falls back to the cwd basename
 * when the session is too new to have a title yet.
 */
export function sessionLabel(s: SessionInfo): string {
  if (s.title) return s.title;
  return path.basename(s.cwd) || s.cwd;
}

export function sessionDetail(s: SessionInfo): string {
  const last = s.transcriptMtime || s.sessionFileMtime;
  const ago = last ? relativeTime(last) : "no activity";
  const folder = path.basename(s.cwd) || s.cwd;
  return `${folder} · ${ago} · pid ${s.pid}`;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
