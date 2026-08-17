# Claude Code CLI Ollama/OpenAI Proxy

> **Note:** nothing in this project has been reviewed by a human. It was written entirely by AI.

*[Türkçe README](README.tr.md)*

Wraps the [Claude Code CLI](https://code.claude.com/docs) so that any Ollama-compatible or OpenAI-compatible client can talk to Claude. Everything ships as **one `docker-compose.yaml`** — no Dockerfile, no image build, no npm install.

```
client ──┬─ :11434  Ollama-compatible  ──┐
         └─ :3456   OpenAI-compatible  ──┴──> claude-gateway ──> claude --print ──> Claude
```

---

## Read this before you install

This is a **homelab convenience tool, not a secure service.** Please understand what you are running:

- **Both ports are unauthenticated by default.** Anyone who can reach the host on port `11434` or `3456` can use your Claude subscription, with no password. On a normal home network that means every device on the LAN, including guests and IoT devices.
- **Never expose these ports to the internet.** No port forwarding, no reverse proxy without auth in front. Your subscription quota, and everything anyone types into it, is on the line.
- **There is no way to run this securely and keep Ollama clients working.** See [Authentication](#authentication) — this is a property of the Ollama protocol, not an oversight here.
- **The container holds your Claude credentials** in plain files on the host, under the mounted volume. Anyone with access to that host directory can copy your session.
- **Your conversations are written to disk in plaintext.** See [Where your data lives](#where-your-data-lives) below.
- **Requests are not isolated from each other.** There is no per-user accounting, rate limiting, or auditing.

Claude Code's built-in tools (Bash, file write) *are* disabled, so text sent by a client cannot turn into command execution inside the container. That is the one hard boundary this project does enforce. Everything else above is your responsibility.

If you need a multi-user or internet-facing deployment, this is not the right starting point.

## Authentication

**Short version: if you want Ollama clients to work, do not set `API_KEYS`.**

The Ollama protocol has no authentication header. That is true of the protocol itself, so no server implementing it — including this one — can require a credential and still be usable by Ollama clients. Securing this gateway and supporting Ollama are mutually exclusive, and that is not something the project can fix.

What each configuration actually gives you:

| Setting | Result |
|---|---|
| `API_KEYS` unset *(default)* | Both protocols work on both ports. No password anywhere. This is the intended mode. |
| `API_KEYS` set | Every `/v1/...` and `/api/...` request on both ports needs a Bearer token. OpenAI-compatible clients can send one; **Ollama clients cannot, so in practice only the OpenAI side keeps working.** |
| `API_KEYS` set, `PROTECT_OLLAMA: "0"` | `/api/...` is reopened so Ollama clients work again — but the same models are then reachable without a token through `/api/chat`, on both ports. The key stops being a security boundary and becomes a formality. Only use this if you understand and accept that. |

Both protocols are served on both ports, so guarding one protocol and not the other would let any request slip through by switching paths. That is why `API_KEYS` covers everything by default rather than the OpenAI paths alone.

Liveness and discovery (`/`, `/health`) are never gated: a client that cannot probe the server gives up before it ever gets the chance to present a key.

---

## Where your data lives

Everything persists under the single mounted volume, `/DATA/AppData/claude-code-cli-proxy/home` by default:

| Path | Contents | Readable text? |
|---|---|---|
| `.claude/projects/*/*.jsonl` | Claude Code session transcripts | **Yes — every message, in plaintext** |
| `.claude/.credentials.json` | Your Claude sign-in | Token |
| `state/sessions.json` | The gateway's fingerprint table | **No** — SHA-256 digests, session UUIDs and timestamps only. The conversation text cannot be recovered from it. |
| `.local/`, `work/` | The CLI binary and its working directory | — |

The transcripts exist because that is how conversation continuity works: Claude Code has to remember the conversation, which means writing it down. Disabling continuity does not currently stop the transcripts from being written — see [Known rough edges](#known-rough-edges).

The gateway prunes transcripts older than `TRANSCRIPT_RETENTION_HOURS` (72 by default) once an hour and once at startup. Only `.jsonl` files under the transcripts directory are ever deleted; credentials, settings and everything else stay put, so signing in remains permanent. The window is automatically raised to at least `SESSION_TTL_HOURS` so a transcript that could still be resumed is never removed. Set the retention to `0` to keep everything.

Nothing is sent anywhere except to Anthropic, by the CLI itself. Message text never reaches the container logs: prompts travel over stdin, and the system prompt is replaced with a length marker before arguments are logged.

To see how much space transcripts are using:

```bash
du -sh /DATA/AppData/claude-code-cli-proxy/home/.claude/projects/
```

---

## Requirements

- A host running Docker (ZimaOS, CasaOS, a NAS, a Linux box, anything)
- A Claude subscription that includes Claude Code
- Outbound internet access from the container

---

## Install

### ZimaOS / CasaOS

1. **App Store → Install a Custom App**, paste the contents of [`docker-compose.yaml`](docker-compose.yaml), install.
2. Watch the first start — Claude Code downloads on first boot, which takes a minute or two:
   ```bash
   docker logs -f claude-code-cli-ollama-openai-proxy
   ```
3. Sign in once. **Do not omit `-u node`** — signing in as root writes the credentials as root and the service cannot read them:
   ```bash
   docker exec -it -u node claude-code-cli-ollama-openai-proxy claude
   ```
   Open the printed link in a browser, approve, paste the code back, then `/exit`.
4. Restart:
   ```bash
   docker restart claude-code-cli-ollama-openai-proxy
   ```

### Plain Docker

Same file, same steps:

```bash
docker compose up -d
```

Adjust the volume path in `docker-compose.yaml` first — it defaults to `/DATA/AppData/claude-code-cli-proxy/home`, which is the ZimaOS convention.

---

## Verify

```bash
curl -sS http://HOST_IP:11434/api/tags
```

```bash
curl -sS http://HOST_IP:11434/api/chat -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Say hello in one sentence."}],"stream":false}'
```

Live counters, including how often conversation continuity is working:

```bash
curl -sS http://HOST_IP:3456/v1/usage
```

Two numbers there are worth understanding together. `session.hitRate` is how often a turn resumed an existing conversation instead of replaying the whole history, and `tokens.cacheWrite` is how much had to be written to cache rather than read from it. A low hit rate next to a large `cacheWrite` means the history is being re-sent and re-cached every turn — which is the expensive failure mode, and cache writes are billed above the plain input rate. For scale: a one-line request measured against Claude Code 2.1.224 reported two input tokens and 3301 cache-creation tokens, all of it the CLI's own system prompt.

---

## Connecting clients

| Client field | Value |
|---|---|
| Ollama base URL | `http://HOST_IP:11434` |
| OpenAI base URL | `http://HOST_IP:3456` (most clients append `/v1` themselves) |
| API key | Anything, unless you set `API_KEYS` |

**Both ports serve both protocols.** Routing is by path — `/v1/...` is OpenAI, `/api/...` is Ollama — never by port. Pointing a client at the "wrong" port therefore still works, which removes the most common setup mistake: a client configured with the Ollama port while still requesting `/v1/chat/completions`, and getting nothing but a bare 404.

The two ports exist so that clients which assume a default port find what they expect. Pick whichever your client is happier with.

**Open WebUI users:** leave *Settings → Documents → Embedding Engine* on `Default (SentenceTransformers)`. This proxy cannot produce embeddings, and pointing that setting at it would silently break document search.

### What has actually been tested

- **[Odysseus](https://github.com/odysseus-dev/odysseus), through both ports.** This is the client the project was built against. Streaming, image input, reasoning-effort selection and multi-turn conversations were all exercised through it.
- **The official Ollama CLI**, pointed at the gateway with `OLLAMA_HOST`. It is the reference implementation of the protocol, so it connecting and listing models is a meaningful conformance signal, even though not every endpoint was driven through it.

Odysseus pointed at port `11434` used to fail with `404 — Not found: /v1/chat/completions`: it kept requesting an OpenAI path from the Ollama port. That mismatch is what motivated serving both protocols on both ports, and the same configuration has since been confirmed working.

Any other client that speaks one of the two protocols should work without changes — Open WebUI, LibreChat, Continue and similar — but none of those have been verified here, so treat them as expected-to-work rather than confirmed. If one misbehaves, set `DEBUG` to `1`: the log shows exactly which endpoint it asked for, which is usually enough to spot a protocol or base-URL mismatch like the one above.

---

## Choosing a model and reasoning effort

The model list defaults to the aliases `opus`, `sonnet`, `haiku`, which always resolve to the current model of each tier — no config change is needed when Anthropic ships a new one. Pin an exact id such as `claude-opus-5` if you prefer a fixed version.

Reasoning effort can be set two ways, and both work on both ports:

**1. Tag the model name** — works in any client, even one with no advanced settings:

```
opus:max      sonnet:high      haiku:low
```

**2. Send a field in the request body:**

```json
{ "model": "opus", "reasoning_effort": "max" }
```

Ollama clients use `"options": { "reasoning_effort": "max" }` instead. If both are given, the body wins. An invalid value is ignored rather than rejected.

With `EFFORT_TAGS` set (the default), every effort variant also appears in the client's model dropdown, so effort becomes a dropdown choice: `opus:latest`, `opus:low`, `opus:medium`, `opus:high`, `opus:xhigh`, `opus:max`, and the same for the other models.

Not every model supports every level, but an unsupported level does **not** produce an error — it is silently clamped or ignored, so every combination in the list is safe to keep.

**Effort is a ceiling, not a trigger.** It permits the model to think; it does not make it. Whether any thinking happens is the model's decision, and most ordinary questions produce none at any level — so an empty `reasoning_content` is usually the model, not a fault.

**And when a model does think, the text does not always come back.** On the deployment measured here, `opus` returned thinking blocks with no content at all — Claude Code's own session transcript records them as `{"type":"thinking","thinking":"","signature":"..."}`, a signature with nothing readable attached — while `haiku` returned thinking in full, thousands of characters of it. Across 213 turns `haiku` produced visible thinking on roughly 90% of them *with no effort flag at all*, `opus` at `max` on none of 15, and `sonnet` on none of 162.

The gateway forwards whatever text arrives, and in those cases none did. So an empty `reasoning_content` from a model that has obviously reasoned is not necessarily a fault anywhere in the chain — check the transcript under `.claude/projects/` before assuming it is. Practically: **do not assume a bigger model and a higher effort will show you more reasoning.** If seeing the thinking is the point, `haiku` was the dependable one here.

**What effort costs.** A higher level buys more thinking, and thinking is billed as output. `opus:max` is the most expensive combination available and it is easy to leave selected in a dropdown and forget about. Watch `/v1/usage` if that matters to you.

---

## What works

- **Both protocols on both ports**, including streaming (SSE for OpenAI, NDJSON for Ollama). Routing is by path, so a client pointed at either port works.
- **All Claude models** your subscription can reach, via aliases or exact ids
- **Reasoning effort** selection, per request or per model entry
- **Function calling** in both OpenAI and Ollama shapes, including tool results fed back into the conversation
- **Extended thinking delivered separately.** On the OpenAI side it is sent as both `reasoning_content` and `reasoning` — two names are in circulation for the same thing and clients silently drop whichever they do not declare, so both are sent. On the Ollama side it is `message.thinking`, the `thinking` capability is advertised on `/api/show`, and the `think` request field is honoured: `false` turns thinking off entirely, and a level (`low`, `medium`, `high`, `max`) sets the effort. Thinking never appears inside the answer.
- **Image input** (png, jpeg, gif, webp) forwarded as real image blocks
- **Conversation continuity** — the message history is fingerprinted and mapped to a Claude Code session, so only the new message is sent each turn. This engages prompt caching and cuts latency and quota use substantially in long chats.
- **Built-in tools disabled**, so client text cannot execute commands in the container

## What does not work

- **Embeddings.** The Claude Code CLI cannot produce vectors. `/api/embeddings` and `/v1/embeddings` return `501` with an explanation rather than silently returning zeros. Use your client's own embedding engine.
- **Remote image URLs.** Only base64 and `data:` URLs are accepted. Fetching arbitrary URLs from inside the container would open an SSRF surface, so it is deliberately not done; such requests fall back to text and log a warning.
- **`temperature`, `top_p`, `num_predict` and similar sampling parameters.** The CLI does not accept them, so they are ignored.
- **Native function calling.** The CLI has no function-calling surface, so tool schemas are injected into the system prompt with a strict output contract and the reply is parsed back. Models routinely break that contract — they narrate before the call, wrap the JSON in a code fence, and keep writing afterwards — so the parser accepts all of those and drops the trailing invention. It is reliable in practice but not guaranteed; anything that still fails to parse is treated as ordinary text.
- **Stopping the model mid-reply, properly.** There is no stop-sequence, so once a tool call has been written nothing tells the model to be quiet. It carries on and invents the tool results. Those are discarded, and by default the CLI process is killed as soon as a complete call has been read so they are never generated at all — see `TOOL_CALL_EARLY_STOP`.
- **Multi-user features.** No accounting, quotas, or per-client isolation.
- **Horizontal scaling.** One container, one CLI process per request.

## Known rough edges

- **A long message can arrive at the model with its middle missing.** The gateway never truncates anything — but Ollama clients that cannot discover the model's context window assume a small default (2048 or 4096 is common) and trim the conversation themselves to fit, usually by dropping the middle. The context window is now published in every place a client is known to look (`/api/show` `parameters` and `model_info`, `/api/tags` `details`, and `context_window` / `max_model_len` on `/v1/models`), and `CONTEXT_LENGTH` sets the advertised value. Whether a given client reads any of them is not something this side of the wire can guarantee. If long messages still come back half-answered, turn `DEBUG` on and compare the `body: N bytes` line with the size you sent: if the request was already short, the client trimmed it and the fix belongs in the client's settings.
- **Conversation continuity depends on the client echoing your replies back unchanged.** The gateway fingerprints the message history to find the session again; if the client sends back a shortened or rewritten version of what the model said, the fingerprint cannot match and the whole history is replayed. This is visible in the debug log: turns whose assistant messages come back at full length show `session=hit`, and turns where they come back truncated show `session=miss` every time. Nothing on this side can fix that — the fix is in the client.
- **A client that does its own tool calling never reaches the tool-call machinery here.** Some clients ignore the `tools` field entirely and instead describe their tools inside the system prompt, then parse the reply themselves. Everything under **Function calling** above applies only to clients that send `tools`; for the others the gateway is just relaying text, and `toolCalls` in `/v1/usage` stays at zero no matter how many tools the client actually ran.
- **`TOOL_CALL_EARLY_STOP` is new and defaults to on.** Killing the CLI the moment a tool call is complete stops the model inventing tool results, which is where a lot of wasted output came from. It has been tested against a stub that reproduces the behaviour, not against a long-running real conversation. If tool-using chats start losing continuity, set it to `"0"`; the invented text is still discarded, it is just paid for. The tokens that turn is billed are read from the streaming events rather than the final result message, so the counters stay accurate either way.
- **`ENABLE_SESSIONS: "0"` turns off continuity but not transcript writing.** The setting stops the gateway from resuming sessions; the CLI is still given a session id, so it still records the conversation. If you want fewer files on disk, lower `TRANSCRIPT_RETENTION_HOURS` instead.
- Conversation continuity is best-effort. Editing or regenerating a message correctly starts a new session, which costs one full history replay.
- If `claude --print --resume` ever stops working, the gateway silently falls back to replaying the full history. Behaviour stays correct, only slower. Watch `session.hits` in `/v1/usage` to confirm it is engaged.

---

## Configuration

Everything is set through environment variables in `docker-compose.yaml`, which documents each one inline. The most useful:

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_MODELS` | `opus,sonnet,haiku` | Models advertised to clients |
| `DEFAULT_CLAUDE_MODEL` | `sonnet` | Used when the client sends nothing or something unknown |
| `EFFORT_TAGS` | `low,medium,high,xhigh,max` | Effort variants shown in the model list |
| `DEFAULT_EFFORT` | *(unset)* | Effort used when the request specifies none |
| `ENABLE_SESSIONS` | `1` | Conversation continuity |
| `TRANSCRIPT_RETENTION_HOURS` | `72` | Delete session transcripts older than this; `0` keeps them forever |
| `ENABLE_TOOL_CALLS` | `1` | Function calling |
| `ENABLE_THINKING` | `1` | Advertise the `thinking` capability and deliver thinking in its own field. `0` silences it and makes `think` a no-op; the effort level is untouched either way |
| `TOOL_CALL_EARLY_STOP` | `1` | Kill the CLI as soon as a complete tool call has been read, so the model cannot invent the results. `0` lets it finish; the invented text is discarded either way |
| `CONTEXT_LENGTH` | `200000` | Context window advertised to clients. Lower it only if a client misbehaves with the real figure |
| `ENABLE_VISION` | `1` | Image input and the advertised vision capability |
| `API_KEYS` | *(unset)* | Comma-separated Bearer tokens. Guards every path on both ports — see [Authentication](#authentication) |
| `PROTECT_OLLAMA` | `1` when `API_KEYS` is set | Set to `0` to leave `/api/...` open so Ollama clients still work |
| `DEBUG` | `1` | Log every request and image hand-off |
| `DEBUG_DUMP_PROMPT` | *(unset)* | Path to write the exact text sent to the CLI, message content and all. See below — leave it unset unless you are actively debugging |

---

### Seeing what your client actually sends

Every other diagnostic here reports sizes and hashes on purpose — the debug log is safe to paste into an issue. Some questions cannot be answered that way, though: *what is in my client's system prompt? what is it wrapping around my message?* `DEBUG_DUMP_PROMPT` answers those by writing the exact text handed to the CLI, one JSON record per turn, to a file you name:

```bash
DEBUG_DUMP_PROMPT: "/home/node/state/prompt-dump.jsonl"
```

Each record carries `model`, `effort`, `resumed`, `images`, `systemPrompt` and `prompt`. The container prints a loud warning at startup for as long as it is on.

This is the one setting that puts conversation text on disk in the clear, so treat it as a temporary measure: turn it on, reproduce the thing you are chasing, read the file, turn it off, delete the file. It is unset by default and nothing writes it unless you name a path.

## How it works

`src/claude-gateway.mjs` is a single dependency-free Node script that runs two HTTP servers and spawns `claude --print` per request, translating between the wire formats.

A few decisions worth knowing about, each learned the hard way:

- **`--tools ""` is passed on every call.** Without it, Claude Code's built-in Bash and file tools are active in print mode, and anything a client pastes — including text hidden inside a document — could trigger real command execution in the container.
- **`--bare` is deliberately not used.** It speeds up startup by skipping config discovery, but on Claude Code 2.1.223 it also skips reading stored credentials, so every request fails with "Not logged in".
- **`HEAD /` returns 200.** The Ollama CLI probes with `HEAD` before doing anything, and gives up entirely if that is not a 200.
- **`/api/version` echoes the client's own version** from its User-Agent header, because modern Ollama clients refuse to talk to a server they consider too old.
- **A tool call is looked for anywhere in the reply, not only as the whole of it.** The contract asks for a bare JSON object; models narrate first and keep writing afterwards. Requiring an exact match meant those replies produced no tool call at all, and the raw JSON plus whatever the model imagined the tool returned went to the client as prose. The narration is kept as content, the call is parsed, and everything after it is dropped.
- **Thinking is routed on the delta type, not guessed at.** Claude Code 2.1.224 at a high effort level emits a separate content block with `thinking_delta` and `signature_delta` events. Only `text_delta` becomes the answer; thinking goes to its own field and the signature is discarded.
- **The session fingerprint is built from what the client will send back**, not from what the CLI produced. A tool call comes back as `tool_calls`, never as the JSON text, so fingerprinting the text meant every tool-using turn missed its session and replayed history.
- **The gateway source contains no dollar signs**, because it is embedded in a compose file and Docker Compose would substitute dollar-brace expressions as its own variables.
- **XML tags in prompts are built from character codes**, because the ZimaOS custom-app importer treats angle-bracketed tokens in the YAML as placeholders and refuses to install.

---

## Development

The compose file is generated; edit the source, not the YAML.

```bash
node scripts/build-compose.mjs
```

The build refuses to emit a file containing dollar signs or placeholder-looking tokens, so those two traps cannot recur.

```bash
npm test
```

The test suite runs the gateway against a stub CLI that speaks the same stream-json protocol, so no API quota is consumed. It covers protocol translation, streaming, tool calling, image input, effort selection, session continuity, the resume-failure fallback, transcript pruning, and the fidelity of the source embedded in the compose file.

Two suites exist because the awkward cases are where this breaks. `test/tools.test.mjs` drives replies that break the tool-call contract in every way a real model does — narration first, a code fence, invented results afterwards, and prose that merely contains a brace — and checks that the client sees the same clean result in each, streamed and not, with `TOOL_CALL_EARLY_STOP` both on and off. `test/thinking.test.mjs` reproduces the thinking event shape observed from the real CLI and pins down that it reaches the client in its own field and stays out of the answer and the fingerprint.

Most of it is plain Node and runs anywhere. The compose suite additionally executes the bootstrap script embedded in the YAML, which needs a real shell — on Windows run the tests from Git Bash, or point `TEST_BASH` at a bash binary. Note that on Windows the `bash` on `PATH` is often `C:\Windows\System32\bash.exe`, the WSL launcher, which fails when no distribution is installed; the suite detects this and reports those three checks as skipped instead of failed. The check that matters most — that the source survives the YAML block scalar byte for byte — is pure JavaScript and always runs.

Transcript pruning deletes files, so it has its own suite. The checks that matter most are the negative ones: credentials, settings, recent transcripts and non-transcript files must all survive.

---

## Credits

The idea and the overall approach — wrapping the Claude Code CLI as an OpenAI-compatible server, and flattening chat history into a single prompt — come from **[claude-max-api-proxy](https://github.com/sethschnrt/claude-max-api-proxy)** by Atal Ashutosh (MIT licensed). That project was the starting point and the reference while working out how the CLI's streaming protocol behaves.

None of its code is used or redistributed here; this gateway was written from scratch as a dependency-free rewrite. Credit is given because the path was mapped by someone else first.

## Disclaimer

This project drives the official `claude` CLI as a subprocess. It does not extract tokens, reverse-engineer private APIs, or bypass authentication — it wraps the tool you already have installed and signed into.

That said, please review [Anthropic's terms](https://www.anthropic.com/terms) before using it. Policies on third-party tooling can change, and using a subscription through an API shim may not be what your plan intends. Use at your own discretion and risk. This project is not affiliated with or endorsed by Anthropic.

## License

[MIT](LICENSE)
