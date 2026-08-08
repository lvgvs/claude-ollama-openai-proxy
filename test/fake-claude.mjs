#!/usr/bin/env node
/*
 * A stub Claude Code CLI used by the test suite. It speaks the same
 * stream-json protocol as the real binary, so the gateway can be exercised
 * end to end without spending any API quota.
 *
 * The reply echoes back what the gateway asked for, which is what the tests
 * assert on:
 *
 *   MODEL=<model>  EFFORT=[<level>]  TOOLSFLAG=[<value>]  FRESH|RESUMED
 *   HASPREV  HASTOOLRES  PROMPTLEN=<n>
 *
 * With --input-format stream-json it reports the structured input instead:
 *
 *   MODEL=<model> JSONINPUT=1 IMAGES=<n> TEXT=[<text>]
 *
 * Markers in the prompt select a canned reply, so the awkward shapes a real
 * model produces can be reproduced exactly:
 *
 *   TOOLTEST    a bare tool-call JSON object, nothing else
 *   TOOLPROSE   a sentence of narration, then the JSON
 *   TOOLFENCE   narration, then the JSON inside a markdown code fence
 *   TOOLTAIL    the JSON, then invented "tool results" after it
 *   THINKTEST   a thinking block (thinking_delta, signature_delta) then text
 *
 * Environment switches:
 *   FAKE_RESUME_FAILS=1     every --resume attempt fails, to exercise the
 *                           gateway's full-history fallback path
 *   FAKE_TAIL_DELAY_MS=n    how long TOOLTAIL waits before writing the invented
 *                           part, leaving a window for the gateway to stop it
 *   FAKE_DONE_FILE=path     written only if this process runs to completion, so
 *                           a test can prove it was killed early instead
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("9.9.9 (Fake Claude Code)\n");
  process.exit(0);
}

if (argv.includes("--help")) {
  process.stdout.write(
    [
      "Usage: claude [options]",
      "  --print",
      "  --output-format <fmt>",
      "  --input-format <fmt>",
      "  --verbose",
      "  --include-partial-messages",
      "  --model <name>",
      "  --effort <level>",
      "  --tools <list>",
      "  --disallowedTools <list>",
      "  --strict-mcp-config",
      "  --bare",
      "  --append-system-prompt <text>",
      "  --session-id <uuid>",
      "  --resume <id>",
      "  --no-session-persistence",
    ].join("\n") + "\n"
  );
  process.exit(0);
}

function argValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

const resumeId = argValue("--resume");
const sessionId = resumeId || argValue("--session-id") || randomUUID();
const model = argValue("--model") || "(no model)";
const toolsFlag = argv.indexOf("--tools") !== -1 ? argv[argv.indexOf("--tools") + 1] : "(absent)";

const doneFile = process.env.FAKE_DONE_FILE || "";
const tailDelay = parseInt(process.env.FAKE_TAIL_DELAY_MS || "0", 10) || 0;

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// Streams a string as a handful of text deltas, so the gateway's partial
// message handling and its streaming tool-call gate are both exercised.
function streamText(text) {
  emit({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  const size = Math.max(1, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += size) {
    emit({
      type: "stream_event",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: text.slice(i, i + size) },
      },
    });
  }
}

// The shape observed from Claude Code 2.1.224 at a high effort level: a
// thinking content block whose deltas are "thinking_delta", closed by a
// "signature_delta" that carries no readable text.
function streamThinking(parts) {
  emit({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  });
  for (const part of parts) {
    emit({
      type: "stream_event",
      session_id: sessionId,
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: part } },
    });
  }
  emit({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
  });
  emit({ type: "stream_event", session_id: sessionId, event: { type: "content_block_stop", index: 0 } });
}

function emitResult(reply, promptLen) {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: reply,
    session_id: sessionId,
    usage: {
      input_tokens: promptLen,
      output_tokens: reply.length,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 7,
    },
  });
}

function finish() {
  process.exit(0);
}

// Written only when TOOLTAIL got all the way to the invented part. Its absence
// is how a test proves the gateway killed this process first.
function markTailWritten() {
  if (!doneFile) return;
  try {
    fs.writeFileSync(doneFile, "done");
  } catch (e) {
    /* the test only checks for absence */
  }
}

const TOOL_JSON = JSON.stringify({
  tool_calls: [{ name: "get_weather", arguments: { city: "Istanbul", unit: "c" } }],
});

// What a real model writes when it does not stop after the call: a plausible
// but entirely invented tool result.
const INVENTED_TAIL =
  "\n\nHere is what the tool returned:\n" +
  JSON.stringify({ temperature: 22, city: "Istanbul", conditions: "clear", source: "invented" }) +
  "\n\nSo it is 22 degrees and clear in Istanbul right now.";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  stdin += c;
});
process.stdin.on("end", () => {
  emit({ type: "system", subtype: "init", session_id: sessionId, model, tools: [] });

  // Simulates a CLI that does not support resuming, so the gateway's fallback
  // to replaying the full history can be tested.
  if (resumeId && process.env.FAKE_RESUME_FAILS === "1") {
    emit({
      type: "result",
      subtype: "error",
      is_error: true,
      result: "No conversation found with session ID: " + resumeId,
      session_id: sessionId,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    process.exit(1);
  }

  const say = (reply) => {
    streamText(reply);
    emitResult(reply, stdin.length);
    finish();
  };

  if (stdin.includes("THINKTEST")) {
    streamThinking(["Weighing the options. ", "The wording is the trick here."]);
    return say("THINKING-DONE MODEL=" + model);
  }

  // The JSON arrives first and the invented part only after a delay, so a test
  // can tell whether the gateway stopped the process in between.
  if (stdin.includes("TOOLTAIL")) {
    streamText(TOOL_JSON);
    setTimeout(() => {
      streamText(INVENTED_TAIL);
      emitResult(TOOL_JSON + INVENTED_TAIL, stdin.length);
      markTailWritten();
      finish();
    }, tailDelay);
    return;
  }

  // Ordinary prose that happens to contain a brace. The gate has to hold it
  // back while tools are active and then release it, not swallow it.
  if (stdin.includes("BRACETEST")) {
    return say('Put {"retries": 3} in the config file and restart.');
  }

  if (stdin.includes("TOOLPROSE")) {
    return say("Let me look that up for you.\n" + TOOL_JSON);
  }

  if (stdin.includes("TOOLFENCE")) {
    return say("Checking the weather now.\n" + "```json\n" + TOOL_JSON + "\n```");
  }

  if (stdin.includes("TOOLTEST")) {
    return say(TOOL_JSON);
  }

  if (argValue("--input-format") === "stream-json") {
    let images = 0;
    let text = "";
    try {
      const parsed = JSON.parse(stdin.trim().split("\n")[0]);
      for (const b of parsed.message.content) {
        if (b.type === "image") images++;
        if (b.type === "text") text = b.text;
      }
      return say("MODEL=" + model + " JSONINPUT=1 IMAGES=" + images + " TEXT=[" + text + "]");
    } catch (e) {
      return say("JSONERROR=" + e.message);
    }
  }

  const LT = String.fromCharCode(60);
  const GT = String.fromCharCode(62);
  return say(
    "MODEL=" + model +
      " EFFORT=[" + (argValue("--effort") || "") + "]" +
      " TOOLSFLAG=[" + toolsFlag + "] " +
      (resumeId ? "RESUMED " : "FRESH ") +
      (stdin.includes(LT + "previous_response" + GT) ? "HASPREV " : "") +
      (stdin.includes(LT + 'tool_result name="') ? "HASTOOLRES " : "") +
      "PROMPTLEN=" + stdin.length
  );
});
