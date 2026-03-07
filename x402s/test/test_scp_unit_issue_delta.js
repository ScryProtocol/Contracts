const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

const { startLocalChain, localAccount } = require("./helpers/local-chain");

describe("SCP Issue Delta Unit", function () {
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4321;
  const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
  const storePath = path.resolve(__dirname, "../node/scp-hub/data/store.issue-delta-test.json");
  const ZERO32 = "0x" + "0".repeat(64);
  const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
  const TEST_PAYER_KEY = "0x7d577fdd4a1ec2aa00e7cdbf95db7fdbd7a6fd531f4be75f4fca31f6d8b3af88";
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";

let createHubServer;
let hub;
  let chain;
  let contract;
  let hubWallet;
  let payerWallet;
  let signChannelState;

  function readStore() {
    return fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, "utf8")) : {};
  }

  function writeStore(mutator) {
    const state = readStore();
    mutator(state);
    fs.writeFileSync(storePath, JSON.stringify(state), "utf8");
  }

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

  async function makeQuote(channelId, paymentId, asset = ethers.constants.AddressZero) {
    const now = Math.floor(Date.now() / 1000);
    const res = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {
      invoiceId: `inv_${paymentId}`,
      paymentId,
      channelId,
      payee: "0x1111111111111111111111111111111111111111",
      asset,
      amount: "100",
      maxFee: "0",
      quoteExpiry: now + 120,
      contextHash: ZERO32
    });
    expect(res.statusCode).to.eq(200);
    return res.body;
  }

  async function openCollectibleChannel(totalBalance = "6000", expiryOffsetSec = 3600) {
    const amount = ethers.BigNumber.from(totalBalance);
    const nowTs = (await chain.provider.getBlock("latest")).timestamp;
    const salt = ethers.utils.hexlify(crypto.randomBytes(32));
    const tx = await contract
      .connect(payerWallet)
      .openChannel(
        hubWallet.address,
        ethers.constants.AddressZero,
        amount,
        300,
        nowTs + expiryOffsetSec,
        salt,
        2,
        { value: amount }
      );
    const rc = await tx.wait(1);
    return rc.events.find((e) => e.event === "ChannelOpened").args.channelId;
  }

  function seedExistingChannel(channelId) {
    const nowTs = Math.floor(Date.now() / 1000);
    writeStore((s) => {
      if (!s.channels || typeof s.channels !== "object") s.channels = {};
      s.channels[channelId] = {
        channelId,
        latestNonce: 1,
        status: "open",
        latestState: {
          channelId,
          stateNonce: 1,
          balA: "5900",
          balB: "100",
          locksRoot: ZERO32,
          stateExpiry: nowTs + 600,
          contextHash: ZERO32
        },
        participantA: payerWallet.address,
        participantB: hubWallet.address,
        asset: ethers.constants.AddressZero,
        sigA: null,
        sigB: null
      };
    });
  }

  before(async function () {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });

    chain = await startLocalChain({
      chainId: 8453,
      accounts: [
        localAccount("hub", HUB_KEY, "100"),
        localAccount("payer", TEST_PAYER_KEY, "100")
      ]
    });
    hubWallet = chain.wallets.hub;
    payerWallet = chain.wallets.payer;
    contract = await chain.deploy(hubWallet);

    process.env.HOST = HUB_HOST;
    process.env.PORT = String(HUB_PORT);
    process.env.STORE_PATH = storePath;
    process.env.FEE_BASE = "0";
    process.env.FEE_BPS = "0";
    process.env.GAS_SURCHARGE = "0";
    process.env.NETWORK = "base";
    process.env.RPC_URL = chain.rpcUrl;
    process.env.CONTRACT_ADDRESS = contract.address;
    process.env.HUB_PRIVATE_KEY = HUB_KEY;

    delete require.cache[require.resolve("../node/scp-hub/server")];
    delete require.cache[require.resolve("../node/scp-hub/state-signing")];
    ({ createServer: createHubServer } = require("../node/scp-hub/server"));
    ({ signChannelState } = require("../node/scp-hub/state-signing"));

    hub = createHubServer();
    await new Promise((resolve) => hub.listen(HUB_PORT, HUB_HOST, resolve));
  });

  after(async function () {
    await new Promise((resolve) => hub.close(resolve));
    await chain.close();
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });
  });

  it("accepts continuation issue on a real collectible channel", async function () {
    const channelId = await openCollectibleChannel();
    const paymentId = `pay_collectible_${Date.now()}`;
    const quote = await makeQuote(channelId, paymentId);
    seedExistingChannel(channelId);

    const nowTs = Math.floor(Date.now() / 1000);
    const state = {
      channelId,
      stateNonce: 2,
      balA: "5800",
      balB: "200",
      locksRoot: ZERO32,
      stateExpiry: nowTs + 120,
      contextHash: ZERO32
    };
    const sigA = await signChannelState(state, payerWallet);
    const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote,
      channelState: state,
      sigA
    });
    expect(issue.statusCode).to.eq(200);
    expect(issue.body.channelAck).to.be.an("object");
  });

  it("rejects continuation issue after the on-chain channel has expired", async function () {
    const channelId = await openCollectibleChannel("6000", 10);
    seedExistingChannel(channelId);
    const realNow = Date.now;
    Date.now = () => realNow() + 15_000;

    try {
      const paymentId = `pay_closed_${Date.now()}`;
      const quote = await makeQuote(channelId, paymentId);
      const nextState = {
        channelId,
        stateNonce: 2,
        balA: "5800",
        balB: "200",
        locksRoot: ZERO32,
        stateExpiry: Math.floor(Date.now() / 1000) + 120,
        contextHash: ZERO32
      };
      const sigA = await signChannelState(nextState, payerWallet);
      const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
        quote,
        channelState: nextState,
        sigA
      });
      expect(issue.statusCode).to.eq(409);
      expect(issue.body.errorCode).to.eq("SCP_009_POLICY_VIOLATION");
      expect(String(issue.body.message || "")).to.contain("channel expired on-chain");
    } finally {
      Date.now = realNow;
    }
  });

  it("rejects first issue when the quoted asset does not match the on-chain channel asset", async function () {
    const channelId = await openCollectibleChannel("1000");
    const paymentId = `pay_asset_${Date.now()}`;
    const quote = await makeQuote(channelId, paymentId, USDC_BASE);

    const state = {
      channelId,
      stateNonce: 1,
      balA: "900",
      balB: "100",
      locksRoot: ZERO32,
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: ZERO32
    };
    const sigA = await signChannelState(state, payerWallet);
    const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote,
      channelState: state,
      sigA
    });
    expect(issue.statusCode).to.eq(409);
    expect(issue.body.errorCode).to.eq("SCP_009_POLICY_VIOLATION");
    expect(String(issue.body.message || "")).to.contain("does not match quoted asset");
  });
});
