/*
 * Extended thinking must reach the client in its own field and never inside the
 * answer.
 *
 * Claude Code 2.1.224 at a high effort level emits thinking as a separate
 * content block whose deltas are "thinking_delta", closed by a
 * "signature_delta" that carries no readable text. The stub reproduces that
 * shape; these checks pin down where each part is allowed to end up.
 *
 *   node test/thinking.test.mjs
 */
import { check, section, summary, startGateway, waitReady, post, postStream } from "./helpers.mjs";

const OA = "http://127.0.0.1:14300";
const OL = "http://127.0.0.1:22300";

const ANSWER = "THINKING-DONE MODEL=sonnet";
const THOUGHT = "Weighing the options. The wording is the trick here.";

const server = startGateway(
  {
    OPENAI_PORT: "14300",
    OLLAMA_PORT: "22300",
    CLAUDE_MODELS: "sonnet",
    DEFAULT_CLAUDE_MODEL: "sonnet",
    TRANSCRIPT_RETENTION_HOURS: "0",
  },
  "state-thinking"
);

const sseDeltas = (text) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)))
    .map((d) => d.choices[0].delta);

const ndjsonLines = (text) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

async function main() {
  if (!(await waitReady(OA + "/health"))) {
    console.log("gateway did not start\n" + server.log);
    process.exit(1);
  }

  section("OpenAI, not streaming");
  const oa = await post(OA + "/v1/chat/completions", {
    model: "sonnet",
    stream: false,
    messages: [{ role: "user", content: "THINKTEST riddle" }],
  });
  const msg = oa.json.choices[0].message;
  check("the answer is the content", msg.content === ANSWER, JSON.stringify(msg.content));
  check("thinking is carried in reasoning_content", msg.reasoning_content === THOUGHT, JSON.stringify(msg.reasoning_content));
  check("thinking does not appear in the content", !String(msg.content).includes("Weighing"), JSON.stringify(msg.content));
  check("the block signature is not exposed", !oa.text.includes("sig-abc"), oa.text.slice(0, 300));

  section("OpenAI, streaming");
  const oaStream = await postStream(OA + "/v1/chat/completions", {
    model: "sonnet",
    stream: true,
    messages: [{ role: "user", content: "THINKTEST riddle" }],
  });
  const deltas = sseDeltas(oaStream.text);
  const streamedContent = deltas.map((d) => d.content || "").join("");
  const streamedThinking = deltas.map((d) => d.reasoning_content || "").join("");
  check("the streamed answer is complete", streamedContent === ANSWER, JSON.stringify(streamedContent));
  check("thinking streams in its own field", streamedThinking === THOUGHT, JSON.stringify(streamedThinking));
  check("no content delta carries thinking", !streamedContent.includes("Weighing"), JSON.stringify(streamedContent));
  // Thinking arrives first, so it is the delta that has to announce the role.
  check("the first delta announces the role", deltas[0] && deltas[0].role === "assistant", JSON.stringify(deltas[0]));
  check("exactly one delta announces the role", deltas.filter((d) => d.role).length === 1, "roles=" + deltas.filter((d) => d.role).length);
  check("the stream still finishes with stop", oaStream.text.includes('"finish_reason":"stop"'), oaStream.text.slice(-200));

  section("Ollama, not streaming");
  const ol = await post(OL + "/api/chat", {
    model: "sonnet",
    stream: false,
    messages: [{ role: "user", content: "THINKTEST riddle" }],
  });
  check("the answer is the content", ol.json.message.content === ANSWER, JSON.stringify(ol.json.message.content));
  check("thinking is carried in message.thinking", ol.json.message.thinking === THOUGHT, JSON.stringify(ol.json.message.thinking));

  section("Ollama, streaming");
  const olStream = await postStream(OL + "/api/chat", {
    model: "sonnet",
    stream: true,
    messages: [{ role: "user", content: "THINKTEST riddle" }],
  });
  const lines = ndjsonLines(olStream.text);
  const olContent = lines.map((l) => (l.message && l.message.content) || "").join("");
  const olThinking = lines.map((l) => (l.message && l.message.thinking) || "").join("");
  check("the streamed answer is complete", olContent === ANSWER, JSON.stringify(olContent));
  check("thinking streams in its own field", olThinking === THOUGHT, JSON.stringify(olThinking));
  check("the stream still ends with done", lines[lines.length - 1].done === true, olStream.text.slice(-200));

  section("Ollama generate");
  const gen = await post(OL + "/api/generate", {
    model: "sonnet",
    stream: false,
    prompt: "THINKTEST riddle",
  });
  check("generate keeps the answer in response", gen.json.response === ANSWER, JSON.stringify(gen.json.response));
  check("generate carries thinking separately", gen.json.thinking === THOUGHT, JSON.stringify(gen.json.thinking));

  section("Thinking stays out of the session fingerprint");
  // The client stores the answer, not the thinking. If thinking were part of
  // the remembered turn the next request could never match.
  const next = await post(OA + "/v1/chat/completions", {
    model: "sonnet",
    stream: false,
    messages: [
      { role: "user", content: "THINKTEST riddle" },
      { role: "assistant", content: ANSWER },
      { role: "user", content: "and now the follow-up" },
    ],
  });
  const followUp = next.json.choices[0].message.content;
  check("the next turn resumes the session", followUp.includes("RESUMED"), followUp);
  const promptLen = parseInt((followUp.match(/PROMPTLEN=([0-9]+)/) || [])[1] || "0", 10);
  check("only the new message is replayed", promptLen === "and now the follow-up".length, "promptlen=" + promptLen);

  const failed = summary(server.log);
  server.child.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log("test runner error:", e);
  console.log(server.log.slice(-3000));
  server.child.kill();
  process.exit(1);
});
