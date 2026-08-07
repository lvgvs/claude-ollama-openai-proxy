import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const GATEWAY = path.join(ROOT, "src", "claude-gateway.mjs");
export const FAKE_CLI = path.join(HERE, "fake-claude.mjs");

let pass = 0;
let fail = 0;
let skipped = 0;

/*
 * For checks that need something this machine may not have. A skip is neither
 * a pass nor a failure: it records that the check could not be attempted, so
 * it gets its own line rather than quietly inflating either count.
 */
export function skip(name, reason) {
  skipped++;
  console.log("  skip " + name + (reason ? "  -> " + reason : ""));
}

export function check(name, condition, detail) {
  if (condition) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (detail ? "  -> " + String(detail).slice(0, 300) : ""));
  }
}

export function section(title) {
  console.log("\n--- " + title + " ---");
}

export function summary(serverLog) {
  console.log("\n=======================================");
  console.log("passed: " + pass + "   failed: " + fail + (skipped ? "   skipped: " + skipped : ""));
  console.log("=======================================");
  if (fail && serverLog) console.log("\nserver log:\n" + serverLog.slice(-3000));
  return fail;
}

/*
 * Starts the gateway with the stub CLI wired in through CLAUDE_BIN_ARGS, so
 * the real source file runs unmodified.
 */
export function startGateway(env, stateName) {
  const state = path.join(HERE, ".tmp", stateName);
  const work = path.join(HERE, ".tmp", "work");
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(work, { recursive: true });

  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      CLAUDE_BIN: process.execPath,
      CLAUDE_BIN_ARGS: JSON.stringify([FAKE_CLI]),
      BIND_ADDRESS: "127.0.0.1",
      STATE_DIR: state,
      CLAUDE_WORKDIR: work,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ref = { child, log: "" };
  child.stdout.on("data", (d) => (ref.log += d));
  child.stderr.on("data", (d) => (ref.log += d));
  return ref;
}

export async function waitReady(url, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (e) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export async function post(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    /* not json */
  }
  return { status: r.status, text, json };
}

export async function postStream(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return { status: r.status, text: out };
}
