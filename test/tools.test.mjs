/*
 * Tool calling against a model that does not follow the contract.
 *
 * The instructions ask for nothing but a JSON object. Real replies narrate
 * first, wrap the JSON in a fence, and - because the CLI has no stop-sequence -
 * carry on afterwards and invent what the tool returned. Every one of those
 * used to be handed to the client as ordinary prose, raw JSON and all.
 *
 *   node test/tools.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, section, summary, startGateway, waitReady, post, postStream } from "./helpers.mjs";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "claude-proxy-tools-"));
const doneEarly = path.join(SANDBOX, "tail-written-early-stop-on");
const doneLate = path.join(SANDBOX, "tail-written-early-stop-off");

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Current weather",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  },
];

const OA = "http://127.0.0.1:14100";
const OL = "http://127.0.0.1:22100";
const OA2 = "http://127.0.0.1:14200";

// Default configuration: TOOL_CALL_EARLY_STOP is on.
const server = startGateway(
  {
    OPENAI_PORT: "14100",
    OLLAMA_PORT: "22100",
    CLAUDE_MODELS: "sonnet",
    DEFAULT_CLAUDE_MODEL: "sonnet",
    TRANSCRIPT_RETENTION_HOURS: "0",
    FAKE_TAIL_DELAY_MS: "1500",
    FAKE_DONE_FILE: doneEarly,
  },
  "state-tools"
);

// Routing is by path, so the endpoint has to be spelled out - posting to the
// bare origin lands on the 404 handler.
const ask = (base, body) =>
  post(base + "/v1/chat/completions", Object.assign({ model: "sonnet", tools: TOOLS, stream: false }, body));
const askOllama = (base, body) =>
  post(base + "/api/chat", Object.assign({ model: "sonnet", tools: TOOLS, stream: false }, body));

async function main() {
  if (!(await waitReady(OA + "/health"))) {
    console.log("gateway did not start\n" + server.log);
    process.exit(1);
  }

  section("Narration before the call");
  const prose = await ask(OA, { messages: [{ role: "user", content: "TOOLPROSE weather please" }] });
  const proseMsg = prose.json.choices[0].message;
  check("the tool call is still recognised", prose.json.choices[0].finish_reason === "tool_calls", prose.text.slice(0, 300));
  check("the tool name survives", proseMsg.tool_calls[0].function.name === "get_weather", prose.text.slice(0, 300));
  check("the narration is kept as content", proseMsg.content === "Let me look that up for you.", JSON.stringify(proseMsg.content));
  check("no raw JSON leaks into content", !String(proseMsg.content).includes("tool_calls"), JSON.stringify(proseMsg.content));

  section("Fenced call");
  const fenced = await ask(OA, { messages: [{ role: "user", content: "TOOLFENCE weather please" }] });
  const fencedMsg = fenced.json.choices[0].message;
  check("a fenced call is recognised", Boolean(fencedMsg.tool_calls), fenced.text.slice(0, 300));
  check("the fence is stripped from the content", fencedMsg.content === "Checking the weather now.", JSON.stringify(fencedMsg.content));

  section("Invented results after the call");
  const tail = await ask(OA, { messages: [{ role: "user", content: "TOOLTAIL weather please" }] });
  const tailMsg = tail.json.choices[0].message;
  check("the call is recognised despite the tail", Boolean(tailMsg.tool_calls), tail.text.slice(0, 300));
  check("the invented result never reaches the client", !tail.text.includes("invented") && !tail.text.includes("22 degrees"), tail.text.slice(0, 400));
  // The stub only writes this file once it has produced the invented part.
  check("the CLI was stopped before inventing anything", !fs.existsSync(doneEarly), "early stop did not fire");

  section("Streaming");
  const streamed = await postStream(OA + "/v1/chat/completions", {
    model: "sonnet",
    tools: TOOLS,
    stream: true,
    messages: [{ role: "user", content: "TOOLPROSE weather please" }],
  });
  const deltas = streamed.text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)))
    .map((d) => d.choices[0].delta);
  const streamedContent = deltas.map((d) => d.content || "").join("");
  check("the narration streams as content", streamedContent === "Let me look that up for you.", JSON.stringify(streamedContent));
  check("no streamed content contains the JSON", !streamedContent.includes("tool_calls"), JSON.stringify(streamedContent));
  check("the tool call is reported in the stream", deltas.some((d) => d.tool_calls), streamed.text.slice(-300));
  check("the first delta announces the role", deltas[0] && deltas[0].role === "assistant", JSON.stringify(deltas[0]));

  section("Prose that merely looks like a call");
  const brace = await ask(OA, { messages: [{ role: "user", content: "BRACETEST how do I set retries" }] });
  check(
    "held-back prose is released in full",
    brace.json.choices[0].message.content === 'Put {"retries": 3} in the config file and restart.',
    JSON.stringify(brace.json.choices[0].message.content)
  );
  check("prose is not mistaken for a tool call", !brace.json.choices[0].message.tool_calls, brace.text.slice(0, 200));

  const braceStream = await postStream(OA + "/v1/chat/completions", {
    model: "sonnet",
    tools: TOOLS,
    stream: true,
    messages: [{ role: "user", content: "BRACETEST streamed" }],
  });
  const braceText = braceStream.text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)))
    .map((d) => d.choices[0].delta.content || "")
    .join("");
  check("held-back prose is released when streaming too", braceText === 'Put {"retries": 3} in the config file and restart.', JSON.stringify(braceText));

  section("Ollama shape");
  const ol = await askOllama(OL, { messages: [{ role: "user", content: "TOOLPROSE weather please" }] });
  check("ollama reports the tool call", Boolean(ol.json.message.tool_calls), ol.text.slice(0, 300));
  check("ollama keeps the narration as content", ol.json.message.content === "Let me look that up for you.", JSON.stringify(ol.json.message.content));
  check("ollama arguments stay an object", ol.json.message.tool_calls[0].function.arguments.city === "Istanbul", ol.text.slice(0, 300));

  section("Session continuity across a tool call");
  // The client echoes the assistant turn back as { content, tool_calls }, never
  // as the raw JSON the CLI produced. The fingerprint has to be built from that
  // same shape, or the assistant turn is replayed on every tool-using turn.
  const first = await ask(OA, { messages: [{ role: "user", content: "TOOLPROSE weather in Istanbul" }] });
  const calls = first.json.choices[0].message.tool_calls;
  const second = await ask(OA, {
    messages: [
      { role: "user", content: "TOOLPROSE weather in Istanbul" },
      { role: "assistant", content: first.json.choices[0].message.content, tool_calls: calls },
      { role: "tool", tool_call_id: calls[0].id, name: "get_weather", content: "22 degrees" },
    ],
  });
  const followUp = second.json.choices[0].message.content;
  check("the follow-up turn resumes the session", followUp.includes("RESUMED"), followUp);
  check("the tool result is what gets sent", followUp.includes("HASTOOLRES"), followUp);
  check(
    "the assistant turn is not replayed",
    !followUp.includes("HASPREV"),
    "HASPREV means the tool-call turn was fingerprinted in the wrong shape and had to be replayed"
  );

  server.child.kill();

  section("TOOL_CALL_EARLY_STOP=0 restores the old behaviour");
  const slow = startGateway(
    {
      OPENAI_PORT: "14200",
      OLLAMA_PORT: "22200",
      CLAUDE_MODELS: "sonnet",
      DEFAULT_CLAUDE_MODEL: "sonnet",
      TRANSCRIPT_RETENTION_HOURS: "0",
      TOOL_CALL_EARLY_STOP: "0",
      FAKE_TAIL_DELAY_MS: "300",
      FAKE_DONE_FILE: doneLate,
    },
    "state-tools-slow"
  );
  await waitReady(OA2 + "/health");
  const slowTail = await ask(OA2, { messages: [{ role: "user", content: "TOOLTAIL weather please" }] });
  check("the CLI is allowed to finish", fs.existsSync(doneLate), "the stub never reached the invented part");
  check("the client still sees a clean tool call", Boolean(slowTail.json.choices[0].message.tool_calls), slowTail.text.slice(0, 300));
  check("the invented result is still discarded", !slowTail.text.includes("invented"), slowTail.text.slice(0, 400));
  slow.child.kill();

  const failed = summary(server.log);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log("test runner error:", e);
  console.log(server.log.slice(-3000));
  server.child.kill();
  process.exit(1);
});
