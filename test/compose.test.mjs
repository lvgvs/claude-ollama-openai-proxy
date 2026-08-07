/*
 * Verifies that docker-compose.yaml is a faithful carrier for the gateway.
 *
 * The gateway source travels through a YAML block scalar and then a bash
 * heredoc before it lands on disk inside the container. This suite extracts
 * the embedded script the same way YAML would, actually runs it, and compares
 * the file it produces with the original byte for byte.
 *
 *   node test/compose.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { check, skip, section, summary, ROOT, GATEWAY } from "./helpers.mjs";

// The sandbox lives in the system temp directory rather than the repository,
// because the repository path may contain spaces and the extracted shell
// script does not quote paths. The real container path (/home/node) never
// contains spaces, so this is a harness concern only.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "claude-proxy-compose-"));
const composePath = path.join(ROOT, "docker-compose.yaml");

if (!fs.existsSync(composePath)) {
  console.log("docker-compose.yaml missing. Run: node scripts/build-compose.mjs");
  process.exit(1);
}

const composeText = fs.readFileSync(composePath, "utf8");
const lines = composeText.split(/\r?\n/);

section("Block scalar extraction");

const marker = lines.findIndex((l) => l === "      - |");
check("entrypoint block scalar found", marker !== -1);

// YAML block scalars strip the common indentation, which the first non-empty
// line establishes. Here that is eight spaces.
const body = [];
for (let i = marker + 1; i < lines.length; i++) {
  const l = lines[i];
  if (l.trim() === "") {
    body.push("");
    continue;
  }
  if (!l.startsWith("        ")) break;
  body.push(l.slice(8));
}
const bash = body.join("\n");
const bl = bash.split("\n");

check("block content extracted", bash.length > 1000, "length=" + bash.length);
check("block starts with set -e", bash.startsWith("set -e"), bash.slice(0, 40));

section("Heredoc boundaries");
check("START_EOF opens at column 0", bl.includes("cat > /home/node/start.sh <<'START_EOF'"));
check("START_EOF closes at column 0", bl.includes("START_EOF"));
check("GATEWAY_EOF opens at column 0", bl.includes("cat > /home/node/claude-gateway.mjs <<'GATEWAY_EOF'"));
check("GATEWAY_EOF closes at column 0", bl.includes("GATEWAY_EOF"));

section("Embedded source fidelity");
const gs = bl.indexOf("cat > /home/node/claude-gateway.mjs <<'GATEWAY_EOF'");
const ge = bl.indexOf("GATEWAY_EOF", gs);
const embedded = bl.slice(gs + 1, ge).join("\n");
const original = fs.readFileSync(GATEWAY, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
check("embedded source matches the original", embedded === original, "embedded=" + embedded.length + " original=" + original.length);

/*
 * The "bash" on PATH is not always a usable shell. On Windows it commonly
 * resolves to C:\Windows\System32\bash.exe, the WSL launcher, which exits 1
 * with an empty stderr when no distribution is installed - indistinguishable
 * from the script itself failing. Probe the candidates and take the first that
 * actually runs, preferring Git Bash on Windows.
 */
function findBash() {
  const usable = (bin) => {
    const probe = spawnSync(bin, ["-c", "echo ready"], { encoding: "utf8" });
    return probe.status === 0 && (probe.stdout || "").includes("ready");
  };
  // An explicit TEST_BASH is authoritative. Falling back to a different shell
  // would let someone believe they had tested with the one they named.
  if (process.env.TEST_BASH) return usable(process.env.TEST_BASH) ? process.env.TEST_BASH : null;

  const candidates = [];
  if (process.platform === "win32") {
    const git = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
    // --exec-path points at <root>/mingw64/libexec/git-core
    if (git.status === 0 && git.stdout.trim()) {
      candidates.push(path.join(path.resolve(git.stdout.trim(), "..", "..", ".."), "bin", "bash.exe"));
    }
    candidates.push("C:/Program Files/Git/bin/bash.exe");
  }
  candidates.push("bash");
  for (const candidate of candidates) {
    if (usable(candidate)) return candidate;
  }
  return null;
}

const BASH = findBash();
const NO_BASH = process.env.TEST_BASH
  ? "TEST_BASH is set but does not run: " + process.env.TEST_BASH
  : "no working bash on this machine (install Git for Windows, or point TEST_BASH at one)";

section("Running the embedded script");
const fakeHome = path.join(SANDBOX, "home", "node").replace(/\\/g, "/");

// Everything from the chown onwards needs a real container, so the script is
// cut there and /home/node is redirected into the sandbox.
const cut = bl.indexOf("chown -R node:node /home/node");
check("chown line found (cut point)", cut !== -1);
// Redirect the shell's own /home/node paths into the sandbox, but leave the
// heredoc body untouched: the gateway source is data here, and rewriting paths
// inside it would make the produced file differ from the original.
const runnable = bl
  .slice(0, cut === -1 ? bl.length : cut)
  .map((line, i) => (i > gs && i < ge ? line : line.split("/home/node").join(fakeHome)))
  .join("\n");

const scriptPath = path.join(SANDBOX, "entrypoint.sh");
fs.writeFileSync(scriptPath, runnable, "utf8");

/*
 * Only this last stretch needs a shell. The guarantee that matters most - that
 * the source survives the YAML block scalar byte for byte - is checked above
 * in pure JavaScript, so it still runs on a machine without bash.
 */
if (!BASH) {
  skip("the script runs without error", NO_BASH);
  skip("claude-gateway.mjs was written", NO_BASH);
  skip("start.sh was written", NO_BASH);
} else {
  const r = spawnSync(BASH, [scriptPath.replace(/\\/g, "/")], { encoding: "utf8" });
  check("the script runs without error", r.status === 0, "code=" + r.status + " " + (r.stderr || "").slice(0, 300));

  const producedGw = path.join(fakeHome, "claude-gateway.mjs");
  check("claude-gateway.mjs was written", fs.existsSync(producedGw));
  if (fs.existsSync(producedGw)) {
    const produced = fs.readFileSync(producedGw, "utf8").replace(/\r\n/g, "\n").replace(/\n$/, "");
    check("the written file matches the original", produced === original, "produced=" + produced.length + " original=" + original.length);
    const chk = spawnSync(process.execPath, ["--check", producedGw], { encoding: "utf8" });
    check("the written file is valid javascript", chk.status === 0, chk.stderr);
  }

  const producedStart = path.join(fakeHome, "start.sh");
  check("start.sh was written", fs.existsSync(producedStart));
  if (fs.existsSync(producedStart)) {
    const s = fs.readFileSync(producedStart, "utf8");
    check("start.sh begins with a shebang", s.startsWith("#!/bin/bash"), s.slice(0, 30));
    check("start.sh ends by launching node", s.includes("exec node " + fakeHome + "/claude-gateway.mjs"), s.slice(-120));
    const sc = spawnSync(BASH, ["-n", producedStart.replace(/\\/g, "/")], { encoding: "utf8" });
    check("start.sh is valid bash", sc.status === 0, sc.stderr);
  }
}

section("Compose structure");
check("both ports are published", composeText.includes('"11434:11434"') && composeText.includes('"3456:3456"'));
check("exactly one volume mount", (composeText.match(/:\/home\/node/g) || []).length === 1);
check("no dollar signs", !composeText.includes("$"));
check("no tab characters", !composeText.includes("\t"));

// The ZimaOS / CasaOS importer treats single-line angle-bracketed tokens as
// placeholders the user must fill in, and refuses to install.
const placeholders = [...new Set(composeText.match(/<[^<>\s\r\n][^<>\r\n]*>/g) || [])];
check("no ZimaOS placeholder tokens", placeholders.length === 0, placeholders.join(" | "));

check("x-casaos block present", composeText.includes("x-casaos:"));
check("healthcheck present", composeText.includes("healthcheck:"));

process.exit(summary() ? 1 : 0);
