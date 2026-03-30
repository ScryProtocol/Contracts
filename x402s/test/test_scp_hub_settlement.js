const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

const { startLocalChain, localAccount } = require("./helpers/local-chain");
const { signChannelState } = require("../node/scp-hub/state-signing");
const { signPayeeAuth } = require("../node/scp-common/payee-auth");

describe("SCP Hub Settlement", function () {
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4385;
  const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
  const STORE_PATH = path.resolve(__dirname, "../node/scp-hub/data/store.settlement-test.json");
  const ZERO32 = ethers.constants.HashZero;
  const ZERO_ADDR = ethers.constants.AddressZero;

  const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
  const PAYEE_KEY = "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555";

  let chain;
  let hubServer;
  let createHubServer;
  let hubWallet;
  let payeeWallet;

  function now() {
    return Math.floor(Date.now() / 1000);
  }

  function readStore() {
    return fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) : {};
  }

  function writeStore(state) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(state), "utf8");
  }

  function reqJson(method, endpoint, body, headers = {}) {
    const u = new URL(endpoint);
    const payload = body ? JSON.stringify(body) : "";
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method,
          hostname: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`,
          headers: {
            "content-type": "application/json",
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
            ...headers
          }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode,
              body: data ? JSON.parse(data) : {},
              headers: res.headers
            });
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  before(async function () {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    if (fs.existsSync(STORE_PATH)) fs.rmSync(STORE_PATH, { force: true });

    chain = await startLocalChain({
      chainId: 8453,
      accounts: [
        localAccount("hub", HUB_KEY, "100"),
        localAccount("payee", PAYEE_KEY, "100")
      ]
    });
    hubWallet = chain.wallets.hub;
    payeeWallet = chain.wallets.payee;

    process.env.HOST = HUB_HOST;
    process.env.PORT = String(HUB_PORT);
    process.env.STORE_PATH = STORE_PATH;
    process.env.NETWORK = "base";
    process.env.RPC_URL = chain.rpcUrl;
    process.env.HUB_PRIVATE_KEY = HUB_KEY;
    process.env.FEE_BASE = "0";
    process.env.FEE_BPS = "0";
    process.env.GAS_SURCHARGE = "0";

    delete require.cache[require.resolve("../node/scp-hub/server")];
    ({ createServer: createHubServer } = require("../node/scp-hub/server"));

    hubServer = createHubServer();
    await new Promise((resolve) => hubServer.listen(HUB_PORT, HUB_HOST, resolve));
  });

  after(async function () {
    if (hubServer) await new Promise((resolve) => hubServer.close(resolve));
    if (chain) await chain.close();
    if (fs.existsSync(STORE_PATH)) fs.rmSync(STORE_PATH, { force: true });
  });

  it("rejects direct settlement while an open hub-payee channel still has collectible balB", async function () {
    const payee = payeeWallet.address.toLowerCase();
    const channelId = ethers.utils.hexlify(crypto.randomBytes(32));
    const latestState = {
      channelId,
      stateNonce: 1,
      balA: "9000",
      balB: "1000",
      locksRoot: ZERO32,
      stateExpiry: now() + 3600,
      contextHash: ZERO32
    };
    const sigA = await signChannelState(latestState, hubWallet);

    writeStore({
      quotes: {},
      payments: {},
      payeeLedger: {
        [payee]: [
          {
            seq: 1,
            createdAt: now(),
            paymentId: "pay_settle_guard_1",
            invoiceId: "inv_settle_guard_1",
            ticketId: "tkt_settle_guard_1",
            amount: "1000",
            asset: ZERO_ADDR,
            status: "issued"
          }
        ]
      },
      nextSeq: 2,
      hubChannels: {
        [payee]: {
          channelId,
          payee: payeeWallet.address,
          asset: ZERO_ADDR,
          totalDeposit: "10000",
          balA: "9000",
          balB: "1000",
          status: "open",
          nonce: 1,
          latestState,
          sigA
        }
      },
      payerCredits: {}
    });

    const body = {
      payee: payeeWallet.address,
      asset: ZERO_ADDR,
      mode: "direct"
    };
    const timestamp = now();
    const sig = await signPayeeAuth({
      method: "POST",
      path: "/v1/payee/settle",
      payee: payeeWallet.address,
      timestamp,
      body
    }, payeeWallet);

    const res = await reqJson("POST", `${HUB_URL}/v1/payee/settle`, body, {
      "x-scp-payee-timestamp": String(timestamp),
      "x-scp-payee-signature": sig
    });

    expect(res.statusCode).to.eq(409);
    expect(res.body.errorCode).to.eq("SCP_009_POLICY_VIOLATION");
    expect(String(res.body.message || "")).to.contain("collectible balB");

    const store = readStore();
    expect(store.payeeLedger[payee][0].status).to.eq("issued");
    expect(store.payeeLedger[payee][0].settleTx).to.eq(undefined);
  });
});
