#!/usr/bin/env node
/*
 * Generates docker-compose.yaml by embedding src/claude-gateway.mjs into it.
 *
 *   node scripts/build-compose.mjs
 *
 * Two rules the gateway source must follow, both enforced below:
 *
 *   1. No dollar signs. Docker Compose interpolates dollar-brace expressions
 *      in the YAML as its own variables and would rewrite the code.
 *   2. No angle-bracketed tokens that close on the same line. The ZimaOS /
 *      CasaOS "custom app" importer treats those as placeholders the user must
 *      fill in and refuses to install. Build XML tags from character codes
 *      instead (see openTag / closeTag in the gateway).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "src", "claude-gateway.mjs");
const output = path.join(root, "docker-compose.yaml");

if (!fs.existsSync(source)) {
  console.error("Not found: " + source);
  process.exit(1);
}

const header = `# =============================================================================
#  Claude Code CLI Ollama/OpenAI Proxy  -  single-file deployment
# =============================================================================
#  Exposes a Claude Max subscription, through the Claude Code CLI, as two APIs:
#
#     http://HOST_IP:11434   Ollama-compatible   (Open WebUI, Odysseus, ...)
#     http://HOST_IP:3456    OpenAI-compatible   (Continue, LibreChat, ...)
#
#  BOTH ports serve BOTH protocols. Routing is by path (/v1/... or /api/...),
#  never by port, so pointing a client at the "wrong" one still works.
#
#  SETUP
#  -----
#   1) ZimaOS / CasaOS: App Store -> "Install a Custom App" -> paste this file.
#      Plain Docker: docker compose up -d
#   2) First start takes 1-2 minutes while Claude Code downloads.
#         docker logs -f claude-code-cli-ollama-openai-proxy
#   3) SIGN IN ONCE  (do not omit "-u node")
#         docker exec -it -u node claude-code-cli-ollama-openai-proxy claude
#      Open the printed link in a browser, paste the code back, then /exit.
#   4) docker restart claude-code-cli-ollama-openai-proxy
#
#  Signing in as root writes the credentials as root and the service cannot
#  read them.
#
#  SECURITY
#  --------
#  Claude Code's built-in tools (Bash, file write) are disabled with --tools "".
#  Text arriving from a client therefore cannot turn into command execution
#  inside the container. Both ports are unauthenticated by default; see
#  API_KEYS below to change that.
# =============================================================================

name: claude-code-cli-proxy

services:
  gateway:
    image: node:22-bookworm-slim
    container_name: claude-code-cli-ollama-openai-proxy
    restart: unless-stopped
    init: true

    ports:
      - "11434:11434"   # Ollama-compatible
      - "3456:3456"     # OpenAI-compatible

    volumes:
      # Claude credentials, the CLI binary, conversation sessions and state.
      # Delete this directory and you will have to sign in again.
      - /DATA/AppData/claude-code-cli-proxy/home:/home/node

    environment:
      HOME: /home/node
      TZ: Europe/Istanbul

      # Claude Code installs into /home/node/.local/bin. Without this line
      # "docker exec ... claude" fails, because exec uses the image's default
      # PATH rather than the one start.sh sets.
      PATH: /home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

      # MODEL LIST
      # The aliases opus / sonnet / haiku always resolve to the current model of
      # that tier, so a new Anthropic release needs no change here. Pin an exact
      # id instead if you want a fixed version, for example:
      #   CLAUDE_MODELS: "opus,sonnet,haiku,claude-opus-5"
      CLAUDE_MODELS: "opus,sonnet,haiku"
      DEFAULT_CLAUDE_MODEL: "sonnet"

      CLAUDE_WORKDIR: /home/node/work
      STATE_DIR: /home/node/state

      # --- REASONING EFFORT: two ways in, both work on both ports ---
      #
      #   1) Tag the model name:
      #        opus:max
      #   2) Send a field in the request body:
      #        OpenAI : "reasoning_effort": "max"
      #        Ollama : "options": { "reasoning_effort": "max" }
      #
      #   If both are given the body wins. An invalid value is ignored.
      #   A bare name with no tag means "no effort flag", i.e. the CLI default.
      #   Valid values: low, medium, high, xhigh, max, ultracode
      # DEFAULT_EFFORT: "high"
      #
      # --- EFFORT_TAGS: also list the effort variants as models ---
      #
      #   With the setting below a client's model dropdown shows:
      #        opus:latest   (no effort flag)
      #        opus:low      opus:medium   opus:high
      #        opus:xhigh    opus:max
      #   ...and the same for sonnet and haiku. Total: 3 x 6 = 18 entries.
      #   Leave it empty for a plain list; you can still type a tag by hand.
      #
      #   NOTE: available effort levels differ per model, but an unsupported
      #   level does NOT error - it is silently clamped or ignored. Every
      #   combination in the list is therefore safe to keep.
      EFFORT_TAGS: "low,medium,high,xhigh,max"

      # /api/version normally echoes the version from the client's own
      # User-Agent header, so no configuration is needed. Set this only if some
      # client insists on a fixed server version.
      # OLLAMA_VERSION: "0.32.5"

      # Conversation continuity: fingerprints the message history and maps it to
      # a Claude Code session, so only the new message is sent each turn. This
      # cuts latency and quota usage substantially in long chats.
      ENABLE_SESSIONS: "1"
      SESSION_TTL_HOURS: "24"

      # TRANSCRIPTS AND PRIVACY
      # Conversation continuity works because Claude Code stores a full
      # PLAINTEXT transcript of every session under
      #   /DATA/AppData/claude-code-cli-proxy/home/.claude/projects/
      # Nothing in the CLI ever deletes those, so this gateway prunes files
      # older than the window below. Credentials, settings and everything else
      # under .claude are never touched, so your sign-in stays permanent.
      # The window is automatically raised to at least SESSION_TTL_HOURS, so a
      # transcript that could still be resumed is never removed.
      # Set to 0 to keep every transcript forever.
      TRANSCRIPT_RETENTION_HOURS: "72"

      # OpenAI/Ollama style function calling (the client's own tools).
      ENABLE_TOOL_CALLS: "1"

      # Stop the model inventing tool results. There is no stop-sequence, so
      # after writing a tool call the model carries on and makes up what the
      # tool returned - tokens that are billed and then thrown away. With this
      # on, the CLI is killed as soon as a complete call has been read.
      # Set to "0" to let it finish instead; the invented text is discarded
      # either way, it is just paid for.
      TOOL_CALL_EARLY_STOP: "1"

      # EXTENDED THINKING. Same pair of jobs as vision:
      #   1) Advertises the "thinking" capability, which is how an Ollama client
      #      decides whether to ask for thinking and show it. A client that does
      #      not see it will never display any, however correctly it is sent.
      #   2) Delivers the thinking text in its own field - reasoning_content AND
      #      reasoning on the OpenAI side (two names are in circulation and
      #      clients drop the one they do not know), message.thinking on the
      #      Ollama side. It never appears inside the answer.
      # The Ollama "think" request field is honoured: false turns thinking off
      # and drops the effort flag with it, a level (low/medium/high/max) sets
      # the effort.
      # NOTE: effort is a ceiling, not a trigger. It lets the model think, it
      # does not make it. Most ordinary questions produce no thinking at any
      # level, and that is the model's decision, not this gateway's.
      ENABLE_THINKING: "1"

      # Context window advertised to clients. The gateway never truncates
      # anything, but a client that cannot discover a context length assumes a
      # small default (2048 or 4096 is common) and quietly drops the middle of a
      # long conversation to fit it.
      CONTEXT_LENGTH: "200000"

      # IMAGE SUPPORT. Does two things:
      #   1) Advertises the "vision" capability. Clients that do not see it will
      #      not send images at all and fall back to their own file tools.
      #   2) Forwards images to the CLI as real image blocks using
      #      --input-format stream-json. No tool is enabled for this, so the
      #      security boundary is unchanged.
      # Supported: png, jpeg, gif, webp (base64 or data: URL).
      # Remote URLs are not fetched, to avoid opening an SSRF surface; such
      # requests fall back to text and log a warning.
      ENABLE_VISION: "1"
      MAX_IMAGES_PER_REQUEST: "8"

      REQUEST_TIMEOUT_MS: "600000"

      # ADVANCED - rarely changed, listed so they are discoverable.
      #
      # Ports the gateway listens on INSIDE the container. Changing these means
      # changing the right-hand side of the ports: mapping above to match.
      # OPENAI_PORT: "3456"
      # OLLAMA_PORT: "11434"
      # BIND_ADDRESS: "0.0.0.0"
      #
      # Path to the Claude Code binary, if it is not on PATH.
      # CLAUDE_BIN: "claude"
      #
      # Maximum request body size in megabytes. Images count towards this.
      # MAX_BODY_MB: "32"
      #
      # How many messages back the session fingerprint search looks before
      # giving up and replaying the full history.
      # SESSION_LOOKBACK: "6"

      # AUTHENTICATION - off by default, both ports open.
      # Setting API_KEYS requires a Bearer token on every /v1/... AND /api/...
      # request, on both ports. Both protocols are served on both ports, so
      # guarding only one of them would let a request slip through by using the
      # other protocol.
      # The Ollama protocol has no auth header of its own, so clients that speak
      # it cannot send a key. If you need those to keep working while the OpenAI
      # side stays guarded, set PROTECT_OLLAMA to "0" to leave /api/... open.
      # Liveness and discovery (/, /health) are never gated: a client that
      # cannot probe the server gives up before it can present a key.
      # API_KEYS: "sk-your-long-random-key"
      # PROTECT_OLLAMA: "0"

      # DIAGNOSTICS
      # When on, every HTTP request and every image hand-off is logged:
      #     [debug] ollama -- HEAD / ua=ollama/0.32.5 (amd64 windows)
      #     [debug] Images: 1 received
      # If a client cannot connect or behaves oddly, "docker logs -f" shows
      # exactly which endpoint it hit. Set to "0" to silence the routine lines;
      # real problem signals (unprocessable attachment, session failure,
      # request error) stay visible either way.
      # Message text is never logged: prompts travel over stdin, and the system
      # prompt is replaced with a length marker before the arguments are shown.
      DEBUG: "1"

      # PROMPT DUMP - off, and it should stay off.
      # Every other setting here logs sizes and hashes on purpose. This one
      # writes the exact text sent to the CLI - the client's system prompt and
      # every message - to a file in the clear. It exists because some questions
      # ("what is my client actually sending?") cannot be answered any other
      # way. Turn it on for one debugging session, read the file, turn it off,
      # delete the file. The container announces it loudly at startup while it
      # is on.
      # DEBUG_DUMP_PROMPT: "/home/node/state/prompt-dump.jsonl"

    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:11434/api/tags').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 180s

    entrypoint:
      - /bin/bash
      - -c
      - |
        set -e
        echo "[boot] preparing..."
        mkdir -p /home/node/work /home/node/state /home/node/.local/bin

        # curl is needed only for the FIRST install of Claude Code. The install
        # lives in the persistent volume (/home/node/.local), so on every later
        # start this block is skipped entirely and boot takes seconds.
        if [ ! -x /home/node/.local/bin/claude ] && ! command -v curl >/dev/null 2>&1; then
          echo "[boot] installing curl - first run only, may take a minute..."
          apt-get update -o Acquire::Retries=3
          apt-get install -y --no-install-recommends -o Acquire::Retries=3 curl ca-certificates
          echo "[boot] curl installed."
        elif [ -x /home/node/.local/bin/claude ]; then
          echo "[boot] Claude Code already installed, skipping package setup."
        fi

        cat > /home/node/start.sh <<'START_EOF'
        #!/bin/bash
        set -e
        export PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
        if ! command -v claude >/dev/null 2>&1; then
          echo "[boot] downloading Claude Code - first run only, 1-2 minutes..."
          curl -fsSL https://claude.ai/install.sh | bash
        fi
        claude --version
        exec node /home/node/claude-gateway.mjs
        START_EOF
        chmod +x /home/node/start.sh

        cat > /home/node/claude-gateway.mjs <<'GATEWAY_EOF'
`;

const footer = `        GATEWAY_EOF

        chown -R node:node /home/node

        # Claude Code refuses some operations when running as root, and running
        # a network service as root is poor practice regardless, so drop to the
        # unprivileged "node" user for the actual process.
        if command -v setpriv >/dev/null 2>&1; then
          exec setpriv --reuid=1000 --regid=1000 --init-groups /home/node/start.sh
        else
          exec su node -s /bin/bash -c /home/node/start.sh
        fi

x-casaos:
  architectures:
    - amd64
    - arm64
  main: gateway
  store_app_id: claude-code-cli-proxy
  category: AI
  scheme: http
  # Clicking the app in the ZimaOS UI opens the usage counters.
  index: /v1/usage
  port_map: "3456"
  icon: https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Claude-ai-icon.svg/3840px-Claude-ai-icon.svg.png
  thumbnail: https://upload.wikimedia.org/wikipedia/commons/thumb/5/58/Claude-ai-icon.svg/3840px-Claude-ai-icon.svg.png
  title:
    en_us: Claude Code CLI Ollama/OpenAI Proxy
  tagline:
    en_us: Use Claude through any Ollama or OpenAI compatible client
  description:
    en_us: >-
      Wraps the Claude Code CLI as both an Ollama-compatible API on port 11434
      and an OpenAI-compatible API on port 3456. Supports streaming, function
      calling, image input, reasoning-effort selection and conversation
      continuity. Requires a Claude subscription.
  tips:
    before_install:
      en_us: >-
        After installing, run
        "docker exec -it -u node claude-code-cli-ollama-openai-proxy claude"
        once to sign in with your Claude account, then restart the container.
`;

const jsLines = fs
  .readFileSync(source, "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\n+$/, "") // a trailing newline would add a stray blank line
  .split("\n")
  .map((line) => (line.length === 0 ? "" : "        " + line));

const yaml = header + jsLines.join("\n") + "\n" + footer;
fs.writeFileSync(output, yaml, "utf8");

// ------------------------------------------------------------------- checks

const dollars = (yaml.match(/\$/g) || []).length;
const placeholders = [...new Set(yaml.match(/<[^<>\s\r\n][^<>\r\n]*>/g) || [])];

console.log("Written : " + path.relative(root, output));
console.log("Lines   : " + yaml.split("\n").length);
console.log("Dollars : " + dollars);

let failed = false;
if (placeholders.length) {
  console.error("FAIL: ZimaOS would reject these placeholder-looking tokens:");
  for (const t of placeholders) console.error("       " + t);
  failed = true;
}
if (dollars) {
  console.error("FAIL: dollar signs found; compose would substitute them.");
  failed = true;
}
if (failed) process.exit(1);
console.log("Checks  : ok");
