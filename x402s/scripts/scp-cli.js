#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;

function runNode(script, extraArgs = []) {
  const result = spawnSync(NODE, [script, ...extraArgs], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  process.exit(result.status === null ? 1 : result.status);
}

function runWithWizard(target, extraArgs = []) {
  runNode(path.join("scripts", "with-wizard.js"), [target, ...extraArgs]);
}

function printUsage() {
  console.log(`Usage:
  npx scp help
  npx scp init
  npx scp hub [network|hubUrl]
  npx scp pay <url> [hub|direct]
  npx scp pay <channelId> <amount>
  npx scp payments
  npx scp channel <channelId>
  npx scp open <0xAddr> <network> <asset> <amount>
  npx scp fund <channelId> <amount>
  npx scp close <channelId>
  npx scp channels
  npx scp status

Aliases:
  channels -> list
  init -> scp:wizard

Examples:
  npx scp hub
  npx scp hub base
  npx scp channel 0xChannelId
  npx scp pay https://api.example.com/v1/data
  npx scp pay https://api.example.com/v1/data direct
  npx scp open 0xHubAddress sepolia eth 0.01
  npx scp channels

Local fallback:
  npm run scp -- pay https://api.example.com/v1/data`);
}

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const cmd = String(args[0] || "help").toLowerCase();
const rest = args[1] === "--" ? args.slice(2) : args.slice(1);

switch (cmd) {
  case "help":
    printUsage();
    break;
  case "init":
  case "wizard":
    runNode(path.join("scripts", "startup-wizard.js"));
    break;
  case "pay":
    runWithWizard(path.join("node", "scp-agent", "pay-url.js"), rest);
    break;
  case "hub":
    runNode(path.join("scripts", "scp-hub.js"), rest);
    break;
  case "payments":
    runNode(path.join("node", "scp-agent", "show-payments.js"), rest);
    break;
  case "channel":
  case "inspect":
    runWithWizard(path.join("node", "scp-agent", "channel-cli.js"), ["inspect", ...rest]);
    break;
  case "open":
    runWithWizard(path.join("node", "scp-agent", "channel-cli.js"), ["open", ...rest]);
    break;
  case "fund":
    runWithWizard(path.join("node", "scp-agent", "channel-cli.js"), ["fund", ...rest]);
    break;
  case "close":
    runWithWizard(path.join("node", "scp-agent", "channel-cli.js"), ["close", ...rest]);
    break;
  case "channels":
  case "list":
    runWithWizard(path.join("node", "scp-agent", "channel-cli.js"), ["list", ...rest]);
    break;
  case "status":
    runWithWizard(path.join("node", "scp-agent", "channel-cli.js"), ["status", ...rest]);
    break;
  case "dash":
    runNode(path.join("node", "scp-agent", "dashboard.js"), rest);
    break;
  case "light":
    runWithWizard(path.join("skill", "scp-light", "scripts", "auto_402_hub_pay.js"), rest);
    break;
  default:
    console.error(`Unknown scp command: ${cmd}`);
    console.error("");
    printUsage();
    process.exit(1);
}
