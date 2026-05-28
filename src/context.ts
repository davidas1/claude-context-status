import * as fs from "fs";

/**
 * Replicates the headline number that Claude Code's /context command shows.
 *
 * Source path (from the CLI): commands/context -> analyzeContextUsage ->
 * getCurrentUsage(messages). The displayed total is, verbatim:
 *
 *   total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *
 * taken from the most recent *non-synthetic* assistant message's `usage`
 * (tokens.ts getCurrentUsage / analyzeContext.ts ~line 1167). The denominator
 * is getContextWindowForModel(model): a model string containing "[1m]" -> 1,000,000,
 * otherwise the model's max input tokens, defaulting to 200,000.
 *
 * This is exact, not an approximation — it reads the same usage object the API
 * returned and the CLI itself displays.
 */

export interface ContextUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** input + cache_creation + cache_read — what /context shows as the total */
  totalTokens: number;
  contextWindow: number;
  percentage: number;
  model: string;
}

const SYNTHETIC_MODEL = "<synthetic>";

interface UsageObj {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AssistantLine {
  type?: string;
  message?: {
    model?: string;
    usage?: UsageObj;
    content?: unknown;
  };
}

/**
 * getContextWindowForModel — the subset that applies to local detection.
 *
 * Caveat: the 1M-context opt-in ("[1m]" suffix) is a runtime decision that is
 * NOT recorded in the transcript — message.model is the bare string (e.g.
 * "claude-opus-4-7"). So we cannot detect 1M from disk. `override` lets the
 * caller force the window (from a user setting); otherwise we use the model's
 * documented default of 200k. The token *count* is always exact regardless —
 * only this denominator is affected.
 */
export function contextWindowForModel(model: string, override?: number): number {
  if (override && override > 0) {
    return override;
  }
  if (/\[1m\]/i.test(model)) {
    return 1_000_000;
  }
  return 200_000;
}

/** True for synthetic assistant messages we must skip (matches getTokenUsage). */
function isSynthetic(line: AssistantLine): boolean {
  const model = line.message?.model;
  if (!model) return true;
  // SYNTHETIC_MODEL and any "<...>" placeholder model (e.g. auth-error lines).
  return model === SYNTHETIC_MODEL || model.startsWith("<");
}

/**
 * Read the tail of the transcript and find the most recent non-synthetic
 * assistant `usage`. Reading only the tail keeps this cheap even for very
 * large transcripts; we widen the window and retry if no usage is found.
 */
export function readContextUsage(
  transcriptPath: string,
  windowOverride?: number
): ContextUsage | null {
  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return null;
  }

  const windows = [256 * 1024, 2 * 1024 * 1024, size];
  for (const win of windows) {
    const start = Math.max(0, size - win);
    const text = readSlice(transcriptPath, start, size);
    if (text === null) return null;

    const result = scanForLatestUsage(text, start > 0, windowOverride);
    if (result) return result;

    if (win >= size) break; // already read whole file
  }
  return null;
}

function readSlice(file: string, start: number, end: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const length = end - start;
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

function scanForLatestUsage(
  text: string,
  dropFirstPartialLine: boolean,
  windowOverride?: number
): ContextUsage | null {
  const lines = text.split("\n");
  // If we started mid-file, the first line is likely a partial JSON fragment.
  if (dropFirstPartialLine && lines.length > 0) {
    lines.shift();
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw || raw[0] !== "{") continue;

    let obj: AssistantLine;
    try {
      obj = JSON.parse(raw) as AssistantLine;
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const usage = obj.message?.usage;
    if (!usage) continue;
    if (isSynthetic(obj)) continue;

    return buildUsage(usage, obj.message?.model ?? "", windowOverride);
  }
  return null;
}

function buildUsage(
  usage: UsageObj,
  model: string,
  windowOverride?: number
): ContextUsage {
  const inputTokens = usage.input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const totalTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  const contextWindow = contextWindowForModel(model, windowOverride);
  return {
    inputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    contextWindow,
    percentage: Math.round((totalTokens / contextWindow) * 100),
    model,
  };
}
