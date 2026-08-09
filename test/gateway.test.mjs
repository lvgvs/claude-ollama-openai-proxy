/*
 * End-to-end tests for the gateway, run against a stub Claude CLI so no API
 * quota is consumed.
 *
 *   node test/gateway.test.mjs
 */
import { check, section, summary, startGateway, waitReady, post, postStream } from "./helpers.mjs";

const OA = "http://127.0.0.1:13456";
const OL = "http://127.0.0.1:21434";

const server = startGateway(
  {
    OPENAI_PORT: "13456",
    OLLAMA_PORT: "21434",
    CLAUDE_MODELS: "claude-opus-5,claude-sonnet-5,claude-haiku-4-5,opus",
    DEFAULT_CLAUDE_MODEL: "claude-sonnet-5",
    MAX_IMAGES_PER_REQUEST: "8",
    DEBUG: "1", // required by the log-redaction checks below
    TRANSCRIPT_RETENTION_HOURS: "0", // pruning has its own suite
  },
  "state-main"
);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

async function main() {
  if (!(await waitReady(OA + "/health"))) {
    console.log("gateway did not start\n" + server.log);
    process.exit(1);
  }

  section("Discovery endpoints");
  const health = await (await fetch(OA + "/health")).json();
  check("health reports ok", health.status === "ok", JSON.stringify(health));

  const models = await (await fetch(OA + "/v1/models")).json();
  check("v1/models lists 4 models", models.data.length === 4, JSON.stringify(models.data.map((m) => m.id)));

  const tags = await (await fetch(OL + "/api/tags")).json();
  check("api/tags adds :latest", tags.models[0].name === "claude-opus-5:latest", tags.models[0].name);
  check("api/tags family is claude", tags.models.every((m) => m.details.family === "claude"));
  check("api/tags advertises clip for vision", tags.models[0].details.families.includes("clip"));

  const vUa = await (
    await fetch(OL + "/api/version", {
      headers: { "user-agent": "ollama/0.32.5 (amd64 windows) Go/go1.24.0" },
    })
  ).json();
  check("api/version echoes the client version", vUa.version === "0.32.5", JSON.stringify(vUa));

  const vBare = await (await fetch(OL + "/api/version", { headers: { "user-agent": "curl/8.5.0" } })).json();
  check("api/version falls back to a high version", vBare.version === "0.99.9", JSON.stringify(vBare));

  const show = await post(OL + "/api/show", { model: "claude-opus-5:latest" });
  check("api/show advertises tools", show.json.capabilities.includes("tools"), show.text);
  check("api/show advertises vision", show.json.capabilities.includes("vision"), show.text);

  // A client that cannot find a context window assumes a small default and
  // silently drops the middle of a long conversation, so every place one might
  // look has to carry the real number.
  check("api/show publishes num_ctx", show.json.parameters === "num_ctx 200000", show.json.parameters);
  check("api/show publishes the context length under both keys",
    show.json.model_info["claude.context_length"] === 200000 &&
      show.json.model_info["general.context_length"] === 200000,
    JSON.stringify(show.json.model_info));
  check("api/tags publishes the context length", tags.models[0].details.context_length === 200000, JSON.stringify(tags.models[0].details));
  check("v1/models publishes the context window", models.data[0].context_window === 200000 && models.data[0].max_model_len === 200000, JSON.stringify(models.data[0]));

  section("Cross-protocol serving");
  // Clients disagree about which port implies which protocol. Both ports serve
  // both, so pointing a client at the "wrong" one is no longer a failure.
  const oaOnOllamaPort = await post(OL + "/v1/chat/completions", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "openai path on the ollama port" }],
    stream: false,
  });
  check(
    "OpenAI path works on the Ollama port",
    oaOnOllamaPort.status === 200 && oaOnOllamaPort.json.choices[0].message.content.includes("MODEL="),
    "status=" + oaOnOllamaPort.status + " " + oaOnOllamaPort.text.slice(0, 200)
  );

  const olOnOpenaiPort = await post(OA + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "ollama path on the openai port" }],
    stream: false,
  });
  check(
    "Ollama path works on the OpenAI port",
    olOnOpenaiPort.status === 200 && olOnOpenaiPort.json.message.content.includes("MODEL="),
    "status=" + olOnOpenaiPort.status + " " + olOnOpenaiPort.text.slice(0, 200)
  );

  const tagsOnOa = await (await fetch(OA + "/api/tags")).json();
  check("api/tags works on the OpenAI port", Array.isArray(tagsOnOa.models) && tagsOnOa.models.length > 0);

  const modelsOnOl = await (await fetch(OL + "/v1/models")).json();
  check("v1/models works on the Ollama port", modelsOnOl.object === "list" && modelsOnOl.data.length > 0);

  const rootOnOa = await (await fetch(OA + "/")).text();
  check("the Ollama liveness probe answers on both ports", rootOnOa === "Ollama is running", rootOnOa);

  const badOnOa = await post(OA + "/api/nope", {});
  check("an Ollama path error keeps the Ollama error shape", typeof badOnOa.json.error === "string", badOnOa.text);
  const badOnOl = await post(OL + "/v1/nope", {});
  check(
    "an OpenAI path error keeps the OpenAI error shape",
    badOnOl.json.error && typeof badOnOl.json.error.message === "string",
    badOnOl.text
  );

  section("HEAD probes");
  // The Ollama CLI probes with HEAD / first and gives up if it is not a 200.
  const headRoot = await fetch(OL + "/", { method: "HEAD" });
  check("HEAD / returns 200 on the ollama port", headRoot.status === 200, "status=" + headRoot.status);
  const headTags = await fetch(OL + "/api/tags", { method: "HEAD" });
  check("HEAD /api/tags returns 200", headTags.status === 200, "status=" + headTags.status);
  const headBad = await fetch(OL + "/api/nope", { method: "HEAD" });
  check("HEAD on an unknown path returns 404", headBad.status === 404, "status=" + headBad.status);
  const headOa = await fetch(OA + "/", { method: "HEAD" });
  check("HEAD / returns 200 on the openai port", headOa.status === 200, "status=" + headOa.status);
  // The root is the Ollama liveness probe on both ports, so the service
  // identity lives at /v1 instead.
  const identity = await (await fetch(OA + "/v1")).json();
  check("the identity payload is served at /v1", identity.service === "claude-gateway", JSON.stringify(identity));

  section("Model resolution");
  const chat1 = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  const c1 = chat1.json.message.content;
  check("requested model reaches the CLI", c1.includes("MODEL=claude-opus-5"), c1);
  // This proves the flag is sent, not that the CLI honours it. Whether the
  // built-in tools are actually off can only be established against the real
  // binary, by reading the tool list in its init message.
  check("the tool-disabling flag is sent on every call", c1.includes("TOOLSFLAG=[]"), c1);
  check("first turn starts a fresh session", c1.includes("FRESH"), c1);

  const tagged = await post(OL + "/api/chat", {
    model: "claude-sonnet-5:latest",
    messages: [{ role: "user", content: "tag test" }],
    stream: false,
  });
  check(":latest tag is stripped", tagged.json.message.content.includes("MODEL=claude-sonnet-5"), tagged.json.message.content);

  const unknown = await post(OL + "/api/chat", {
    model: "llama3.2",
    messages: [{ role: "user", content: "unknown model" }],
    stream: false,
  });
  check("unknown model falls back to the default", unknown.json.message.content.includes("MODEL=claude-sonnet-5"), unknown.json.message.content);

  section("Reasoning effort");
  const eTag = await post(OL + "/api/chat", {
    model: "claude-opus-5:high",
    messages: [{ role: "user", content: "effort by tag" }],
    stream: false,
  });
  check("model tag selects the effort", eTag.json.message.content.includes("EFFORT=[high]"), eTag.json.message.content);
  check("effort tag does not corrupt the model name", eTag.json.message.content.includes("MODEL=claude-opus-5"), eTag.json.message.content);

  const eLatest = await post(OL + "/api/chat", {
    model: "claude-opus-5:latest",
    messages: [{ role: "user", content: "latest tag" }],
    stream: false,
  });
  check(":latest is not treated as an effort", eLatest.json.message.content.includes("EFFORT=[]"), eLatest.json.message.content);

  const eOpenai = await post(OA + "/v1/chat/completions", {
    model: "claude-opus-5",
    reasoning_effort: "max",
    messages: [{ role: "user", content: "openai field" }],
    stream: false,
  });
  check("openai reasoning_effort works", eOpenai.json.choices[0].message.content.includes("EFFORT=[max]"), eOpenai.text);

  const eOllamaOpt = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    options: { reasoning_effort: "low" },
    messages: [{ role: "user", content: "ollama options" }],
    stream: false,
  });
  check("ollama options.reasoning_effort works", eOllamaOpt.json.message.content.includes("EFFORT=[low]"), eOllamaOpt.json.message.content);

  const eOverride = await post(OL + "/api/chat", {
    model: "claude-opus-5:low",
    options: { reasoning_effort: "xhigh" },
    messages: [{ role: "user", content: "precedence" }],
    stream: false,
  });
  check("explicit field overrides the tag", eOverride.json.message.content.includes("EFFORT=[xhigh]"), eOverride.json.message.content);

  const eBad = await post(OL + "/api/chat", {
    model: "claude-opus-5:nonsense",
    messages: [{ role: "user", content: "invalid effort" }],
    stream: false,
  });
  check("invalid effort is ignored", eBad.json.message.content.includes("EFFORT=[]"), eBad.json.message.content);

  section("Session continuity");
  const t2 = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: c1 },
      { role: "user", content: "second question" },
    ],
    stream: false,
  });
  const c2 = t2.json.message.content;
  check("second turn resumes the session", c2.includes("RESUMED"), c2);
  const promptLen = parseInt((c2.match(/PROMPTLEN=([0-9]+)/) || [])[1] || "0", 10);
  check("only the new message is sent on resume", promptLen === "second question".length, "promptlen=" + promptLen);

  const t3 = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: c1 },
      { role: "user", content: "second question" },
      { role: "assistant", content: c2 },
      { role: "user", content: "third question" },
    ],
    stream: false,
  });
  check("third turn resumes too", t3.json.message.content.includes("RESUMED"), t3.json.message.content);

  const branched = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "EDITED REPLY" },
      { role: "user", content: "branch" },
    ],
    stream: false,
  });
  check("edited history starts a new session", branched.json.message.content.includes("FRESH"), branched.json.message.content);
  check("full replay emits previous_response tags", branched.json.message.content.includes("HASPREV"), branched.json.message.content);

  section("Streaming");
  const os = await postStream(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "stream test" }],
    stream: true,
  });
  const lines = os.text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("ollama stream sends multiple lines", lines.length >= 2, "lines=" + lines.length);
  check("ollama stream ends with done", lines[lines.length - 1].done === true);
  check("ollama stream sets done_reason", lines[lines.length - 1].done_reason === "stop");
  const joined = lines.map((l) => (l.message && l.message.content) || "").join("");
  check("ollama stream reassembles the text", joined.includes("MODEL=claude-opus-5"), joined);

  const ss = await postStream(OA + "/v1/chat/completions", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "sse test" }],
    stream: true,
  });
  check("sse ends with [DONE]", ss.text.trim().endsWith("data: [DONE]"), ss.text.slice(-80));
  const sseData = ss.text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
  const sseText = sseData.map((d) => d.choices[0].delta.content || "").join("");
  check("sse reassembles the text", sseText.includes("MODEL=claude-opus-5"), sseText);
  check("sse finish_reason is stop", sseData[sseData.length - 1].choices[0].finish_reason === "stop");

  section("Tool calling");
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Current weather",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    },
  ];

  const tc = await post(OA + "/v1/chat/completions", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "TOOLTEST what is the weather" }],
    tools,
    stream: false,
  });
  check("openai finish_reason is tool_calls", tc.json.choices[0].finish_reason === "tool_calls", tc.text);
  check("openai tool name is correct", tc.json.choices[0].message.tool_calls[0].function.name === "get_weather", tc.text);
  check(
    "openai arguments are a JSON string",
    typeof tc.json.choices[0].message.tool_calls[0].function.arguments === "string" &&
      JSON.parse(tc.json.choices[0].message.tool_calls[0].function.arguments).city === "Istanbul",
    tc.text
  );

  const tcOl = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "TOOLTEST what is the weather" }],
    tools,
    stream: false,
  });
  check("ollama returns tool_calls", Boolean(tcOl.json.message.tool_calls), tcOl.text);
  check("ollama arguments are an object", tcOl.json.message.tool_calls[0].function.arguments.city === "Istanbul", tcOl.text);

  const tcStream = await postStream(OA + "/v1/chat/completions", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "TOOLTEST streamed" }],
    tools,
    stream: true,
  });
  check("streamed tool call does not leak raw json", !tcStream.text.includes('"content":"{'), tcStream.text.slice(0, 200));
  check("streamed tool call is reported", tcStream.text.includes("tool_calls"), tcStream.text.slice(0, 200));

  const toolResult = await post(OA + "/v1/chat/completions", {
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "what is the weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Istanbul"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "22 degrees" },
    ],
    tools,
    stream: false,
  });
  check("tool result reaches the prompt", toolResult.json.choices[0].message.content.includes("PROMPTLEN="), toolResult.text);
  check("tool_result tag is emitted", toolResult.json.choices[0].message.content.includes("HASTOOLRES"), toolResult.json.choices[0].message.content);

  section("Image input");
  const textOnly = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "text only" }],
    stream: false,
  });
  check("requests without images stay on the text path", !textOnly.json.message.content.includes("JSONINPUT"), textOnly.json.message.content);

  const imgText = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image" },
          { type: "image_url", image_url: { url: "data:image/png;base64," + PNG } },
        ],
      },
    ],
    stream: false,
  });
  check("images switch to stream-json input", imgText.json.message.content.includes("JSONINPUT=1"), imgText.json.message.content);
  check("the image becomes an image block", imgText.json.message.content.includes("IMAGES=1"), imgText.json.message.content);
  check("the text travels with the image", imgText.json.message.content.includes("TEXT=[what is in this image]"), imgText.json.message.content);

  const imgNoText = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg" } }] }],
    stream: false,
  });
  check("an image with no text is still forwarded", imgNoText.json.message.content.includes("IMAGES=1"), imgNoText.json.message.content);

  const ollamaNative = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: "ollama native shape", images: [PNG] }],
    stream: false,
  });
  check("ollama images array is recognised", ollamaNative.json.message.content.includes("IMAGES=1"), ollamaNative.json.message.content);

  const anthropicShape = await post(OA + "/v1/chat/completions", {
    model: "claude-opus-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "anthropic shape" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        ],
      },
    ],
    stream: false,
  });
  check("anthropic image shape is recognised", anthropicShape.json.choices[0].message.content.includes("IMAGES=1"), anthropicShape.text.slice(0, 300));

  const remoteUrl = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "remote image" },
          { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        ],
      },
    ],
    stream: false,
  });
  check("remote urls are not fetched", !remoteUrl.json.message.content.includes("JSONINPUT"), remoteUrl.json.message.content);

  const many = await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "many images" }].concat(
          Array.from({ length: 12 }, () => ({ type: "image_url", image_url: { url: "data:image/png;base64," + PNG } }))
        ),
      },
    ],
    stream: false,
  });
  check("image count is capped at 8", many.json.message.content.includes("IMAGES=8"), many.json.message.content);

  section("Errors and stats");
  const emb = await post(OL + "/api/embeddings", { model: "claude-opus-5", prompt: "test" });
  check("embeddings return 501", emb.status === 501, "status=" + emb.status);
  check("embedding error explains the alternative", emb.json.error.includes("SentenceTransformers"), emb.text);

  const bad = await post(OA + "/v1/chat/completions", { model: "claude-opus-5", messages: [] });
  check("empty messages return 400", bad.status === 400, "status=" + bad.status);

  const nf = await fetch(OL + "/api/nothing-here");
  check("unknown endpoint returns 404", nf.status === 404);

  const root = await (await fetch(OL + "/")).text();
  check("ollama root says it is running", root === "Ollama is running", root);

  // Debug logging reports sizes so a short reply can be traced back to a short
  // request, but the message text itself must never reach the log.
  const CANARY = "CANARY-DO-NOT-LOG-7391";
  await post(OL + "/api/chat", {
    model: "claude-opus-5",
    messages: [{ role: "user", content: CANARY + " please answer" }],
    stream: false,
  });
  check("debug log never contains message text", !server.log.includes(CANARY), "the prompt leaked into the log");
  check("debug log reports request size", /body: [0-9]+ bytes/.test(server.log), "no body size line");
  check("debug log reports prompt size", /prompt: from=[0-9]+ bytes=[0-9]+/.test(server.log), "no prompt size line");
  check("debug log reports token usage", /tokens: prompt=[0-9]+/.test(server.log), "no token line");

  // The system prompt may carry client instructions and tool schemas, so the
  // debug log must show a length marker rather than the text itself.
  check("debug log redacts the system prompt", server.log.includes("[system-prompt "), "no redaction marker seen");
  check(
    "debug log does not contain the tool schema",
    !server.log.includes("Current weather"),
    "tool description leaked into the log"
  );

  const usage = await (await fetch(OA + "/v1/usage")).json();
  check("session hits were recorded", usage.session.hits >= 2, JSON.stringify(usage.session));
  check("tool calls were counted", usage.toolCalls >= 3, "toolCalls=" + usage.toolCalls);

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
