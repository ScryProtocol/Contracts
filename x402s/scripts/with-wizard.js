/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const WIZARD_PATH = path.join(__dirname, "startup-wizard.js");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") {
      process.env[m[1]] = m[2];
    }
  }
}

function ensureConfig() {
  if (fs.existsSync(ENV_PATH)) return;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Missing .env and no interactive terminal available.");
    console.error("Run `npm run scp:wizard` once to create config files.");
    process.exit(1);
  }

  console.log("No .env found. Running startup wizard...");
  const run = spawnSync(process.execPath, [WIZARD_PATH], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });

  if (run.status !== 0) {
    process.exit(typeof run.status === "number" ? run.status : 1);
  }

  if (!fs.existsSync(ENV_PATH)) {
    console.error("Startup wizard finished but .env was not created.");
    process.exit(1);
  }
}

function main() {
  const targetScript = process.argv[2];
  const args = process.argv.slice(3);

  if (!targetScript) {
    console.error("Usage: node scripts/with-wizard.js <script> [...args]");
    process.exit(1);
  }

  ensureConfig();
  loadEnv(ENV_PATH);

  const resolvedTarget = path.isAbsolute(targetScript)
    ? targetScript
    : path.resolve(ROOT, targetScript);

  if (!fs.existsSync(resolvedTarget)) {
    console.error(`Target script not found: ${resolvedTarget}`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [resolvedTarget, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });

  const forwardSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const sig of forwardSignals) {
    process.on(sig, () => {
      if (!child.killed) child.kill(sig);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });
}

main();
