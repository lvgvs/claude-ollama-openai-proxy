/*
 * Because both protocols are served on both ports, an unauthenticated
 * /api/chat request could otherwise be used to sidestep API_KEYS. This suite
 * exists to prove that hole is closed.
 *
 *   node test/auth.test.mjs
 */
import { check, section, summary, startGateway, waitReady, post } from "./helpers.mjs";

const KEY = "sk-test-key-value";
const OA = "http://127.0.0.1:13555";
const OL = "http://127.0.0.1:21555";

const guarded = startGateway(
  {
    OPENAI_PORT: "13555",
    OLLAMA_PORT: "21555",
    CLAUDE_MODELS: "sonnet",
    API_KEYS: KEY,
    TRANSCRIPT_RETENTION_HOURS: "0",
  },
  "state-auth"
);

const chat = { model: "sonnet", messages: [{ role: "user", content: "hi" }], stream: false };

async function withKey(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

async function main() {
  if (!(await waitReady(OA + "/health"))) {
    console.log("gateway did not start\n" + guarded.log);
    process.exit(1);
  }

  section("API_KEYS set: everything is guarded");
  check("openai path without a key is rejected", (await post(OA + "/v1/chat/completions", chat)).status === 401);
  check("ollama path without a key is rejected", (await post(OL + "/api/chat", chat)).status === 401);
  // The important one: the same request on the other port must not slip past.
  check(
    "ollama path on the openai port cannot bypass the key",
    (await post(OA + "/api/chat", chat)).status === 401,
    "this is the bypass that cross-protocol serving would otherwise open"
  );
  check(
    "openai path on the ollama port cannot bypass the key",
    (await post(OL + "/v1/chat/completions", chat)).status === 401
  );

  section("With a valid key");
  check("openai path accepts the key", (await withKey(OA + "/v1/chat/completions", chat)).status === 200);
  check("ollama path accepts the key", (await withKey(OL + "/api/chat", chat)).status === 200);

  section("Probes stay open");
  // Liveness and discovery must answer before auth, or clients give up before
  // they ever get a chance to send credentials.
  check("HEAD / is not gated", (await fetch(OL + "/", { method: "HEAD" })).status === 200);
  check("GET / is not gated", (await fetch(OL + "/")).status === 200);
  check("health is not gated", (await fetch(OA + "/health")).status === 200);

  guarded.child.kill();

  section("PROTECT_OLLAMA=0 deliberately reopens the Ollama paths");
  // Some Ollama clients cannot send an auth header at all, so this escape
  // hatch has to keep working - but only when asked for explicitly.
  const relaxed = startGateway(
    {
      OPENAI_PORT: "13556",
      OLLAMA_PORT: "21556",
      CLAUDE_MODELS: "sonnet",
      API_KEYS: KEY,
      PROTECT_OLLAMA: "0",
      TRANSCRIPT_RETENTION_HOURS: "0",
    },
    "state-auth-open"
  );
  await waitReady("http://127.0.0.1:13556/health");
  check("ollama path is open when explicitly unprotected", (await post("http://127.0.0.1:21556/api/chat", chat)).status === 200);
  check("openai path stays guarded", (await post("http://127.0.0.1:13556/v1/chat/completions", chat)).status === 401);
  relaxed.child.kill();

  section("No API_KEYS: nothing is guarded");
  const open = startGateway(
    {
      OPENAI_PORT: "13557",
      OLLAMA_PORT: "21557",
      CLAUDE_MODELS: "sonnet",
      TRANSCRIPT_RETENTION_HOURS: "0",
    },
    "state-auth-none"
  );
  await waitReady("http://127.0.0.1:13557/health");
  check("openai path is open by default", (await post("http://127.0.0.1:13557/v1/chat/completions", chat)).status === 200);
  check("ollama path is open by default", (await post("http://127.0.0.1:21557/api/chat", chat)).status === 200);
  open.child.kill();

  const failed = summary(guarded.log);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log("test runner error:", e);
  console.log(guarded.log.slice(-2000));
  guarded.child.kill();
  process.exit(1);
});
