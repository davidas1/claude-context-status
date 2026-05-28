import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { readContextUsage, ContextUsage } from "./context";
import {
  listSessions,
  rankSessions,
  sessionDetail,
  sessionLabel,
  SessionInfo,
} from "./sessions";
import { fetchPlanUsage, getAccessToken, PlanUsage, UsageBucket } from "./usage";

let statusBarItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let usageTimer: NodeJS.Timeout | undefined;

/** Active fs watchers; rebuilt whenever the tracked transcript changes. */
let transcriptWatcher: fs.FSWatcher | undefined;
let sessionsDirWatcher: fs.FSWatcher | undefined;
let watchedTranscriptPath: string | undefined;

/** sessionId the user explicitly pinned via the picker, if any. */
let pinnedSessionId: string | undefined;
let lastPlanUsage: PlanUsage | null = null;
let lastPlanUsageError: string | null = null;

/** Token count from the previous render — used for per-turn delta. */
let previousTokens: number | undefined;
let previousSessionId: string | undefined;
let lastDelta: number | undefined;

function cfg() {
  const c = vscode.workspace.getConfiguration("claudeContext");
  return {
    refreshIntervalSeconds: c.get<number>("refreshIntervalSeconds", 5),
    usageRefreshIntervalSeconds: c.get<number>(
      "usageRefreshIntervalSeconds",
      120
    ),
    showPlanUsage: c.get<boolean>("showPlanUsage", true),
    warnAtTokens: c.get<number>("warnAtTokens", 100_000),
    dangerAtTokens: c.get<number>("dangerAtTokens", 150_000),
    contextDisplay: c.get<"tokens" | "percent" | "both">(
      "contextDisplay",
      "tokens"
    ),
    contextLimit: c.get<number>("contextLimit", 200_000),
  };
}

function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function pickActiveSession(): SessionInfo | undefined {
  const ranked = rankSessions(listSessions(), workspaceFolders());
  if (pinnedSessionId) {
    const pinned = ranked.find((s) => s.sessionId === pinnedSessionId);
    if (pinned) return pinned;
    pinnedSessionId = undefined;
  }
  return ranked[0];
}

type Severity = "ok" | "warn" | "danger";

function severityFor(tokens: number): Severity {
  const { warnAtTokens, dangerAtTokens } = cfg();
  if (tokens >= dangerAtTokens) return "danger";
  if (tokens >= warnAtTokens) return "warn";
  return "ok";
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

/** Format the context size per the user's display preference. */
function fmtContext(tokens: number): string {
  const { contextDisplay, contextLimit } = cfg();
  const limit = Math.max(1, contextLimit);
  const pct = Math.round((tokens / limit) * 100);
  switch (contextDisplay) {
    case "percent":
      return `${pct}%`;
    case "both":
      return `${fmtTokens(tokens)} · ${pct}%`;
    default:
      return fmtTokens(tokens);
  }
}

// statusBarItem.color uses a general ThemeColor; the statusBarItem.*Foreground
// theme keys only apply when the matching backgroundColor is set, and we don't
// want to recolor the whole bar item — so use the general fore/error colors.
const STATUS_WARN_COLOR = new vscode.ThemeColor("list.warningForeground");
const STATUS_DANGER_COLOR = new vscode.ThemeColor("list.errorForeground");
// Bar colors in the tooltip (match the existing usage extension's palette).
const BAR_OK = "#4EC9B0";
const BAR_WARN = "#cca700";
const BAR_DANGER = "#f44747";

function severityColor(sev: Severity): string {
  switch (sev) {
    case "danger":
      return BAR_DANGER;
    case "warn":
      return BAR_WARN;
    default:
      return BAR_OK;
  }
}

function severityIcon(sev: Severity): string {
  switch (sev) {
    case "danger":
      return "$(error)";
    case "warn":
      return "$(warning)";
    default:
      return "";
  }
}

function render() {
  const { showPlanUsage } = cfg();
  const session = pickActiveSession();

  if (!session) {
    statusBarItem.text = "$(pulse) Claude —";
    statusBarItem.color = undefined;
    statusBarItem.tooltip = buildTooltip(undefined, undefined);
    statusBarItem.show();
    return;
  }

  const ctx = session.transcriptPath
    ? readContextUsage(session.transcriptPath)
    : null;
  const sev = ctx ? severityFor(ctx.totalTokens) : "ok";

  // Per-turn delta: compare to the previous count from the *same* session.
  if (ctx) {
    if (previousSessionId === session.sessionId && previousTokens !== undefined) {
      const diff = ctx.totalTokens - previousTokens;
      // Only show meaningful jumps; new-turn growth is usually >100 tokens.
      lastDelta = Math.abs(diff) >= 100 ? diff : lastDelta;
    } else {
      lastDelta = undefined;
    }
    previousSessionId = session.sessionId;
    previousTokens = ctx.totalTokens;
  }

  const parts: string[] = ["$(pulse)"];
  if (ctx) {
    const icon = severityIcon(sev);
    const deltaStr =
      lastDelta !== undefined && lastDelta !== 0
        ? ` ${lastDelta > 0 ? "+" : "−"}${fmtTokens(Math.abs(lastDelta))}`
        : "";
    parts.push(
      `${icon ? icon + " " : ""}ctx ${fmtContext(ctx.totalTokens)}${deltaStr}`
    );
  } else {
    parts.push("ctx —");
  }

  if (showPlanUsage && lastPlanUsage) {
    const s = lastPlanUsage.five_hour;
    const w = lastPlanUsage.seven_day;
    const seg: string[] = [];
    if (s) seg.push(`S:${Math.round(s.utilization)}%`);
    if (w) seg.push(`W:${Math.round(w.utilization)}%`);
    if (seg.length) parts.push("│ " + seg.join(" "));
  }

  statusBarItem.text = parts.join(" ");
  statusBarItem.color =
    sev === "danger"
      ? STATUS_DANGER_COLOR
      : sev === "warn"
        ? STATUS_WARN_COLOR
        : undefined;
  statusBarItem.tooltip = buildTooltip(session, ctx);
  statusBarItem.show();
}

function listSessionsRanked(): SessionInfo[] {
  return rankSessions(listSessions(), workspaceFolders());
}

/**
 * A horizontal bar of `width` cells. `fillRatio` (0..1) of the cells are
 * colored with `fillColor`; the remainder are the dimmer track color.
 */
function htmlBar(fillRatio: number, fillColor: string, width = 20): string {
  const clamped = Math.max(0, Math.min(1, fillRatio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const fill =
    filled > 0
      ? `<span style="color:${fillColor};">${"█".repeat(filled)}</span>`
      : "";
  const track =
    empty > 0 ? `<span style="color:#555;">${"█".repeat(empty)}</span>` : "";
  return fill + track;
}

function buildTooltip(
  session: SessionInfo | undefined,
  ctx: ContextUsage | null | undefined
): vscode.MarkdownString {
  const { dangerAtTokens, warnAtTokens } = cfg();
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.supportHtml = true;
  md.isTrusted = true;

  if (!session) {
    md.appendMarkdown("### Claude Code — Context\n\n");
    md.appendMarkdown("_No live Claude Code session found._\n\n");
    appendActions(md, 0);
    return md;
  }

  // === Header ===
  const pinned = pinnedSessionId === session.sessionId;
  const pinIcon = pinned ? " $(pinned)" : "";
  md.appendMarkdown(
    `$(comment-discussion) &nbsp; **${escape(sessionLabel(session))}**${pinIcon}\n\n`
  );
  const modelSuffix = ctx ? ` &nbsp;·&nbsp; \`${ctx.model}\`` : "";
  md.appendMarkdown(`_${escape(session.cwd)}_${modelSuffix}\n\n`);

  // === Context section ===
  if (ctx) {
    const sev = severityFor(ctx.totalTokens);
    const color = severityColor(sev);
    const ratio = ctx.totalTokens / Math.max(1, dangerAtTokens);

    const badge =
      sev === "danger"
        ? ` &nbsp; $(error) over ${fmtTokens(dangerAtTokens)}`
        : sev === "warn"
          ? ` &nbsp; $(warning) over ${fmtTokens(warnAtTokens)}`
          : "";

    md.appendMarkdown(
      `$(symbol-numeric) &nbsp; **${ctx.totalTokens.toLocaleString()} tokens**${badge}\n\n`
    );
    md.appendMarkdown(
      `${htmlBar(ratio, color, 24)} &nbsp; toward ${fmtTokens(dangerAtTokens)}\n\n`
    );

    md.appendMarkdown("| segment | tokens |\n|---|---:|\n");
    md.appendMarkdown(`| input | ${ctx.inputTokens.toLocaleString()} |\n`);
    md.appendMarkdown(
      `| cache-read | ${ctx.cacheReadTokens.toLocaleString()} |\n`
    );
    md.appendMarkdown(
      `| cache-create | ${ctx.cacheCreationTokens.toLocaleString()} |\n\n`
    );
  } else {
    md.appendMarkdown(
      "_No usage recorded yet for this session (waiting for first response)._\n\n"
    );
  }

  // === Plan section ===
  md.appendMarkdown("---\n\n**$(pulse) Plan**\n\n");
  if (lastPlanUsage) {
    appendBucketRow(md, "Session 5h", lastPlanUsage.five_hour);
    appendBucketRow(md, "Weekly 7d ", lastPlanUsage.seven_day);
    if (lastPlanUsage.seven_day_opus) {
      appendBucketRow(md, "Opus 7d   ", lastPlanUsage.seven_day_opus);
    }
    const extra = lastPlanUsage.extra_usage;
    if (extra?.is_enabled) {
      md.appendMarkdown(
        `Extra &nbsp; ${extra.used_credits} / ${extra.monthly_limit} credits\n\n`
      );
    }
  } else if (lastPlanUsageError) {
    md.appendMarkdown(`_unavailable: ${escape(lastPlanUsageError)}_\n\n`);
  } else {
    md.appendMarkdown("_loading…_\n\n");
  }

  appendActions(md, listSessionsRanked().length);
  return md;
}

function appendBucketRow(
  md: vscode.MarkdownString,
  heading: string,
  bucket: UsageBucket | null | undefined
) {
  if (!bucket) return;
  const util = Math.round(bucket.utilization);
  const color =
    util >= 90 ? BAR_DANGER : util >= 60 ? BAR_WARN : BAR_OK;
  const bar = htmlBar(util / 100, color, 16);
  const reset = formatReset(bucket.resets_at);
  md.appendMarkdown(
    `\`${heading}\` &nbsp; ${bar} &nbsp; **${util}%** &nbsp;·&nbsp; ${reset}\n\n`
  );
}

function formatReset(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime() - Date.now();
  if (t <= 0) return "resetting…";
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `resets in ${d}d ${rh}h`;
  }
  return `resets in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

function appendActions(md: vscode.MarkdownString, sessionCount: number) {
  md.appendMarkdown("---\n\n");
  const parts: string[] = [];
  if (sessionCount > 1) {
    parts.push(
      `[$(list-unordered) Switch session (${sessionCount})](command:claudeContext.switchSession)`
    );
  }
  if (pinnedSessionId) {
    parts.push(`[$(pin) Unpin](command:claudeContext.unpin)`);
  }
  parts.push(`[$(refresh) Refresh](command:claudeContext.refresh)`);
  parts.push(`[$(gear) Settings](command:claudeContext.openSettings)`);
  md.appendMarkdown(parts.join(" &nbsp;·&nbsp; "));
}

function escape(s: string): string {
  // Minimal markdown escape — paths/titles can contain underscores etc.
  return s.replace(/([\\`*_{}\[\]()#+\-!])/g, "\\$1");
}

async function refreshPlanUsage() {
  if (!cfg().showPlanUsage) {
    lastPlanUsage = null;
    return;
  }
  const token = getAccessToken();
  if (!token) {
    lastPlanUsage = null;
    lastPlanUsageError = "not logged in to Claude Code";
    return;
  }
  try {
    lastPlanUsage = await fetchPlanUsage(token);
    lastPlanUsageError = null;
  } catch (err) {
    lastPlanUsageError = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function switchSession() {
  const sessions = listSessionsRanked();
  if (sessions.length === 0) {
    vscode.window.showInformationMessage("No live Claude Code sessions found.");
    return;
  }
  const items = sessions.map((s) => {
    const ctx = s.transcriptPath ? readContextUsage(s.transcriptPath) : null;
    return {
      label: `$(comment-discussion) ${sessionLabel(s)}`,
      description: ctx ? `ctx ${fmtContext(ctx.totalTokens)}` : "no usage yet",
      detail: sessionDetail(s),
      sessionId: s.sessionId,
    };
  });
  const choice = await vscode.window.showQuickPick(items, {
    title: "Track which Claude Code session?",
    placeHolder: "Pick the session this status bar should follow",
  });
  if (choice) {
    pinnedSessionId = choice.sessionId;
    // Reset the delta baseline so the new session doesn't show a misleading
    // diff against the previous session's count.
    previousSessionId = undefined;
    previousTokens = undefined;
    lastDelta = undefined;
    ensureWatchers();
    render();
  }
}

/**
 * Watch the active transcript so renders happen the moment a new line is
 * appended (i.e. the model responded). Plus a slow fallback poll in case the
 * watcher misses an event (network FSes, rename races).
 */
function ensureWatchers() {
  const session = pickActiveSession();
  const target = session?.transcriptPath ?? undefined;

  if (target !== watchedTranscriptPath) {
    if (transcriptWatcher) {
      transcriptWatcher.close();
      transcriptWatcher = undefined;
    }
    watchedTranscriptPath = target;
    if (target) {
      try {
        transcriptWatcher = fs.watch(target, { persistent: false }, () => {
          // Debounced via a microtask; render() is cheap (tail read).
          queueMicrotask(render);
        });
        transcriptWatcher.on("error", () => {
          /* swallow; the poll fallback will pick up */
        });
      } catch {
        // file disappeared mid-watch; ignored — render() will recover.
      }
    }
  }

  if (!sessionsDirWatcher) {
    const dir = path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
      "sessions"
    );
    try {
      sessionsDirWatcher = fs.watch(dir, { persistent: false }, () => {
        // New/removed session — re-evaluate which is active and rearm.
        queueMicrotask(() => {
          ensureWatchers();
          render();
        });
      });
      sessionsDirWatcher.on("error", () => {
        /* ignore — handled by poll */
      });
    } catch {
      /* sessions dir might not exist yet */
    }
  }
}

function restartPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  // Slow fallback: catches missed watcher events and rescans live sessions.
  const seconds = Math.max(5, cfg().refreshIntervalSeconds * 6);
  pollTimer = setInterval(() => {
    ensureWatchers();
    render();
  }, seconds * 1000);
}

function restartUsageTimer() {
  if (usageTimer) clearInterval(usageTimer);
  usageTimer = setInterval(
    refreshPlanUsage,
    Math.max(30, cfg().usageRefreshIntervalSeconds) * 1000
  );
}

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "claudeContext.switchSession";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeContext.switchSession",
      switchSession
    ),
    vscode.commands.registerCommand("claudeContext.refresh", async () => {
      await refreshPlanUsage();
      render();
    }),
    vscode.commands.registerCommand("claudeContext.openSettings", () => {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:davidas1.claude-context-status"
      );
    }),
    vscode.commands.registerCommand("claudeContext.unpin", () => {
      if (!pinnedSessionId) {
        vscode.window.showInformationMessage(
          "No session is pinned — already auto-picking most recent."
        );
        return;
      }
      pinnedSessionId = undefined;
      previousSessionId = undefined;
      previousTokens = undefined;
      lastDelta = undefined;
      ensureWatchers();
      render();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeContext")) {
        restartPollTimer();
        restartUsageTimer();
        void refreshPlanUsage();
        render();
      }
    })
  );

  render();
  void refreshPlanUsage();
  ensureWatchers();
  restartPollTimer();
  restartUsageTimer();
}

export function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  if (usageTimer) clearInterval(usageTimer);
  if (transcriptWatcher) transcriptWatcher.close();
  if (sessionsDirWatcher) sessionsDirWatcher.close();
}
