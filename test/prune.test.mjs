/*
 * Transcript pruning deletes files, so it gets its own suite. The important
 * property is not that it removes old transcripts, but that it removes
 * nothing else: credentials, settings and recent transcripts must survive.
 *
 *   node test/prune.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, section, summary, startGateway, waitReady } from "./helpers.mjs";

const OA = "http://127.0.0.1:13777";
const HOUR = 3600000;

// A fake ~/.claude tree in the system temp directory.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-proxy-prune-"));
const claudeDir = path.join(home, ".claude");
const projects = path.join(claudeDir, "projects");
const projectA = path.join(projects, "project-a");
const projectB = path.join(projects, "project-b");
fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });

function write(file, ageHours) {
  fs.writeFileSync(file, "{}\n");
  if (ageHours) {
    const t = new Date(Date.now() - ageHours * HOUR);
    fs.utimesSync(file, t, t);
  }
}

// Files that must be deleted: transcripts well past the retention window.
const oldA = path.join(projectA, "old-session.jsonl");
const oldB = path.join(projectB, "ancient-session.jsonl");
write(oldA, 240); // 10 days
write(oldB, 500); // ~21 days

// Files that must survive.
const freshA = path.join(projectA, "fresh-session.jsonl");
const notTranscript = path.join(projectA, "notes.txt");
const credentials = path.join(claudeDir, ".credentials.json");
const settings = path.join(claudeDir, "settings.json");
write(freshA, 1); // one hour old
write(notTranscript, 900); // very old, but not a transcript
write(credentials, 900);
write(settings, 900);

const server = startGateway(
  {
    OPENAI_PORT: "13777",
    OLLAMA_PORT: "21777",
    CLAUDE_MODELS: "sonnet",
    TRANSCRIPT_DIR: projects,
    TRANSCRIPT_RETENTION_HOURS: "72",
    SESSION_TTL_HOURS: "24",
  },
  "state-prune"
);

async function main() {
  if (!(await waitReady(OA + "/health"))) {
    console.log("gateway did not start\n" + server.log);
    process.exit(1);
  }
  // Pruning runs once at startup, so by now it has happened.

  section("Removed");
  check("a 10 day old transcript is deleted", !fs.existsSync(oldA));
  check("a 21 day old transcript is deleted", !fs.existsSync(oldB));
  check("an emptied project folder is removed", !fs.existsSync(projectB));
  check("the prune is logged", server.log.includes("Pruned"), server.log.slice(-300));

  section("Preserved");
  check("a recent transcript survives", fs.existsSync(freshA));
  check("a non-transcript file survives", fs.existsSync(notTranscript));
  check("credentials survive", fs.existsSync(credentials), "sign-in must stay permanent");
  check("settings survive", fs.existsSync(settings));
  check("a folder with content is kept", fs.existsSync(projectA));

  section("Retention floor");
  // Retention can never be shorter than the session TTL, so a transcript the
  // fingerprint table could still resume is never removed.
  const server2 = startGateway(
    {
      OPENAI_PORT: "13778",
      OLLAMA_PORT: "21778",
      CLAUDE_MODELS: "sonnet",
      TRANSCRIPT_DIR: projects,
      TRANSCRIPT_RETENTION_HOURS: "1", // shorter than the TTL below
      SESSION_TTL_HOURS: "48",
    },
    "state-prune2"
  );
  const midAge = path.join(projectA, "mid-session.jsonl");
  write(midAge, 12); // older than 1h, younger than the 48h TTL
  await waitReady("http://127.0.0.1:13778/health");
  check("a transcript younger than the session TTL is kept", fs.existsSync(midAge));
  server2.child.kill();

  section("Disabled");
  const server3 = startGateway(
    {
      OPENAI_PORT: "13779",
      OLLAMA_PORT: "21779",
      CLAUDE_MODELS: "sonnet",
      TRANSCRIPT_DIR: projects,
      TRANSCRIPT_RETENTION_HOURS: "0", // opt out entirely
    },
    "state-prune3"
  );
  const veryOld = path.join(projectA, "kept-forever.jsonl");
  write(veryOld, 5000);
  await waitReady("http://127.0.0.1:13779/health");
  check("retention 0 deletes nothing", fs.existsSync(veryOld));
  server3.child.kill();

  const failed = summary(server.log);
  server.child.kill();
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log("test runner error:", e);
  console.log(server.log.slice(-2000));
  server.child.kill();
  process.exit(1);
});
