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

  // The CLI has no stop-sequence, so nothing tells the model to be quiet once it
  // has emitted a tool call. Left alone it carries on and invents the tool
  // results itself - output tokens that are billed, thrown away here, and would
  // otherwise be fed back as history on the next turn. When this is on the CLI
  // process is killed the moment a complete tool call has been read.
  // Set TOOL_CALL_EARLY_STOP to "0" to let the process finish instead; the
  // invented text is still discarded, it is just paid for.
  toolCallEarlyStop: process.env.TOOL_CALL_EARLY_STOP !== "0",

  // Extended thinking. Does two things, the same pair as vision: advertises
  // the "thinking" capability so Ollama clients know to ask for it and show it,
  // and forwards the thinking text in its own field. Turning it off silences
  // both and makes the "think" request field a no-op; it does NOT touch the
  // effort level, which is a separate axis.
  enableThinking: process.env.ENABLE_THINKING !== "0",

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

  // Advertised context window. The gateway itself never truncates anything, but
  // Ollama clients that cannot discover a context length assume a small default
  // (2048 or 4096 is common) and silently drop the middle of a long
  // conversation to fit it. Publishing the real number in every place a client
  // might look is the only lever this side of the wire has.
  contextLength: envInt("CONTEXT_LENGTH", 200000),

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
  //
  // Verified against Claude Code 2.1.224 in the container: the init message of
  // a session started this way reports an empty tool list, and a prompt asking
  // the model to run a shell command produces no tool_use block.
  //
  // --tools is variadic, so it swallows every following non-flag argument. A
  // positional prompt placed after it is read as a tool name and the CLI then
  // exits complaining that no input was given. Nothing here is at risk - the
  // prompt travels over stdin and the next token is always another flag - but
  // do not add a positional argument after this line.
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

/*
 * Runs one claude invocation.
 *
 * Answer text arrives through onDelta, extended thinking through onThinking.
 * The two are kept apart all the way to the client: thinking is a separate
 * content block in the CLI stream (delta type "thinking_delta", observed on
 * Claude Code 2.1.224 with a high effort level) and must never be mixed into
 * the answer.
 *
 * With opts.watchToolCalls set, the reply is scanned as it streams and the CLI
 * is stopped as soon as a complete tool call has been read - see the note on
 * CFG.toolCallEarlyStop.
 *
 * Resolves to { text, thinking, sessionId, usage, isError, errorText,
 * exitCode, earlyStopped }.
 */
function runClaude(opts, onDelta, onThinking) {
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
    let thinking = "";
    let sessionId = opts.resume || opts.sessionId || null;
    let usage = null;
    // Usage as reported by the streaming events rather than the final result
    // message. Killing the process early means no result message arrives, so
    // without this the token counters would go blind on every tool call. Used
    // only as a fallback: if a future release changes the event shape the
    // counters simply stay where they are today.
    let streamUsage = null;
    let finalText = null;
    let isError = false;
    let errorText = "";
    let stderrTail = "";
    let settled = false;
    let earlyStopped = false;

    const watcher = opts.watchToolCalls ? makeToolCallWatcher() : null;

    // The CLI stops here rather than after inventing the tool results. There is
    // no "result" message once the process is killed, so usage is unavailable
    // for this turn and the collected text becomes the reply.
    const stopEarly = () => {
      if (earlyStopped || settled) return;
      earlyStopped = true;
      dbg("tool call complete, stopping the CLI early");
      try {
        child.kill("SIGTERM");
      } catch (e) {
        /* already gone */
      }
    };

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
        if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta") {
            const text = ev.delta.text || "";
            if (text) {
              collected += text;
              if (onDelta) onDelta(text);
              if (watcher && watcher.push(text)) stopEarly();
            }
          } else if (ev.delta.type === "thinking_delta") {
            const thought = ev.delta.thinking || "";
            if (thought) {
              thinking += thought;
              if (onThinking) onThinking(thought);
            }
          }
          // signature_delta, and anything else a future release adds, is
          // ignored on purpose rather than falling through into the answer.
        } else if (ev.type === "message_start" && ev.message && ev.message.usage) {
          streamUsage = Object.assign({}, ev.message.usage);
        } else if (ev.type === "message_delta" && ev.usage) {
          streamUsage = Object.assign({}, streamUsage || {}, ev.usage);
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
      if (!usage) usage = streamUsage;

      if (isError) {
        return resolve({ text: "", thinking, sessionId, usage, isError: true, errorText, exitCode: code, earlyStopped });
      }
      if (finalText === null && !collected) {
        return resolve({
          text: "",
          thinking,
          sessionId,
          usage,
          isError: true,
          errorText:
            "Claude CLI exited with code " + code + " without producing a response. " +
            (stderrTail.trim() ? "stderr: " + stderrTail.trim().slice(-400) : ""),
          exitCode: code,
          earlyStopped,
        });
      }
      resolve({
        // Prefer the final result field; fall back to the streamed deltas. An
        // early stop never produces a result message, so it always lands on the
        // collected text - which is exactly the part worth keeping.
        text: finalText !== null ? finalText : collected,
        thinking,
        sessionId,
        usage,
        isError: false,
        errorText: "",
        exitCode: code,
        earlyStopped,
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

/*
 * Per-request effort: explicit body field beats the model tag beats the default.
 * OpenAI clients use reasoning_effort, Ollama clients use
 * options.reasoning_effort, and Ollama's own thinking control is the "think"
 * field - whose levels are the same vocabulary as ours, so it maps straight
 * across with no translation.
 *
 * think:false is stronger than "no preference": the client is saying the model
 * should not think at all, so the effort flag is dropped even if the model tag
 * asked for one.
 */
function effortFor(body, fromModelTag) {
  if (body.think === false) return "";
  const explicit =
    normalizeEffort(body.reasoning_effort) ||
    normalizeEffort(body.effort) ||
    normalizeEffort(body.options && body.options.reasoning_effort) ||
    normalizeEffort(body.think);
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

  /*
   * After a turn completes, bind the prefix the client will send next time to
   * this session.
   *
   * "reply" is the assistant turn in the shape the CLIENT will echo back, not
   * the raw CLI output, and that distinction is the whole point. When the reply
   * is a tool call the client sends it back as { content: null, tool_calls:
   * [...] }; a fingerprint built from the raw JSON text therefore never matched,
   * so every tool-using turn missed the session and replayed the full history.
   * Clients also disagree about what they keep, so both plausible shapes are
   * registered against the same session.
   */
  remember(messages, reply, sid, model, sysHash) {
    for (const k of this.keysBySid.get(sid) || []) this.byKey.delete(k);

    const text = reply.text || "";
    const shapes = [{ role: "assistant", text, toolCalls: reply.toolCalls || null, mediaKey: "" }];
    // A client that renders the call but does not send tool_calls back still
    // lands on this session through the second shape.
    if (reply.toolCalls) shapes.push({ role: "assistant", text, toolCalls: null, mediaKey: "" });

    const keys = [this.fingerprint(messages, messages.length, model, sysHash)];
    for (const shape of shapes) {
      const withReply = messages.concat([shape]);
      keys.push(this.fingerprint(withReply, withReply.length, model, sysHash));
    }

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
    "2. Emit that object and then STOP. Never write what you think the tool",
    "   returned. The call is executed elsewhere and the real result is handed",
    "   back to you on the next turn; anything you invent here is discarded.",
    "3. If no tool is needed, answer normally in plain text and never emit that",
    "   JSON shape.",
    "4. Use only the tool names listed below. Never invent a tool.",
    "5. " + openTag('tool_result name="..."') + " blocks contain the results of tool",
    "   calls you requested earlier. Continue from them.",
    "",
    "Tools (JSON Schema):",
    JSON.stringify(schemas, null, 2),
  ].join("\n");
}

const FENCE = "```";
const TOOL_MARKER = '"tool_calls"';

/*
 * Finds the first balanced JSON object at or after "from". String- and
 * escape-aware, so braces inside string values do not confuse the depth count.
 * Returns { start, end } with end exclusive, or null while the object is still
 * incomplete - which is what lets the streaming watcher below know when the
 * whole tool call has arrived.
 */
function findJsonObject(text, from) {
  const start = text.indexOf("{", from || 0);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

function callsFromJson(slice) {
  let obj;
  try {
    obj = JSON.parse(slice);
  } catch (e) {
    return null;
  }
  if (!obj || !Array.isArray(obj.tool_calls) || obj.tool_calls.length === 0) return null;
  const calls = normalizeToolCalls(obj.tool_calls);
  return calls.length ? calls : null;
}

// A fence opener immediately before the JSON belongs to the tool call, not to
// the prose that preceded it. Written without a regex end anchor on purpose:
// this file may contain no dollar signs (see the note at the top).
function trimTrailingFence(text) {
  const t = String(text).trimEnd();
  const at = t.lastIndexOf(FENCE);
  if (at === -1) return t;
  // Strip it only when nothing but a language tag follows the backticks -
  // otherwise this is the closing fence of a code block in the prose itself.
  if (/[^A-Za-z0-9_-]/.test(t.slice(at + FENCE.length))) return t;
  return t.slice(0, at).trimEnd();
}

/*
 * Pulls a tool call out of a reply.
 *
 * The instructions ask the model to answer with nothing but the JSON object,
 * and it frequently does not: it narrates first ("Let me look that up"), wraps
 * the JSON in a code fence, and - because the CLI has no stop-sequence - keeps
 * going afterwards and writes what it imagines the tool returned. An earlier
 * version required the whole reply to be exactly one JSON object, so any of
 * those produced no tool call at all and the raw JSON plus the invented results
 * were handed to the client as ordinary prose.
 *
 * Returns { calls, before } where "before" is the prose leading up to the call
 * (kept - OpenAI allows content alongside tool_calls), or null if there is no
 * tool call. Everything after the object is dropped: it is invented.
 */
function extractToolCalls(text) {
  const raw = String(text || "");
  let from = 0;
  for (;;) {
    const found = findJsonObject(raw, from);
    if (!found) return null;
    const slice = raw.slice(found.start, found.end);
    if (slice.includes(TOOL_MARKER)) {
      const calls = callsFromJson(slice);
      if (calls) return { calls, before: trimTrailingFence(raw.slice(0, found.start)) };
    }
    from = found.start + 1;
  }
}

/*
 * Watches a reply as it streams and reports the moment a complete, valid tool
 * call has been read, so the CLI process can be stopped there.
 *
 * Scanning is incremental: the marker search only covers the newly arrived text
 * (plus an overlap the length of the marker), and the balance check only runs
 * once the marker has been seen. A reply that never contains a tool call costs
 * one indexOf per delta.
 */
function makeToolCallWatcher() {
  let text = "";
  let searched = 0;
  let objectStart = -1;

  return {
    push(chunk) {
      text += chunk;
      if (objectStart === -1) {
        const at = text.indexOf(TOOL_MARKER, Math.max(0, searched - TOOL_MARKER.length));
        searched = text.length;
        if (at === -1) return false;
        objectStart = text.lastIndexOf("{", at);
        if (objectStart === -1) return false;
      }
      const found = findJsonObject(text, objectStart);
      if (!found) return false; // still arriving
      const slice = text.slice(found.start, found.end);
      if (slice.includes(TOOL_MARKER) && callsFromJson(slice)) return true;
      // A balanced object that is not a tool call - keep looking after it.
      objectStart = -1;
      searched = found.end;
      return false;
    },
  };
}

// Index of the first character that could open a tool call, or -1.
function markerIndex(s) {
  const brace = s.indexOf("{");
  const fence = s.indexOf(FENCE);
  if (brace === -1) return fence;
  if (fence === -1) return brace;
  return Math.min(brace, fence);
}

function isSpaceChar(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/*
 * Length of the trailing run that might turn out to belong to a tool call
 * rather than to the prose: the whitespace that separates the two, and a fence
 * that is still arriving one backtick at a time.
 *
 * Holding it back for a single chunk is what makes the streamed text identical
 * to the non-streamed reply. Without it a call introduced by "Checking now.\n"
 * streams that newline and the non-streaming path trims it, so the same reply
 * reaches the client as two different strings.
 */
function heldTail(s) {
  let n = 0;
  while (n < s.length) {
    const c = s[s.length - 1 - n];
    if (c === "`" || isSpaceChar(c)) n++;
    else break;
  }
  return n;
}

/*
 * Decides, while streaming, what may reach the client.
 *
 * With tools active everything up to the first brace or fence is streamed
 * normally, and everything from there on is withheld. If the withheld text
 * turns out to be a tool call it is dropped; if it turns out to be ordinary
 * prose the caller sends it as the tail. The previous version made this
 * decision once, on the first chunk only, so a reply that opened with a
 * sentence streamed the tool-call JSON straight through afterwards.
 */
function makeStreamGate(toolsActive) {
  let carry = "";
  let held = "";
  let holding = false;

  return {
    push(chunk) {
      if (!toolsActive) return { emit: chunk };
      if (holding) {
        held += chunk;
        return { emit: null };
      }
      const buf = carry + chunk;
      carry = "";
      const i = markerIndex(buf);
      if (i !== -1) {
        holding = true;
        // The whitespace separating the prose from the call goes with the call.
        let cut = i;
        while (cut > 0 && isSpaceChar(buf[cut - 1])) cut--;
        held = buf.slice(cut);
        return { emit: buf.slice(0, cut) || null };
      }
      const keep = heldTail(buf);
      if (keep) {
        carry = buf.slice(buf.length - keep);
        return { emit: buf.slice(0, buf.length - keep) || null };
      }
      return { emit: buf || null };
    },
    // Everything withheld so far. Exactly one of carry and held is ever set.
    get pending() {
      return carry + held;
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
  cacheWriteTokens: 0,
};

/*
 * Cache writes are counted too, and they matter more than they look.
 *
 * A measurement against Claude Code 2.1.224 showed a trivial one-line request
 * reporting input_tokens 2 and cache_creation_input_tokens 3301: the CLI's own
 * system prompt, written to cache on every fresh session. Ignoring that field
 * made /v1/usage report a fraction of what was actually being spent, and cache
 * writes are billed above the plain input rate - so a low session hit rate is
 * far more expensive than the old counters suggested.
 */
function recordUsage(usage) {
  if (!usage) return;
  stats.inputTokens += usage.input_tokens || 0;
  stats.outputTokens += usage.output_tokens || 0;
  stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
  stats.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
}

// Everything the model had to read for this turn, however it was billed.
// Reporting only input_tokens told clients a two-token prompt had been sent.
function promptTokens(usage) {
  if (!usage) return 0;
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0)
  );
}

// ------------------------------------------------------------- core pipeline

const sessions = new SessionStore(path.join(CFG.stateDir, "sessions.json"));

/*
 * Handles a single chat turn.
 *   body       : request body from the client (OpenAI or Ollama shape)
 *   onDelta    : receives streamed answer chunks, or null for non-streaming
 *   onThinking : receives streamed thinking chunks, or null
 * Returns { text, thinking, pending, toolCalls, usage, model, sessionId }.
 */
async function chatTurn(body, onDelta, onThinking) {
  const target = resolveModel(body.model);
  const model = target.model;
  const effort = effortFor(body, target.effort);

  // Ollama's "think" field is how a client switches thinking off. When it does,
  // nothing is streamed and nothing is returned - and effortFor has already
  // dropped the effort flag, so the model does not spend the tokens either.
  const wantsThinking = CFG.enableThinking && body.think !== false;

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

  /*
   * One line per turn, enough to answer the questions that otherwise turn into
   * guesswork: did the whole message arrive, did the session match, and how far
   * back did the history have to be replayed.
   *
   * Sizes only - no message text is ever logged. num_ctx is echoed because
   * clients send it to say what they believe the context window is, and a small
   * value there is the tell that the client trimmed the history itself.
   */
  if (CFG.debug) {
    const numCtx = (body.options && body.options.num_ctx) || 0;
    dbg(
      "turn: model=" + model +
        " effort=" + (effort || "-") +
        " tools=" + schemas.length +
        " messages=" + messages.length +
        " chars=[" + messages.map((m) => m.role.charAt(0) + ":" + m.text.length).join(",") + "]" +
        " session=" + (match ? "hit from=" + match.newFrom : "miss") +
        (numCtx ? " client-num_ctx=" + numCtx + " (ignored here, advertised " + CFG.contextLength + ")" : "")
    );
  }

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
      dbg(
        "prompt: from=" + from +
          " bytes=" + Buffer.byteLength(promptOrMediaNote(prompt, droppedMedia) || "") +
          " system=" + Buffer.byteLength(systemPrompt || "") +
          (resume ? " resume" : " fresh")
      );
      return runClaude(
        {
          model,
          effort,
          prompt: promptOrMediaNote(prompt, droppedMedia),
          blocks: buildBlocks(prompt, collectImages(messages, from)),
          systemPrompt,
          resume,
          sessionId,
          watchToolCalls: schemas.length > 0 && CFG.toolCallEarlyStop,
        },
        forward,
        wantsThinking ? onThinking : null
      );
    };

    // The assistant turn as the CLIENT will store it: the prose without the
    // tool call, plus the parsed calls. Everything the model wrote after the
    // call is invented and is dropped here, before it can be sent, remembered,
    // or replayed as history on the next turn.
    const canonical = (r) => {
      const extracted = schemas.length ? extractToolCalls(r.text) : null;
      return extracted
        ? { text: extracted.before, toolCalls: extracted.calls }
        : { text: r.text, toolCalls: null };
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
      const reply = canonical(result);
      if (!result.isError && CFG.useSessions) {
        sessions.remember(messages, reply, result.sessionId || fresh, model, sysHash);
      }
      return { result, gate, reply };
    }

    const reply = canonical(result);
    if (!result.isError && CFG.useSessions) {
      sessions.remember(messages, reply, result.sessionId || sid, model, sysHash);
    }
    return { result, gate, reply };
  };

  const { result, gate, reply } = CFG.useSessions ? await sessions.withLock(sid, run) : await run();

  if (result.isError) {
    stats.failures++;
    throw new Error(result.errorText || "Claude CLI error");
  }

  recordUsage(result.usage);
  stats.requests++;
  if (reply.toolCalls) stats.toolCalls++;

  if (CFG.debug) {
    const u = result.usage || {};
    dbg(
      "tokens: prompt=" + promptTokens(result.usage) +
        " (fresh=" + (u.input_tokens || 0) +
        " cacheRead=" + (u.cache_read_input_tokens || 0) +
        " cacheWrite=" + (u.cache_creation_input_tokens || 0) + ")" +
        " output=" + (u.output_tokens || 0) +
        (result.thinking ? " thinkingChars=" + result.thinking.length : "") +
        (result.earlyStopped ? " (stopped early at the tool call)" : "")
    );
  }

  return {
    text: reply.text,
    thinking: wantsThinking ? result.thinking || "" : "",
    // Text the gate held back that turned out not to be a tool call, and so has
    // not been streamed yet. When it WAS a tool call the held text is the call
    // itself and must never be sent.
    pending: reply.toolCalls ? "" : gate.pending,
    toolCalls: reply.toolCalls,
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
      // How much actually arrived. This gateway never truncates a request, so
      // when a long message comes out short at the model, this number says
      // whether it was already short when the client sent it.
      dbg("body: " + size + " bytes");
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

/*
 * Two names are in circulation for the same thing on OpenAI-compatible APIs:
 * "reasoning_content", which DeepSeek introduced and vLLM followed, and
 * "reasoning", which is what OpenAI's own guidance uses and where vLLM has
 * since moved. Clients decode responses against strict schemas and silently
 * drop any key they do not declare, so a provider that picks one name loses the
 * thinking entirely for half the ecosystem. Both are sent.
 */
function reasoningFields(text) {
  return { reasoning_content: text, reasoning: text };
}

function usageBlock(usage) {
  const i = promptTokens(usage);
  const o = (usage && usage.output_tokens) || 0;
  return {
    prompt_tokens: i,
    completion_tokens: o,
    total_tokens: i + o,
    prompt_tokens_details: { cached_tokens: (usage && usage.cache_read_input_tokens) || 0 },
  };
}

async function handleOpenAiChat(req, res, body) {
  const requestId = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
  const stream = body.stream === true;
  const shownModel = body.model || CFG.defaultModel;

  if (!stream) {
    const out = await chatTurn(body, null, null);
    const message = out.toolCalls
      ? { role: "assistant", content: out.text || null, tool_calls: openaiToolCalls(out.toolCalls) }
      : { role: "assistant", content: out.text };
    // Thinking travels in its own field, never inside content. Clients that do
    // not know it ignore it; clients that do render it separately.
    if (out.thinking) Object.assign(message, reasoningFields(out.thinking));
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

  // "first" covers any delta, so the role is announced once even when thinking
  // arrives before the answer. "sentText" tracks answer text specifically,
  // which is what decides whether a tail still has to be sent.
  let first = true;
  let sentText = false;
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
  const withRole = (delta) => {
    if (!first) return delta;
    first = false;
    return Object.assign({ role: "assistant" }, delta);
  };

  try {
    const out = await chatTurn(
      body,
      (text) => {
        send(chunk(withRole({ content: text })));
        sentText = true;
      },
      (thought) => {
        send(chunk(withRole(reasoningFields(thought))));
      }
    );

    if (out.toolCalls) {
      send(chunk(withRole({ tool_calls: openaiToolCalls(out.toolCalls) })));
      send(chunk({}, "tool_calls"));
    } else {
      // Either text the tool gate held back that turned out to be prose, or the
      // full reply if the CLI produced no partial messages at all.
      const tail = out.pending || (sentText ? "" : out.text);
      if (tail) {
        send(chunk(withRole({ content: tail })));
        sentText = true;
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
      context_length: CFG.contextLength,
    },
    // Not part of the Ollama schema, but harmless to clients that ignore it and
    // enough for the ones that look here before assuming 4096.
    context_length: CFG.contextLength,
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
    // "think" has to come along, or thinking works on /api/chat and silently
    // does nothing on /api/generate.
    payload = { model: body.model, messages: msgs, tools: body.tools, options: body.options, think: body.think };
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

  // Thinking rides in its own field, exactly as Ollama carries it, so it can
  // never be mistaken for the answer.
  const wrapThinking = (thought) => {
    const base = { model: shownModel, created_at: new Date().toISOString(), done: false };
    if (isGenerate) base.thinking = thought;
    else base.message = { role: "assistant", content: "", thinking: thought };
    return base;
  };

  const toolCallsOf = (out) =>
    out.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));

  if (!stream) {
    const out = await chatTurn(payload, null, null);
    const extra = out.toolCalls ? { tool_calls: toolCallsOf(out) } : {};
    if (out.thinking) extra.thinking = out.thinking;
    const done = wrap(out.text, true, extra);
    if (isGenerate && out.thinking) done.thinking = out.thinking;
    done.prompt_eval_count = promptTokens(out.usage);
    done.eval_count = (out.usage && out.usage.output_tokens) || 0;
    return sendJson(res, 200, done);
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });

  let sentText = false;
  try {
    const out = await chatTurn(
      payload,
      (text) => {
        sentText = true;
        ndjson(res, wrap(text, false));
      },
      (thought) => ndjson(res, wrapThinking(thought))
    );

    if (out.toolCalls) {
      ndjson(res, wrap("", false, { tool_calls: toolCallsOf(out) }));
    } else {
      const tail = out.pending || (sentText ? "" : out.text);
      if (tail) ndjson(res, wrap(tail, false));
    }

    const final = wrap("", true);
    final.prompt_eval_count = promptTokens(out.usage);
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
        // Same reason as /api/show: different clients look for different keys,
        // and one that finds none assumes a small window and trims history.
        context_window: CFG.contextLength,
        max_model_len: CFG.contextLength,
        max_tokens: CFG.contextLength,
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
      // Clients read the context window from wildly different places. All of
      // them are filled in, because a client that fails to find it falls back
      // to a small default and quietly drops the middle of long conversations.
      parameters: "num_ctx " + CFG.contextLength,
      template: "{{ .Prompt }}",
      details: ollamaModelEntry(name).details,
      context_length: CFG.contextLength,
      model_info: {
        "general.architecture": "claude",
        "general.parameter_count": 0,
        "general.context_length": CFG.contextLength,
        "claude.context_length": CFG.contextLength,
      },
      capabilities: ["completion"]
        .concat(CFG.useToolCalls ? ["tools"] : [])
        .concat(CFG.enableVision ? ["vision"] : [])
        // Ollama clients decide whether to ask for and render thinking from
        // this list. Sending the thinking field without advertising it here is
        // the same mistake as sending images to a client that never learned the
        // model could see them.
        .concat(CFG.enableThinking ? ["thinking"] : []),
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
      // Written to cache rather than read from it. A high number here next to a
      // low hit rate means the history is being re-cached every turn.
      cacheWrite: stats.cacheWriteTokens,
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
