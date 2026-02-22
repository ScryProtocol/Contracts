/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ethers } = require("ethers");
const { signChannelState } = require("../node/scp-hub/state-signing");

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TEST_HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
const TEST_PAYER_KEY = "0x7d577fdd4a1ec2aa00e7cdbf95db7fdbd7a6fd531f4be75f4fca31f6d8b3af88";
const DEFAULT_STORE = path.resolve(__dirname, "../node/scp-hub/data/store.bench.json");

function parseHubUrls(raw) {
  return String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith("http://") || x.startsWith("https://") ? x : `http://${x}`));
}

const cfg = {
  host: process.env.BENCH_HOST || "127.0.0.1",
  port: Number(process.env.BENCH_PORT || 4521),
  basePort: Number(process.env.BENCH_BASE_PORT || process.env.BENCH_PORT || 4521),
  total: Number(process.env.BENCH_TOTAL || 1000),
  concurrency: Number(process.env.BENCH_CONCURRENCY || 50),
  amount: process.env.BENCH_AMOUNT || "1000000",
  maxFee: process.env.BENCH_MAX_FEE || "5000",
  initialBalance: process.env.BENCH_INITIAL_BALANCE || "2000000000",
  storePath: process.env.BENCH_STORE_PATH || DEFAULT_STORE,
  redisUrl: process.env.BENCH_REDIS_URL || "",
  workers: Number(process.env.BENCH_WORKERS || 0),
  instances: Number(process.env.BENCH_INSTANCES || 0),
  hubUrls: parseHubUrls(process.env.BENCH_HUB_URLS),
  contextHash:
    process.env.BENCH_CONTEXT_HASH ||
    "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f",
  verbose: process.env.BENCH_VERBOSE === "1"
};

const payer = new ethers.Wallet(process.env.BENCH_PAYER_KEY || TEST_PAYER_KEY);
const payee = process.env.BENCH_PAYEE || new ethers.Wallet(TEST_HUB_KEY).address;

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: Math.max(cfg.concurrency * 2, 128)
});

function reqJson(method, endpoint, body) {
  const u = new URL(endpoint);
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        agent: httpAgent,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => {
          let parsed = {};
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch (_err) {
              parsed = { raw: data };
            }
          }
          resolve({ statusCode: res.statusCode || 0, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function storePathForInstance(index) {
  if (cfg.redisUrl || cfg.storePath === ":memory:") return cfg.storePath;
  if (index === 0) return cfg.storePath;
  const ext = path.extname(cfg.storePath);
  const stem = ext ? cfg.storePath.slice(0, -ext.length) : cfg.storePath;
  return `${stem}.i${index}${ext || ""}`;
}

async function waitForHub(urlBase, child, startupLogs, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode !== null) {
      const logs = startupLogs.join("").trim();
      throw new Error(
        `hub exited before startup (code=${child.exitCode})${logs ? `\n${logs}` : ""}`
      );
    }
    try {
      const res = await reqJson("GET", `${urlBase}/.well-known/x402`);
      if (res.statusCode === 200) return;
    } catch (_err) {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`hub did not start within ${timeoutMs}ms: ${urlBase}`);
}

async function startHubInstance(index) {
  const port = cfg.basePort + index;
  const host = cfg.host;
  const urlBase = `http://${host}:${port}`;
  const storePath = storePathForInstance(index);

  if (!cfg.redisUrl && storePath !== ":memory:") {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });
  }

  const child = spawn("node", ["node/scp-hub/server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      NETWORK: process.env.NETWORK || "sepolia",
      HUB_PRIVATE_KEY: process.env.HUB_PRIVATE_KEY || TEST_HUB_KEY,
      STORE_PATH: cfg.redisUrl ? ":memory:" : storePath,
      REDIS_URL: cfg.redisUrl || "",
      HUB_WORKERS: String(cfg.workers || 0),
      ALLOW_UNSAFE_CLUSTER: cfg.workers > 1 ? "1" : process.env.ALLOW_UNSAFE_CLUSTER || ""
    },
    stdio: cfg.verbose ? "inherit" : "pipe"
  });

  const startupLogs = [];
  if (!cfg.verbose) {
    const capture = (chunk) => {
      startupLogs.push(chunk.toString("utf8"));
      if (startupLogs.length > 40) startupLogs.shift();
    };
    if (child.stdout) child.stdout.on("data", capture);
    if (child.stderr) child.stderr.on("data", capture);
  }

  await waitForHub(urlBase, child, startupLogs);
  return { child, urlBase, startupLogs, index, port, storePath };
}

async function resolveTargets() {
  if (cfg.hubUrls.length > 0) {
    for (const urlBase of cfg.hubUrls) {
      await waitForHub(urlBase, null, []);
    }
    return {
      managed: [],
      urls: cfg.hubUrls,
      topology: `external(${cfg.hubUrls.length})`
    };
  }

  const instanceCount = Math.max(1, cfg.instances || 1);
  const managed = [];
  for (let i = 0; i < instanceCount; i += 1) {
    const hub = await startHubInstance(i);
    managed.push(hub);
  }

  return {
    managed,
    urls: managed.map((h) => h.urlBase),
    topology: `spawned(${instanceCount})`
  };
}

function formatErr(err) {
  if (!err || typeof err !== "object") return String(err);
  return {
    message: err.message || "unknown",
    stage: err.stage || "",
    statusCode: err.statusCode || 0,
    errorCode: err.errorCode || "",
    detail: err.detail || "",
    target: err.target || ""
  };
}

async function runOne(i, targetUrl) {
  const channelId = ethers.utils.hexlify(crypto.randomBytes(32));
  const paymentId = `bench_${i}_${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);
  const quoteReq = {
    invoiceId: `invoice_${i}`,
    paymentId,
    channelId,
    payee,
    asset: process.env.DEFAULT_ASSET || "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
    amount: cfg.amount,
    maxFee: cfg.maxFee,
    quoteExpiry: now + 120,
    contextHash: cfg.contextHash
  };

  const quote = await reqJson("POST", `${targetUrl}/v1/tickets/quote`, quoteReq);
  if (quote.statusCode !== 200) {
    const err = new Error("quote failed");
    err.stage = "quote";
    err.statusCode = quote.statusCode;
    err.errorCode = quote.body && quote.body.errorCode;
    err.detail = quote.body && (quote.body.message || quote.body.reason || "");
    err.target = targetUrl;
    throw err;
  }

  const totalDebit = BigInt(quote.body.totalDebit);
  const initialBalance = BigInt(cfg.initialBalance);
  if (totalDebit >= initialBalance) {
    const err = new Error("initial balance too low");
    err.stage = "precheck";
    err.detail = `initial=${initialBalance} debit=${totalDebit}`;
    err.target = targetUrl;
    throw err;
  }

  const state = {
    channelId,
    stateNonce: 1,
    balA: (initialBalance - totalDebit).toString(),
    balB: totalDebit.toString(),
    locksRoot: ZERO32,
    stateExpiry: now + 120,
    contextHash: cfg.contextHash
  };
  const sigA = await signChannelState(state, payer);
  const issue = await reqJson("POST", `${targetUrl}/v1/tickets/issue`, {
    quote: quote.body,
    channelState: state,
    sigA
  });

  if (issue.statusCode !== 200) {
    const err = new Error("issue failed");
    err.stage = "issue";
    err.statusCode = issue.statusCode;
    err.errorCode = issue.body && issue.body.errorCode;
    err.detail = issue.body && (issue.body.message || issue.body.reason || "");
    err.target = targetUrl;
    throw err;
  }
}

async function runBench(targetUrls, topology) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let cursor = 0;
  let ok = 0;
  const errors = [];
  const perTarget = {};
  for (const u of targetUrls) {
    perTarget[u] = { attempted: 0, success: 0, failed: 0 };
  }

  async function worker() {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= cfg.total) return;

      const targetUrl = targetUrls[i % targetUrls.length];
      perTarget[targetUrl].attempted += 1;

      try {
        await runOne(i, targetUrl);
        ok += 1;
        perTarget[targetUrl].success += 1;
      } catch (err) {
        perTarget[targetUrl].failed += 1;
        errors.push(formatErr(err));
      }
    }
  }

  const workers = [];
  const n = Math.max(1, Math.min(cfg.concurrency, cfg.total));
  for (let i = 0; i < n; i += 1) workers.push(worker());
  await Promise.all(workers);

  const elapsedMs = Date.now() - t0;
  const elapsedSec = elapsedMs / 1000;
  const failed = cfg.total - ok;

  const summary = {
    startedAt,
    topology,
    mode: cfg.workers > 1 ? `cluster(${cfg.workers})` : "single",
    storage: cfg.redisUrl ? "redis" : cfg.storePath,
    targets: targetUrls,
    attempted: cfg.total,
    concurrency: cfg.concurrency,
    success: ok,
    failed,
    elapsedSec: Number(elapsedSec.toFixed(3)),
    tpsSuccess: Number((ok / (elapsedSec || 1)).toFixed(2)),
    tpsAttempted: Number((cfg.total / (elapsedSec || 1)).toFixed(2)),
    perTarget,
    errorSamples: errors.slice(0, 10)
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function stopHub(proc) {
  if (!proc || proc.killed) return;
  proc.kill("SIGTERM");
  await sleep(300);
  if (!proc.killed) proc.kill("SIGKILL");
}

async function main() {
  let targets = [];
  try {
    targets = await resolveTargets();
    await runBench(targets.urls, targets.topology);
  } finally {
    for (const h of targets.managed || []) {
      await stopHub(h.child);
    }
    httpAgent.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
