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
 * Environment switches:
 *   FAKE_RESUME_FAILS=1   every --resume attempt fails, to exercise the
 *                         gateway's full-history fallback path
 */

import { randomUUID } from "node:crypto";

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

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  stdin += c;
});
process.stdin.on("end", () => {
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

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

  let reply;

  if (stdin.includes("TOOLTEST")) {
    reply = JSON.stringify({
      tool_calls: [{ name: "get_weather", arguments: { city: "Istanbul", unit: "c" } }],
    });
  } else if (argValue("--input-format") === "stream-json") {
    let images = 0;
    let text = "";
    try {
      const parsed = JSON.parse(stdin.trim().split("\n")[0]);
      for (const b of parsed.message.content) {
        if (b.type === "image") images++;
        if (b.type === "text") text = b.text;
      }
      reply = "MODEL=" + model + " JSONINPUT=1 IMAGES=" + images + " TEXT=[" + text + "]";
    } catch (e) {
      reply = "JSONERROR=" + e.message;
    }
  } else {
    const LT = String.fromCharCode(60);
    const GT = String.fromCharCode(62);
    reply =
      "MODEL=" + model +
      " EFFORT=[" + (argValue("--effort") || "") + "]" +
      " TOOLSFLAG=[" + toolsFlag + "] " +
      (resumeId ? "RESUMED " : "FRESH ") +
      (stdin.includes(LT + "previous_response" + GT) ? "HASPREV " : "") +
      (stdin.includes(LT + 'tool_result name="') ? "HASTOOLRES " : "") +
      "PROMPTLEN=" + stdin.length;
  }

  // Stream the reply in a few chunks so partial-message handling is exercised.
  const size = Math.max(1, Math.ceil(reply.length / 3));
  for (let i = 0; i < reply.length; i += size) {
    emit({
      type: "stream_event",
      session_id: sessionId,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: reply.slice(i, i + size) },
      },
    });
  }

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: reply,
    session_id: sessionId,
    usage: { input_tokens: stdin.length, output_tokens: reply.length, cache_read_input_tokens: 0 },
  });
  process.exit(0);
});
