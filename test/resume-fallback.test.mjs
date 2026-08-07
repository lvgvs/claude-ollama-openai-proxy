/*
 * The one assumption this project cannot verify from documentation is that
 * "claude --print --resume" works. This suite proves the fallback: when a
 * resume is rejected, the request must still succeed by replaying the full
 * history into a new session, with no error reaching the client.
 *
 *   node test/resume-fallback.test.mjs
 */
import { check, summary, startGateway, waitReady, post } from "./helpers.mjs";

const OA = "http://127.0.0.1:13999";
const OL = "http://127.0.0.1:21999";

const server = startGateway(
  {
    OPENAI_PORT: "13999",
    OLLAMA_PORT: "21999",
    CLAUDE_MODELS: "claude-opus-5",
    DEFAULT_CLAUDE_MODEL: "claude-opus-5",
    FAKE_RESUME_FAILS: "1", // the stub CLI rejects every --resume
  },
  "state-fallback"
);

async function main() {
  if (!(await waitReady(OA + "/health"))) {
    console.log("gateway did not start\n" + server.log);
    process.exit(1);
  }

  const t1 = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "first" }],
    stream: false,
  });
  const c1 = t1.json.message.content;
  check("first turn succeeds", t1.status === 200 && c1.includes("FRESH"), c1);

  // The gateway will try --resume here; the stub refuses, so the fallback runs.
  const t2 = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: c1 },
      { role: "user", content: "second" },
    ],
    stream: false,
  });
  const c2 = t2.json.message.content;
  check("second turn returns 200, no error leaks to the client", t2.status === 200, JSON.stringify(t2.json).slice(0, 200));
  check("second turn falls back to a fresh session", c2.includes("FRESH"), c2);

  const len = parseInt((c2.match(/PROMPTLEN=([0-9]+)/) || [])[1] || "0", 10);
  check("the full history is replayed", len > "second".length, "promptlen=" + len);
  check("the fallback is logged", server.log.includes("retrying with full history"), server.log.slice(-300));

  const t3 = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "an unrelated new chat" }],
    stream: false,
  });
  check("later requests still work", t3.status === 200 && t3.json.message.content.includes("FRESH"));

  const failed = summary(server.log);
  server.child.kill();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log("test runner error:", e);
  console.log(server.log.slice(-2000));
  server.child.kill();
  process.exit(1);
});
