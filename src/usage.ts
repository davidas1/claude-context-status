import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Plan-usage (the data behind /usage): the 5h-session and 7-day rolling limits.
 * Claude Code itself reads these from an OAuth endpoint using the locally stored
 * login token. We do the same — read-only, single GET, never leaves the machine
 * beyond that one call.
 */

export interface UsageBucket {
  utilization: number; // 0-100
  resets_at: string | null;
}

export interface PlanUsage {
  five_hour?: UsageBucket | null;
  seven_day?: UsageBucket | null;
  seven_day_opus?: UsageBucket | null;
  extra_usage?: {
    is_enabled: boolean;
    monthly_limit: number;
    used_credits: number;
    utilization: number | null;
  };
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    expiresAt?: number;
  };
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function tokenFromRaw(raw: string): string | null {
  try {
    const creds = JSON.parse(raw) as ClaudeCredentials;
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

/**
 * macOS: Keychain entry "Claude Code-credentials". Linux/Windows and macOS
 * fallback: ~/.claude/.credentials.json.
 */
export function getAccessToken(): string | null {
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { stdio: ["pipe", "pipe", "pipe"] }
      )
        .toString()
        .trim();
      const token = tokenFromRaw(raw);
      if (token) return token;
    } catch {
      /* fall through to file */
    }
  }
  try {
    const raw = fs.readFileSync(
      path.join(claudeDir(), ".credentials.json"),
      "utf8"
    );
    return tokenFromRaw(raw);
  } catch {
    return null;
  }
}

export async function fetchPlanUsage(token: string): Promise<PlanUsage> {
  const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "(unreadable)");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${body}`);
  }
  return (await resp.json()) as PlanUsage;
}
