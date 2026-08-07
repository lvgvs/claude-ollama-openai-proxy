#!/usr/bin/env node
/*
 * claude-gateway - exposes the Claude Code CLI as both an OpenAI-compatible
 * and an Ollama-compatible HTTP API.
 *
 *   :3456   OpenAI  ->  /v1/models, /v1/chat/completions, /v1/usage, /health
 *   :11434  Ollama  ->  /api/tags, /api/chat, /api/generate, /api/show, ...
 *
 * Zero npm dependencies. Requires Node 22+ (core modules only).
 *
 * NOTE: this file deliberately contains no dollar signs - no template
 * literals, no regex end anchors. It is embedded inside a docker compose
 * YAML file, and compose treats dollar-brace expressions as its own
 * variables and substitutes them.
 */

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// -------------------------------------------------------------- configuration

function envInt(name, fallback) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function envList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback || [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function envJsonArray(name) {
  try {
    const v = JSON.parse(process.env[name] || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

// Aliases are the default on purpose: in Claude Code "opus", "sonnet" and
// "haiku" always resolve to the current model of that tier, so a new Anthropic
// release needs no config change here. Pin an exact id (claude-opus-5) instead
// if you want a fixed version - resolveModel accepts both forms.
const DEFAULT_MODELS = ["opus", "sonnet", "haiku"];

const CFG = {
  openaiPort: envInt("OPENAI_PORT", 3456),
  ollamaPort: envInt("OLLAMA_PORT", 11434),
  bind: process.env.BIND_ADDRESS || "0.0.0.0",

  claudeBin: process.env.CLAUDE_BIN || "claude",
  // Extra arguments placed before ours on every spawn. Lets the test suite
  // point at a stub CLI without patching this file.
  claudeBinArgs: envJsonArray("CLAUDE_BIN_ARGS"),

  models: envList("CLAUDE_MODELS", DEFAULT_MODELS),
  defaultModel: process.env.DEFAULT_CLAUDE_MODEL || "sonnet",

  // Manual override for /api/version. Normally left empty: the version is
  // echoed back from the client's own User-Agent header (see versionFor).
  ollamaVersion: process.env.OLLAMA_VERSION || "",

  // Reasoning effort. Empty means the CLI decides. Overridable per request
  // through three paths - see effortFor.
  defaultEffort: (process.env.DEFAULT_EFFORT || "").toLowerCase(),
  // Whether effort variants also appear in the advertised model list.
  effortTags: envList("EFFORT_TAGS", []).map((t) => t.toLowerCase()),

  apiKeys: envList("API_KEYS", []),

  workdir: process.env.CLAUDE_WORKDIR || "/opt/app/work",
  stateDir: process.env.STATE_DIR || "/opt/app/state",

  useSessions: process.env.ENABLE_SESSIONS !== "0",
  useToolCalls: process.env.ENABLE_TOOL_CALLS !== "0",

  // Image support does two things: advertises the "vision" capability so
  // clients send images as message content, and forwards those images to the
  // CLI as real image blocks. No tool is enabled for this.
  enableVision: process.env.ENABLE_VISION !== "0",
  maxImages: envInt("MAX_IMAGES_PER_REQUEST", 8),

  timeoutMs: envInt("REQUEST_TIMEOUT_MS", 600000),
  sessionTtlMs: envInt("SESSION_TTL_HOURS", 24) * 3600000,

  // Claude Code writes a full plaintext transcript of every session. Those
  // files are what makes conversation continuity possible, but nothing in the
  // CLI ever removes them, so they grow without bound. Transcripts older than
  // this window are deleted. Set to 0 to keep everything forever.
  transcriptRetentionMs: envInt("TRANSCRIPT_RETENTION_HOURS", 72) * 3600000,
  transcriptDir: process.env.TRANSCRIPT_DIR || path.join(os.homedir(), ".claude", "projects"),

  maxBodyBytes: envInt("MAX_BODY_MB", 32) * 1024 * 1024,
  lookbackDepth: envInt("SESSION_LOOKBACK", 6),
  debug: process.env.DEBUG === "1",
};

// Both protocols are served on both ports, so the Ollama endpoints have to be
// protected too whenever API_KEYS is set - otherwise a request could simply
// use /api/chat to sidestep the key. Set PROTECT_OLLAMA to "0" to deliberately
// leave them open, which some Ollama clients need since that protocol has no
// authentication header of its own.
CFG.protectOllama = CFG.apiKeys.length > 0 && process.env.PROTECT_OLLAMA !== "0";

function log(...args) {
  console.log("[gateway]", ...args);
}
function dbg(...args) {
  if (CFG.debug) console.log("[debug]", ...args);
}

// ------------------------------------------------------------ CLI flag probing

// Flag names differ between Claude Code releases. We read --help once at
// startup and only pass flags that actually exist, so an older or newer CLI
// degrades gracefully instead of failing on an unknown option.
const FLAGS = { help: "", has: () => false };

function claudeSpawnSync(extraArgs) {
  return spawnSync(CFG.claudeBin, CFG.claudeBinArgs.concat(extraArgs), { encoding: "utf8" });
}

function probeCli() {
  const ver = claudeSpawnSync(["--version"]);
  if (ver.error) {
    console.error("[gateway] FATAL: '" + CFG.claudeBin + "' not found. Is Claude Code installed?");
    process.exit(1);
  }
  const help = claudeSpawnSync(["--help"]);
  FLAGS.help = (help.stdout || "") + (help.stderr || "");
  FLAGS.has = (flag) => FLAGS.help.includes(flag);
  log("Claude CLI:", (ver.stdout || "").trim() || "version unreadable");

  if (!FLAGS.has("--tools") && !FLAGS.has("--disallowedTools")) {
    console.error(
      "[gateway] WARNING: no flag available to disable built-in tools. " +
        "The model could run commands inside this container. Update Claude Code."
    );
  }

  log(
    "Flags supported by the CLI:",
    ["--tools", "--disallowedTools", "--effort", "--input-format", "--strict-mcp-config", "--resume", "--session-id"]
      .filter((f) => FLAGS.has(f))
      .join(" ") || "(none)"
  );

  // The line above lists what the CLI supports; the line below lists what we
  // actually send on every request. Keeping them separate avoids the confusion
  // of seeing a supported-but-unused flag and assuming it is in play.
  log(
    "Flags sent on every request:",
    buildArgs({
      model: CFG.defaultModel,
      effort: normalizeEffort(CFG.defaultEffort),
      systemPrompt: null,
      sessionId: "00000000-0000-0000-0000-000000000000",
      resume: null,
    }).join(" ")
  );
}

// When a request carries images we send a structured message instead of a
// plain-text prompt, so the image reaches the model as a real image block.
// buildArgs and runClaude must agree on this, hence one shared predicate.
function usesJsonInput(opts) {
  return Boolean(opts.blocks && opts.blocks.length && FLAGS.has("--input-format"));
}

function buildArgs(opts) {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    opts.model,
  ];

  if (opts.effort && FLAGS.has("--effort")) args.push("--effort", opts.effort);

  // Disable the built-in tools. This gateway is a chat endpoint, not an agent:
  // text arriving from a client must never turn into command execution.
  if (FLAGS.has("--tools")) args.push("--tools", "");
  else if (FLAGS.has("--disallowedTools")) args.push("--disallowedTools", "*");

  if (FLAGS.has("--strict-mcp-config")) args.push("--strict-mcp-config");
  if (usesJsonInput(opts)) args.push("--input-format", "stream-json");

  // --bare is deliberately NOT used. It skips hook/skill/plugin/CLAUDE.md
  // discovery to start faster, but on Claude Code 2.1.223 it also skips
  // reading the stored credentials: every request comes back "Not logged in".
  // There is nothing to discover in this container anyway, so there is no
  // speed-up to gain. Test carefully before adding it back.

  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

  if (opts.resume && FLAGS.has("--resume")) {
    args.push("--resume", opts.resume);
  } else if (opts.sessionId && FLAGS.has("--session-id")) {
    args.push("--session-id", opts.sessionId);
  } else if (FLAGS.has("--no-session-persistence")) {
    args.push("--no-session-persistence");
  }

  return args;
}

// ------------------------------------------------------- transcript pruning

/*
 * Deletes Claude Code session transcripts older than the retention window.
 *
 * Only files ending in .jsonl under the transcripts directory are ever
 * touched. Credentials, settings and every other file in ~/.claude are left
 * alone, so signing in stays permanent.
 *
 * The window is never shorter than the session TTL: a transcript that is
 * still reachable through the fingerprint table cannot be removed. Even if
 * one were, the gateway falls back to replaying the full history, so the
 * worst case is a slower turn rather than a failed one.
 */
function pruneTranscripts() {
  if (!CFG.transcriptRetentionMs) return;

  let stat;
  try {
    stat = fs.statSync(CFG.transcriptDir);
  } catch (e) {
    return; // nothing written yet
  }
  if (!stat.isDirectory()) return;

  const cutoff = Date.now() - Math.max(CFG.transcriptRetentionMs, CFG.sessionTtlMs);
  let removed = 0;
  let freed = 0;

  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        try {
          fs.rmdirSync(full); // succeeds only if the folder is now empty
        } catch (e) {
          /* still has content, leave it */
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const s = fs.statSync(full);
        if (s.mtimeMs >= cutoff) continue;
        fs.unlinkSync(full);
        removed++;
        freed += s.size;
      } catch (e) {
        /* vanished or locked, skip */
      }
    }
  };

  walk(CFG.transcriptDir);
  if (removed) {
    log("Pruned " + removed + " transcript file(s), " + Math.round(freed / 1024) + " KB freed");
  }
}

// --------------------------------------------------------------- CLI process

// The system prompt carries client-supplied instructions and tool schemas, so
// it is replaced with a length marker before logging. Only the log line is
// affected; the argument actually passed to the CLI is unchanged.
function redactArgs(args) {
  const out = args.slice();
  const i = out.indexOf("--append-system-prompt");
  if (i !== -1 && i + 1 < out.length) {
    out[i + 1] = "[system-prompt " + String(out[i + 1]).length + " chars]";
  }
  return out;
}

// Runs one claude invocation. Partial text is delivered through onDelta.
// Resolves to { text, sessionId, usage, isError, errorText, exitCode }.
function runClaude(opts, onDelta) {
  return new Promise((resolve, reject) => {
    const args = CFG.claudeBinArgs.concat(buildArgs(opts));
    dbg("spawn", CFG.claudeBin, JSON.stringify(redactArgs(args)));

    let child;
    try {
      child = spawn(CFG.claudeBin, args, {
        cwd: CFG.workdir,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(err);
    }

    let buffer = "";
    let collected = "";
    let sessionId = opts.resume || opts.sessionId || null;
    let usage = null;
    let finalText = null;
    let isError = false;
    let errorText = "";
    let stderrTail = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch (e) {
        /* already gone */
      }
      reject(new Error("Request did not complete within " + CFG.timeoutMs + " ms"));
    }, CFG.timeoutMs);

    function handleLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch (e) {
        dbg("non-JSON line:", trimmed.slice(0, 200));
        return;
      }

      if (msg.session_id) sessionId = msg.session_id;

      if (msg.type === "stream_event" && msg.event) {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          const text = ev.delta.text || "";
          if (text) {
            collected += text;
            if (onDelta) onDelta(text);
          }
        }
        return;
      }

      if (msg.type === "result") {
        usage = msg.usage || null;
        if (msg.is_error) {
          isError = true;
          errorText = typeof msg.result === "string" ? msg.result : "Claude CLI returned an error";
        } else if (typeof msg.result === "string") {
          finalText = msg.result;
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });

    child.stderr.on("data", (chunk) => {
      const t = chunk.toString("utf8");
      stderrTail = (stderrTail + t).slice(-2000);
      dbg("stderr:", t.trim().slice(0, 300));
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (String(err.message).includes("ENOENT")) {
        reject(new Error("Claude CLI not found: " + CFG.claudeBin));
      } else {
        reject(err);
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buffer.trim()) handleLine(buffer);

      if (isError) {
        return resolve({ text: "", sessionId, usage, isError: true, errorText, exitCode: code });
      }
      if (finalText === null && !collected) {
        return resolve({
          text: "",
          sessionId,
          usage,
          isError: true,
          errorText:
            "Claude CLI exited with code " + code + " without producing a response. " +
            (stderrTail.trim() ? "stderr: " + stderrTail.trim().slice(-400) : ""),
          exitCode: code,
        });
      }
      resolve({
        // Prefer the final result field; fall back to the streamed deltas.
        text: finalText !== null ? finalText : collected,
        sessionId,
        usage,
        isError: false,
        errorText: "",
        exitCode: code,
      });
    });

    child.stdin.on("error", () => {
      /* process exited early */
    });
    if (usesJsonInput(opts)) {
      child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content: opts.blocks } }) + "\n"
      );
    } else {
      child.stdin.write(opts.prompt || "");
    }
    child.stdin.end();
  });
}

// ------------------------------------------------------------ message shaping

// The ZimaOS / CasaOS "custom app" importer treats anything that looks like an
// angle-bracketed token in the YAML as a placeholder the user must fill in, and
// refuses to install. We therefore build XML tags from character codes. The
// prompt the model receives still contains real XML tags, which is the format
// Claude parses most reliably.
const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const openTag = (inner) => LT + inner + GT;
const closeTag = (name) => LT + "/" + name + GT;

function partsToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

// ------------------------------------------------------------------- images

const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i;

// The Ollama protocol sends images as raw base64 with no media type, so we
// detect the format from the leading bytes.
function sniffMedia(b64) {
  const s = String(b64 || "").slice(0, 16);
  if (s.startsWith("iVBORw0KGgo")) return "image/png";
  if (s.startsWith("/9j/")) return "image/jpeg";
  if (s.startsWith("R0lGOD")) return "image/gif";
  if (s.startsWith("UklGR")) return "image/webp";
  return "";
}

function imageBlock(mediaType, data) {
  if (!IMAGE_MEDIA.has(mediaType) || !data) return null;
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

function fromDataUrl(url) {
  const s = String(url || "");
  const m = s.match(DATA_URL);
  if (!m) return null;
  return imageBlock(m[1].toLowerCase(), s.slice(m[0].length));
}

// Converts one content part into an image block, or null if it cannot.
function toImageBlock(part) {
  if (!part || typeof part !== "object") return null;

  // Anthropic shape: { type:"image", source:{ type:"base64", media_type, data } }
  if (part.type === "image" && part.source) {
    if (part.source.type === "base64") {
      return imageBlock(String(part.source.media_type || "").toLowerCase(), part.source.data);
    }
    return null; // remote URL: not fetched, to avoid opening an SSRF surface
  }

  // OpenAI shape: { type:"image_url", image_url:{ url:"data:image/png;base64,..." } }
  if (part.type === "image_url") {
    const url = part.image_url && typeof part.image_url === "object" ? part.image_url.url : part.image_url;
    return fromDataUrl(url);
  }

  return null;
}

// Collects every image in a message. Returns { blocks, dropped }, where
// dropped counts non-text parts we could not convert.
function imagesOf(raw) {
  const blocks = [];
  let dropped = 0;

  if (Array.isArray(raw && raw.content)) {
    for (const part of raw.content) {
      if (!part || typeof part !== "object" || part.type === "text") continue;
      const b = toImageBlock(part);
      if (b) blocks.push(b);
      else dropped++;
    }
  }

  // Ollama's native shape: a separate images array on the message.
  if (Array.isArray(raw && raw.images)) {
    for (const item of raw.images) {
      const b = fromDataUrl(item) || imageBlock(sniffMedia(item), item);
      if (b) blocks.push(b);
      else dropped++;
    }
  }

  return { blocks, dropped };
}

function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => {
      const media = CFG.enableVision ? imagesOf(m || {}) : { blocks: [], dropped: 0 };
      return {
        role: (m && m.role) || "user",
        text: partsToText(m && m.content),
        toolCalls: (m && (m.tool_calls || m.toolCalls)) || null,
        toolName: (m && (m.name || m.tool_name)) || null,
        toolCallId: (m && (m.tool_call_id || m.toolCallId)) || null,
        images: media.blocks,
        droppedMedia: media.dropped,
        // Images take part in the session fingerprint so that two different
        // conversations with identical text but different images do not
        // collide onto the same CLI session.
        mediaKey: media.blocks.length
          ? createHash("sha256")
              .update(media.blocks.map((b) => b.source.data).join(""))
              .digest("hex")
              .slice(0, 12)
          : "",
      };
    })
    .filter((m) => m.text || m.toolCalls || m.images.length);
}

function extractSystemPrompt(messages) {
  const parts = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => m.text)
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : "";
}

// Renders one message as text, used when replaying history into a fresh session.
function renderMessage(m) {
  if (m.role === "system" || m.role === "developer") return "";
  if (m.role === "assistant") {
    const inner =
      m.toolCalls && m.toolCalls.length
        ? JSON.stringify({ tool_calls: normalizeToolCalls(m.toolCalls) })
        : m.text;
    return openTag("previous_response") + "\n" + inner + "\n" + closeTag("previous_response");
  }
  if (m.role === "tool" || m.role === "function") {
    const name = m.toolName || "tool";
    return openTag('tool_result name="' + name + '"') + "\n" + m.text + "\n" + closeTag("tool_result");
  }
  return m.text;
}

// Builds the prompt text for this turn. A lone user message is sent verbatim,
// without any wrapper.
function buildPrompt(messages, fromIndex) {
  const slice = messages
    .slice(fromIndex)
    .filter((m) => m.role !== "system" && m.role !== "developer");
  if (slice.length === 1 && slice[0].role === "user") return slice[0].text;
  return slice.map(renderMessage).filter(Boolean).join("\n\n").trim();
}

function collectImages(messages, fromIndex) {
  const out = [];
  for (const m of messages.slice(fromIndex)) {
    for (const img of m.images) {
      if (out.length >= CFG.maxImages) return out;
      out.push(img);
    }
  }
  return out;
}

// Content blocks for the stream-json input format. Images first, then text:
// Claude handles that ordering best.
function buildBlocks(prompt, images) {
  // Must return empty when there are no images, so ordinary requests stay on
  // the plain-text path and stream-json input is used only when required.
  if (!images.length) return [];
  const blocks = images.slice();
  if (prompt) blocks.push({ type: "text", text: prompt });
  return blocks;
}

// No text and an attachment we could not convert: explain the situation to the
// model so it can tell the user, instead of sending an empty prompt.
function promptOrMediaNote(prompt, droppedMedia) {
  if (prompt) return prompt;
  if (droppedMedia) {
    return (
      "The user sent " + droppedMedia + " attachment(s) that this gateway could not " +
      "process (unsupported type, or a remote link). Briefly tell the user this and " +
      "ask them to paste the content as text."
    );
  }
  return prompt;
}

function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  return calls
    .map((c) => {
      const fn = c.function || c;
      let args = fn.arguments !== undefined ? fn.arguments : fn.args;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch (e) {
          args = { _raw: args };
        }
      }
      return { name: fn.name || c.name || "unknown", arguments: args || {} };
    })
    .filter((c) => c.name);
}

// -------------------------------------------------------- model and effort

const PROVIDER_PREFIX = /^(anthropic|claude-max|claude-code-cli|openai|ollama)\//i;
const SAFE_MODEL_CHARS = /^[A-Za-z0-9._-]+/;
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "ultracode"]);

function looksLikeClaudeId(s) {
  if (!s || s.length < 7) return false;
  if (s.slice(0, 7).toLowerCase() !== "claude-") return false;
  const m = s.match(SAFE_MODEL_CHARS);
  return Boolean(m) && m[0].length === s.length;
}

function normalizeEffort(value) {
  const v = String(value || "").trim().toLowerCase();
  return EFFORT_LEVELS.has(v) ? v : "";
}

// Returns { model, effort }.
// The Ollama ":tag" slot carries the effort level:
//   opus:high    -> model=opus, effort=high
//   opus:latest  -> model=opus, effort=(default)
// This lets clients with no advanced settings pick an effort level straight
// from their model dropdown.
function resolveModel(requested) {
  let m = String(requested || "").trim();
  let effort = "";
  if (!m) return { model: CFG.defaultModel, effort: normalizeEffort(CFG.defaultEffort) };

  m = m.replace(PROVIDER_PREFIX, "");
  const colon = m.indexOf(":");
  if (colon > 0) {
    effort = normalizeEffort(m.slice(colon + 1));
    m = m.slice(0, colon);
  }
  if (!effort) effort = normalizeEffort(CFG.defaultEffort);

  const lower = m.toLowerCase();
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") return { model: lower, effort };
  if (looksLikeClaudeId(m)) return { model: m, effort };

  log("Unknown model '" + requested + "', falling back to:", CFG.defaultModel);
  return { model: CFG.defaultModel, effort };
}

// Per-request effort: explicit body field beats the model tag beats the default.
// OpenAI clients use reasoning_effort, Ollama clients use options.reasoning_effort.
function effortFor(body, fromModelTag) {
  const explicit =
    normalizeEffort(body.reasoning_effort) ||
    normalizeEffort(body.effort) ||
    normalizeEffort(body.options && body.options.reasoning_effort);
  return explicit || fromModelTag || "";
}

// EFFORT_TAGS adds effort variants to the advertised model list, so the effort
// level becomes selectable from any client's model dropdown.
function modelList() {
  const base = CFG.models.length ? CFG.models : DEFAULT_MODELS;
  const tags = CFG.effortTags.filter((t) => EFFORT_LEVELS.has(t));
  if (!tags.length) return base;
  const out = [];
  for (const m of base) {
    out.push(m);
    for (const t of tags) out.push(m + ":" + t);
  }
  return out;
}

// ---------------------------------------------------------------- sessions

// Neither the Ollama nor the OpenAI protocol carries a conversation id, so we
// fingerprint the message history and map it to a Claude Code session. On a
// miss nothing breaks: the full history is simply replayed once.
class SessionStore {
  constructor(file) {
    this.file = file;
    this.byKey = new Map();
    this.keysBySid = new Map();
    this.locks = new Map();
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [key, rec] of Object.entries(data)) {
        this.byKey.set(key, rec);
        const list = this.keysBySid.get(rec.sid) || [];
        list.push(key);
        this.keysBySid.set(rec.sid, list);
      }
      log("Session table loaded:", this.byKey.size, "keys");
    } catch (e) {
      /* no file yet, start clean */
    }
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.byKey)));
      } catch (e) {
        log("Could not write session table:", e.message);
      }
    }, 500);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  fingerprint(messages, count, model, sysHash) {
    const SEP = "\u0001";
    const h = createHash("sha256");
    h.update(model);
    h.update(SEP);
    h.update(sysHash);
    for (let i = 0; i < count; i++) {
      const m = messages[i];
      if (m.role === "system" || m.role === "developer") continue;
      h.update(SEP);
      h.update(m.role);
      h.update(SEP);
      h.update(m.text.trim());
      if (m.mediaKey) {
        h.update(SEP);
        h.update(m.mediaKey);
      }
      if (m.toolCalls) {
        h.update(SEP);
        h.update(JSON.stringify(normalizeToolCalls(m.toolCalls)));
      }
    }
    return h.digest("hex");
  }

  // Finds the longest known prefix. Returns { sid, newFrom } on a hit.
  lookup(messages, model, sysHash) {
    const n = messages.length;
    const floor = Math.max(0, n - CFG.lookbackDepth);
    for (let k = n - 1; k >= floor; k--) {
      if (k === 0) break;
      const key = this.fingerprint(messages, k, model, sysHash);
      const rec = this.byKey.get(key);
      if (rec && Date.now() - rec.ts < CFG.sessionTtlMs) {
        return { sid: rec.sid, newFrom: k };
      }
    }
    return null;
  }

  // After a turn completes, bind the prefix the client will send next time to
  // this session.
  remember(messages, replyText, sid, model, sysHash) {
    for (const k of this.keysBySid.get(sid) || []) this.byKey.delete(k);

    const withReply = messages.concat([
      { role: "assistant", text: replyText, toolCalls: null, mediaKey: "" },
    ]);
    const keys = [
      this.fingerprint(withReply, withReply.length, model, sysHash),
      this.fingerprint(messages, messages.length, model, sysHash),
    ];
    const ts = Date.now();
    for (const key of keys) this.byKey.set(key, { sid, ts });
    this.keysBySid.set(sid, keys);
    this.save();
  }

  drop(sid) {
    for (const k of this.keysBySid.get(sid) || []) this.byKey.delete(k);
    this.keysBySid.delete(sid);
    this.save();
  }

  cleanup() {
    const cutoff = Date.now() - CFG.sessionTtlMs;
    let removed = 0;
    for (const [key, rec] of this.byKey) {
      if (rec.ts < cutoff) {
        this.byKey.delete(key);
        removed++;
      }
    }
    if (!removed) return;
    for (const [sid, keys] of this.keysBySid) {
      const alive = keys.filter((k) => this.byKey.has(k));
      if (alive.length) this.keysBySid.set(sid, alive);
      else this.keysBySid.delete(sid);
    }
    log("Expired session keys removed:", removed);
    this.save();
  }

  // Two concurrent requests on the same session would corrupt its transcript,
  // so calls are queued per session.
  withLock(sid, fn) {
    const prev = this.locks.get(sid) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      sid,
      next.then(
        () => {},
        () => {}
      )
    );
    return next;
  }
}

// -------------------------------------------------------------- tool calling

// The Claude Code CLI has no native function-calling surface, so the tool
// schemas are injected into the system prompt with a strict output contract
// and the reply is parsed back out. Reliability is good but not guaranteed;
// anything that fails to parse is treated as ordinary text.
function normalizeToolSchemas(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      const fn = t && (t.function || t);
      if (!fn || !fn.name) return null;
      return {
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || fn.input_schema || { type: "object", properties: {} },
      };
    })
    .filter(Boolean);
}

function toolInstructions(schemas) {
  return [
    "# Tool use",
    "",
    "You can call the tools listed below. Rules:",
    "1. To call one or more tools, reply with ONLY this JSON object. No prose",
    "   before or after it, and no markdown code fence:",
    '   {"tool_calls":[{"name":"TOOL_NAME","arguments":{}}]}',
    "2. If no tool is needed, answer normally in plain text and never emit that",
    "   JSON shape.",
    "3. Use only the tool names listed below. Never invent a tool.",
    "4. " + openTag('tool_result name="..."') + " blocks contain the results of tool",
    "   calls you requested earlier. Continue from them.",
    "",
    "Tools (JSON Schema):",
    JSON.stringify(schemas, null, 2),
  ].join("\n");
}

const FENCE = "```";

function stripFence(text) {
  let t = text.trim();
  if (!t.startsWith(FENCE)) return t;
  const firstNewline = t.indexOf("\n");
  if (firstNewline === -1) return t;
  t = t.slice(firstNewline + 1);
  const closing = t.lastIndexOf(FENCE);
  if (closing !== -1) t = t.slice(0, closing);
  return t.trim();
}

function parseToolCalls(text) {
  const t = stripFence(text || "");
  if (!t.startsWith("{")) return null;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch (e) {
    return null;
  }
  if (!obj || !Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0) return null;
  const calls = normalizeToolCalls(obj.tool_calls);
  return calls.length ? calls : null;
}

// While streaming: if the first non-whitespace character is a brace or a code
// fence the reply may be a tool call, so buffer it. Otherwise stream straight
// through. This keeps normal replies responsive while tools are enabled.
function makeStreamGate(toolsActive) {
  let decided = !toolsActive;
  let buffered = "";
  return {
    push(chunk) {
      if (decided) return { emit: buffered ? buffered + chunk : chunk };
      buffered += chunk;
      const trimmed = buffered.trimStart();
      if (!trimmed) return { emit: null };
      if (trimmed.startsWith("{") || trimmed.startsWith(FENCE)) return { emit: null };
      decided = true;
      const out = buffered;
      buffered = "";
      return { emit: out };
    },
    get pending() {
      return buffered;
    },
    get isBuffering() {
      return !decided;
    },
  };
}

// ------------------------------------------------------------------- stats

const stats = {
  startedAt: Date.now(),
  requests: 0,
  failures: 0,
  sessionHits: 0,
  sessionMisses: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
};

function recordUsage(usage) {
  if (!usage) return;
  stats.inputTokens += usage.input_tokens || 0;
  stats.outputTokens += usage.output_tokens || 0;
  stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
}

// ------------------------------------------------------------- core pipeline

const sessions = new SessionStore(path.join(CFG.stateDir, "sessions.json"));

/*
 * Handles a single chat turn.
 *   body    : request body from the client (OpenAI or Ollama shape)
 *   onDelta : receives streamed text chunks, or null for non-streaming
 * Returns { text, pending, toolCalls, usage, model, sessionId }.
 */
async function chatTurn(body, onDelta) {
  const target = resolveModel(body.model);
  const model = target.model;
  const effort = effortFor(body, target.effort);

  const messages = normalizeMessages(body.messages);
  const totalImages = messages.reduce((a, m) => a + m.images.length, 0);
  const droppedMedia = messages.reduce((a, m) => a + m.droppedMedia, 0);

  // A successful image hand-off is routine, so it is debug-level only.
  if (totalImages) {
    dbg(
      "Images: " + totalImages + " received" +
        (totalImages > CFG.maxImages ? ", forwarding the first " + CFG.maxImages : "")
    );
  }
  // An attachment we could not process is a real problem signal and stays
  // visible even with DEBUG off.
  if (droppedMedia) {
    log("WARNING: " + droppedMedia + " attachment(s) could not be processed (unsupported type or remote link)");
  }

  // A message carrying only an attachment leaves the list empty; rather than
  // failing we either forward the image or explain the situation to the model.
  if (!messages.length && !droppedMedia) throw new Error("messages must not be empty");

  const schemas = CFG.useToolCalls ? normalizeToolSchemas(body.tools) : [];
  let systemPrompt = extractSystemPrompt(messages);
  if (schemas.length) {
    systemPrompt = systemPrompt
      ? systemPrompt + "\n\n" + toolInstructions(schemas)
      : toolInstructions(schemas);
  }

  // Effort is part of the fingerprint: changing it starts a new session,
  // because --effort is a session-level setting in Claude Code.
  const sysHash = createHash("sha256")
    .update(systemPrompt + "\u0001" + effort)
    .digest("hex")
    .slice(0, 16);

  const match = CFG.useSessions ? sessions.lookup(messages, model, sysHash) : null;
  if (match) stats.sessionHits++;
  else stats.sessionMisses++;

  const sid = match ? match.sid : randomUUID();
  const newFrom = match ? match.newFrom : 0;

  const run = async () => {
    const gate = makeStreamGate(schemas.length > 0);
    const forward = onDelta
      ? (chunk) => {
          const r = gate.push(chunk);
          if (r.emit) onDelta(r.emit);
        }
      : null;

    const invoke = (from, resume, sessionId) => {
      const prompt = buildPrompt(messages, from);
      return runClaude(
        {
          model,
          effort,
          prompt: promptOrMediaNote(prompt, droppedMedia),
          blocks: buildBlocks(prompt, collectImages(messages, from)),
          systemPrompt,
          resume,
          sessionId,
        },
        forward
      );
    };

    let result = match ? await invoke(newFrom, sid, null) : await invoke(0, null, sid);

    // If the session could not be resumed (deleted, expired, different project
    // directory) replay the whole history into a fresh one. Behaviour is
    // unchanged, only slower.
    if (result.isError && match) {
      log("Could not resume session (" + sid + "), retrying with full history");
      sessions.drop(sid);
      stats.sessionHits--;
      stats.sessionMisses++;
      const fresh = randomUUID();
      result = await invoke(0, null, fresh);
      if (!result.isError && CFG.useSessions) {
        sessions.remember(messages, result.text, result.sessionId || fresh, model, sysHash);
      }
      return { result, gate };
    }

    if (!result.isError && CFG.useSessions) {
      sessions.remember(messages, result.text, result.sessionId || sid, model, sysHash);
    }
    return { result, gate };
  };

  const { result, gate } = CFG.useSessions ? await sessions.withLock(sid, run) : await run();

  if (result.isError) {
    stats.failures++;
    throw new Error(result.errorText || "Claude CLI error");
  }

  recordUsage(result.usage);
  stats.requests++;

  const calls = schemas.length ? parseToolCalls(result.text) : null;
  if (calls) stats.toolCalls++;

  return {
    text: result.text,
    // Text held in the gate that turned out not to be a tool call, and so has
    // not been streamed yet.
    pending: gate.isBuffering ? gate.pending : "",
    toolCalls: calls,
    usage: result.usage,
    model,
    sessionId: result.sessionId,
  };
}

// --------------------------------------------------------------- HTTP helpers

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > CFG.maxBodyBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function authorized(req) {
  if (!CFG.apiKeys.length) return true;
  const header = req.headers.authorization || "";
  return CFG.apiKeys.includes(header.replace(/^Bearer[ \t]+/i, "").trim());
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

const EMBEDDING_MESSAGE =
  "Embeddings are not supported: the Claude Code CLI cannot produce vectors. " +
  "Use your client's own embedding engine instead. In Open WebUI, leave " +
  "Settings > Documents > Embedding Engine on 'Default (SentenceTransformers)'.";

// ------------------------------------------------------------ OpenAI handlers

function openaiToolCalls(calls) {
  return calls.map((c, i) => ({
    id: "call_" + randomUUID().replace(/-/g, "").slice(0, 24),
    type: "function",
    index: i,
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
}

function usageBlock(usage) {
  const i = (usage && usage.input_tokens) || 0;
  const o = (usage && usage.output_tokens) || 0;
  return { prompt_tokens: i, completion_tokens: o, total_tokens: i + o };
}

async function handleOpenAiChat(req, res, body) {
  const requestId = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
  const stream = body.stream === true;
  const shownModel = body.model || CFG.defaultModel;

  if (!stream) {
    const out = await chatTurn(body, null);
    const message = out.toolCalls
      ? { role: "assistant", content: null, tool_calls: openaiToolCalls(out.toolCalls) }
      : { role: "assistant", content: out.text };
    return sendJson(res, 200, {
      id: requestId,
      object: "chat.completion",
      created: nowSec(),
      model: shownModel,
      choices: [{ index: 0, message, finish_reason: out.toolCalls ? "tool_calls" : "stop" }],
      usage: usageBlock(out.usage),
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(":ok\n\n");

  let first = true;
  const send = (obj) => {
    if (!res.writableEnded) res.write("data: " + JSON.stringify(obj) + "\n\n");
  };
  const chunk = (delta, finish) => ({
    id: requestId,
    object: "chat.completion.chunk",
    created: nowSec(),
    model: shownModel,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  });

  try {
    const out = await chatTurn(body, (text) => {
      send(chunk(first ? { role: "assistant", content: text } : { content: text }));
      first = false;
    });

    if (out.toolCalls) {
      send(chunk({ role: "assistant", content: null, tool_calls: openaiToolCalls(out.toolCalls) }));
      send(chunk({}, "tool_calls"));
    } else {
      // Either text buffered by the tool gate that turned out to be prose, or
      // the full reply if the CLI produced no partial messages at all.
      const tail = out.pending || (first ? out.text : "");
      if (tail) {
        send(chunk(first ? { role: "assistant", content: tail } : { content: tail }));
        first = false;
      }
      send(chunk({}, "stop"));
    }
  } catch (err) {
    send({ error: { message: err.message, type: "server_error", code: null } });
  }

  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

// ------------------------------------------------------------ Ollama handlers

// Real Ollama clients advertise their own version in the User-Agent header,
// e.g. "ollama/0.32.5 (amd64 windows) Go/go1.24". Modern clients refuse to
// talk to a server they consider too old, so we echo the version they asked
// with: any client works, and no manual configuration is needed. When the
// header carries no version we return a value above every real release so the
// too-old check can never trigger.
const FALLBACK_OLLAMA_VERSION = "0.99.9";
const UA_VERSION = /ollama\/([0-9]+\.[0-9]+\.[0-9]+)/i;

function versionFor(req) {
  if (CFG.ollamaVersion) return CFG.ollamaVersion;
  const m = String(req.headers["user-agent"] || "").match(UA_VERSION);
  return m ? m[1] : FALLBACK_OLLAMA_VERSION;
}

function ollamaModelEntry(name) {
  const tagged = name.includes(":") ? name : name + ":latest";
  return {
    name: tagged,
    model: tagged,
    modified_at: new Date(stats.startedAt).toISOString(),
    size: 0,
    digest: createHash("sha256").update(name).digest("hex"),
    details: {
      parent_model: "",
      format: "api",
      family: "claude",
      // Real Ollama puts "clip" in families for vision-capable models; some
      // clients detect image support from that, others read the capabilities
      // array in /api/show. We advertise both.
      families: CFG.enableVision ? ["claude", "clip"] : ["claude"],
      parameter_size: "cloud",
      quantization_level: "none",
    },
  };
}

function ndjson(res, obj) {
  if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
}

async function handleOllamaChat(req, res, body, isGenerate) {
  const stream = body.stream !== false;
  const shownModel = body.model || CFG.defaultModel;

  // /api/generate carries a single prompt; convert it to a message array.
  let payload = body;
  if (isGenerate) {
    const msgs = [];
    if (body.system) msgs.push({ role: "system", content: body.system });
    msgs.push({ role: "user", content: body.prompt || "", images: body.images });
    payload = { model: body.model, messages: msgs, tools: body.tools, options: body.options };
  }

  const wrap = (text, done, extra) => {
    const base = {
      model: shownModel,
      created_at: new Date().toISOString(),
      done: Boolean(done),
    };
    if (isGenerate) base.response = text;
    else base.message = Object.assign({ role: "assistant", content: text }, extra || {});
    if (done) {
      base.done_reason = "stop";
      base.total_duration = 0;
      base.prompt_eval_count = 0;
      base.eval_count = 0;
    }
    return base;
  };

  const toolCallsOf = (out) =>
    out.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));

  if (!stream) {
    const out = await chatTurn(payload, null);
    const extra = out.toolCalls ? { tool_calls: toolCallsOf(out) } : {};
    const done = wrap(out.toolCalls ? "" : out.text, true, extra);
    done.prompt_eval_count = (out.usage && out.usage.input_tokens) || 0;
    done.eval_count = (out.usage && out.usage.output_tokens) || 0;
    return sendJson(res, 200, done);
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  let sentAny = false;
  try {
    const out = await chatTurn(payload, (text) => {
      sentAny = true;
      ndjson(res, wrap(text, false));
    });

    if (out.toolCalls) {
      ndjson(res, wrap("", false, { tool_calls: toolCallsOf(out) }));
    } else {
      const tail = out.pending || (sentAny ? "" : out.text);
      if (tail) ndjson(res, wrap(tail, false));
    }

    const final = wrap("", true);
    final.prompt_eval_count = (out.usage && out.usage.input_tokens) || 0;
    final.eval_count = (out.usage && out.usage.output_tokens) || 0;
    ndjson(res, final);
  } catch (err) {
    ndjson(res, {
      model: shownModel,
      created_at: new Date().toISOString(),
      done: true,
      done_reason: "error",
      error: err.message,
    });
  }
  if (!res.writableEnded) res.end();
}

// --------------------------------------------------------------- routing

/*
 * One handler serves BOTH ports. Routing is by path, never by port:
 *
 *   /v1/...   OpenAI protocol
 *   /api/...  Ollama protocol
 *
 * Clients disagree about which port implies which protocol, and getting that
 * pairing wrong is the single most common setup mistake - a client configured
 * with the Ollama port while still requesting /v1/chat/completions just sees a
 * 404 with no explanation. Serving everything everywhere removes that failure
 * mode entirely: whichever port you point a client at, it works.
 */
const HEAD_OK_PATHS = new Set([
  "/",
  "/v1",
  "/health",
  "/v1/models",
  "/v1/usage",
  "/api/tags",
  "/api/ps",
  "/api/version",
  "/api/show",
]);

// The Ollama shape is a bare string, the OpenAI shape is a nested object.
// Errors are returned in whichever shape the requested path implies.
function sendError(res, code, message, type, p) {
  if (String(p).startsWith("/api/")) return sendJson(res, code, { error: message });
  return sendJson(res, code, { error: { message, type } });
}

async function handleRequest(req, res) {
  cors(res);
  const p = new URL(req.url, "http://localhost").pathname;
  dbg("port " + (req.socket.localPort || "?") + " --", req.method, p, "ua=" + (req.headers["user-agent"] || "-"));

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // The Ollama CLI probes with "HEAD /" before doing anything else. If that
  // does not return the same status as GET, the client decides the server is
  // dead and never sends a single request. Answered before auth.
  if (req.method === "HEAD") {
    res.writeHead(HEAD_OK_PATHS.has(p) ? 200 : 404);
    return res.end();
  }

  // The root is the Ollama liveness probe and must return this exact text on
  // both ports. The service identity lives at /v1 instead.
  if (req.method === "GET" && p === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("Ollama is running");
  }

  if (p === "/health") return sendJson(res, 200, healthPayload());

  if (req.method === "GET" && p === "/v1") {
    return sendJson(res, 200, {
      service: "claude-gateway",
      openai_base_url: "/v1",
      ollama_base_url: "/",
      endpoints: ["/v1/models", "/v1/chat/completions", "/v1/usage", "/api/tags", "/api/chat", "/health"],
    });
  }

  // Auth is decided by path, not by port, so an OpenAI request cannot dodge
  // API_KEYS by arriving on the other port.
  const isOllamaPath = p.startsWith("/api/");
  if (CFG.apiKeys.length && (!isOllamaPath || CFG.protectOllama) && !authorized(req)) {
    return sendError(res, 401, "Missing or invalid API key", "authentication_error", p);
  }

  // ---- OpenAI protocol -----------------------------------------------------

  if (req.method === "GET" && p === "/v1/models") {
    return sendJson(res, 200, {
      object: "list",
      data: modelList().map((id) => ({
        id,
        object: "model",
        owned_by: "anthropic",
        created: nowSec(),
      })),
    });
  }

  if (req.method === "GET" && p === "/v1/usage") return sendJson(res, 200, statsPayload());

  if (req.method === "POST" && p === "/v1/chat/completions") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendError(res, 400, err.message, "invalid_request_error", p);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return sendError(res, 400, "messages is required and must be a non-empty array", "invalid_request_error", p);
    }
    try {
      return await handleOpenAiChat(req, res, body);
    } catch (err) {
      log("chat error:", err.message);
      if (!res.headersSent) return sendError(res, 500, err.message, "server_error", p);
      if (!res.writableEnded) res.end();
      return;
    }
  }

  if (req.method === "POST" && (p === "/v1/embeddings" || p === "/v1/embedding")) {
    return sendError(res, 501, EMBEDDING_MESSAGE, "not_implemented", p);
  }

  // ---- Ollama protocol -----------------------------------------------------

  if (req.method === "GET" && p === "/api/version") {
    return sendJson(res, 200, { version: versionFor(req) });
  }

  if (req.method === "GET" && (p === "/api/tags" || p === "/api/ps")) {
    return sendJson(res, 200, { models: modelList().map(ollamaModelEntry) });
  }

  if (req.method === "POST" && p === "/api/show") {
    let body = {};
    try {
      body = await readBody(req);
    } catch (e) {
      /* an empty body is fine here */
    }
    const name = resolveModel(body.name || body.model).model;
    return sendJson(res, 200, {
      license: "Anthropic Commercial Terms of Service",
      modelfile: "FROM " + name,
      parameters: "",
      template: "{{ .Prompt }}",
      details: ollamaModelEntry(name).details,
      model_info: {
        "general.architecture": "claude",
        "general.parameter_count": 0,
        "claude.context_length": 200000,
      },
      capabilities: ["completion"]
        .concat(CFG.useToolCalls ? ["tools"] : [])
        .concat(CFG.enableVision ? ["vision"] : []),
    });
  }

  if (req.method === "POST" && (p === "/api/chat" || p === "/api/generate")) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
    try {
      return await handleOllamaChat(req, res, body, p === "/api/generate");
    } catch (err) {
      log("ollama chat error:", err.message);
      if (!res.headersSent) return sendError(res, 500, err.message, "server_error", p);
      if (!res.writableEnded) res.end();
      return;
    }
  }

  // Model download endpoints: acknowledged so clients do not hang waiting for
  // a pull that will never happen. Nothing is downloaded.
  if (req.method === "POST" && (p === "/api/pull" || p === "/api/create" || p === "/api/push")) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    ndjson(res, { status: "success" });
    return res.end();
  }

  if ((req.method === "DELETE" || req.method === "POST") && (p === "/api/delete" || p === "/api/copy")) {
    return sendJson(res, 200, { status: "success" });
  }

  if (req.method === "POST" && (p === "/api/embeddings" || p === "/api/embed")) {
    return sendError(res, 501, EMBEDDING_MESSAGE, "not_implemented", p);
  }

  return sendError(res, 404, "Not found: " + p, "invalid_request_error", p);
}

// Both listeners share the handler above; the only difference is the port.
const openaiServer = http.createServer(handleRequest);
const ollamaServer = http.createServer(handleRequest);

// --------------------------------------------------------- health and stats

function healthPayload() {
  return {
    status: "ok",
    provider: "claude-code-cli",
    models: modelList().length,
    sessions: CFG.useSessions ? sessions.byKey.size : "disabled",
    toolCalls: CFG.useToolCalls,
    vision: CFG.enableVision,
    effortSupported: FLAGS.has("--effort"),
    defaultEffort: normalizeEffort(CFG.defaultEffort) || "(CLI default)",
    auth: CFG.apiKeys.length ? "enabled" : "disabled",
    uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
  };
}

function statsPayload() {
  const total = stats.sessionHits + stats.sessionMisses;
  return {
    requests: stats.requests,
    failures: stats.failures,
    toolCalls: stats.toolCalls,
    session: {
      hits: stats.sessionHits,
      misses: stats.sessionMisses,
      hitRate: total ? Math.round((stats.sessionHits / total) * 100) + "%" : "-",
      tracked: sessions.byKey.size,
    },
    tokens: {
      input: stats.inputTokens,
      output: stats.outputTokens,
      cacheRead: stats.cacheReadTokens,
    },
    uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
  };
}

// -------------------------------------------------------------------- start

function main() {
  fs.mkdirSync(CFG.workdir, { recursive: true });
  fs.mkdirSync(CFG.stateDir, { recursive: true });

  probeCli();

  pruneTranscripts();
  setInterval(() => {
    sessions.cleanup();
    pruneTranscripts();
  }, 3600000).unref();

  openaiServer.listen(CFG.openaiPort, CFG.bind, () => {
    log("OpenAI-compatible API:  http://" + CFG.bind + ":" + CFG.openaiPort + "/v1");
  });
  ollamaServer.listen(CFG.ollamaPort, CFG.bind, () => {
    log("Ollama-compatible API:  http://" + CFG.bind + ":" + CFG.ollamaPort);
  });

  log("Models:", modelList().join(", "));
  log("Default model:", CFG.defaultModel);
  log("Session continuity:", CFG.useSessions ? "on" : "off");
  log("Tool calling:", CFG.useToolCalls ? "on" : "off");
  log("Vision:", CFG.enableVision ? "on" : "off");

  const shutdown = () => {
    log("Shutting down...");
    openaiServer.close();
    ollamaServer.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
