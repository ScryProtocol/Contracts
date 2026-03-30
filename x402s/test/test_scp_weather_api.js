const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

const { startLocalChain, localAccount } = require("./helpers/local-chain");
const { signChannelState } = require("../node/scp-hub/state-signing");
const { signTicketDraft } = require("../node/scp-hub/ticket");

describe("SCP Weather API", function () {
  const API_HOST = "127.0.0.1";
  const API_PORT = 4380;
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4381;
  const HUB_ENDPOINT = `http://${HUB_HOST}:${HUB_PORT}`;
  const OFFERS_FILE = path.resolve(__dirname, "./weather.offers.test.json");
  const ZERO32 = ethers.constants.HashZero;

  const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
  const PAYEE_KEY = "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555";
  const PAYER_KEY = "0x7d577fdd4a1ec2aa00e7cdbf95db7fdbd7a6fd531f4be75f4fca31f6d8b3af88";

  const hubWallet = new ethers.Wallet(HUB_KEY);
  const payeeWallet = new ethers.Wallet(PAYEE_KEY);

  let chain;
  let payerWallet;
  let contract;
  let hubServer;
  let apiServer;
  let createWeatherServer;
  const issuedByPaymentId = new Map();

  function buildContextHash(fields) {
    return ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(JSON.stringify(fields, Object.keys(fields).sort()))
    );
  }

  function reqJson(method, endpoint, headers = {}) {
    const u = new URL(endpoint);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method,
          hostname: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`,
          headers
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
      req.end();
    });
  }

  async function fetchPremiumOffer(scheme) {
    const res = await reqJson("GET", `http://${API_HOST}:${API_PORT}/premium`);
    expect(res.statusCode).to.eq(402);
    const offer = res.body.accepts.find((entry) => entry.scheme === scheme);
    expect(offer, `missing offer for scheme ${scheme}`).to.exist;
    return offer;
  }

  before(async function () {
    chain = await startLocalChain({
      chainId: 8453,
      accounts: [
        localAccount("payer", PAYER_KEY, "100"),
        localAccount("payee", PAYEE_KEY, "100"),
        localAccount("hub", HUB_KEY, "100")
      ]
    });
    payerWallet = chain.wallets.payer;
    contract = await chain.deploy(chain.wallets.hub);

    fs.writeFileSync(OFFERS_FILE, JSON.stringify({
      offers: [
        {
          network: `eip155:${chain.chainId}`,
          modes: ["hub", "direct"],
          assets: [
            {
              symbol: "ETH",
              address: ethers.constants.AddressZero,
              decimals: 18
            }
          ],
          prices: ["0.0000001"],
          hubName: "pay.eth",
          hubEndpoint: HUB_ENDPOINT
        }
      ],
      pathPrices: {
        "/premium": { ETH: "0.0000001" }
      }
    }), "utf8");

    process.env.HOST = API_HOST;
    process.env.PORT = String(API_PORT);
    process.env.PAYEE_PRIVATE_KEY = PAYEE_KEY;
    process.env.OFFERS_FILE = OFFERS_FILE;
    process.env.RPC_URL = chain.rpcUrl;
    process.env.CONTRACT_ADDRESS = contract.address;
    process.env.WEATHER_PAYMENT_MODE = "per_request";

    delete require.cache[require.resolve("../node/scp-demo/weather-api/server")];
    ({ createWeatherServer } = require("../node/scp-demo/weather-api/server"));

    hubServer = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/.well-known/x402") {
        const body = JSON.stringify({ address: hubWallet.address });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/v1/payments/")) {
        const paymentId = decodeURIComponent(req.url.split("/").pop() || "");
        const ticketId = issuedByPaymentId.get(paymentId) || "";
        const body = JSON.stringify({ status: "issued", ticketId });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const body = JSON.stringify({ error: "not found" });
      res.writeHead(404, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });

    apiServer = createWeatherServer();
    await new Promise((resolve) => hubServer.listen(HUB_PORT, HUB_HOST, resolve));
    await new Promise((resolve) => apiServer.listen(API_PORT, API_HOST, resolve));
  });

  after(async function () {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    if (hubServer) await new Promise((resolve) => hubServer.close(resolve));
    if (chain) await chain.close();
    if (fs.existsSync(OFFERS_FILE)) fs.rmSync(OFFERS_FILE, { force: true });
  });

  it("rejects fabricated direct payments without a real on-chain channel", async function () {
    const offer = await fetchPremiumOffer("statechannel-direct-v1");
    const ext = offer.extensions["statechannel-direct-v1"];
    const invoiceId = ext.invoiceId;
    const paymentId = `pay_fake_direct_${Date.now()}`;
    const amount = offer.maxAmountRequired;
    const contextHash = buildContextHash({
      payee: payeeWallet.address,
      resource: offer.resource,
      method: "GET",
      invoiceId,
      paymentId,
      amount,
      asset: offer.asset
    });
    const state = {
      channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
      stateNonce: 1,
      balA: ethers.utils.parseEther("1").sub(amount).toString(),
      balB: amount,
      locksRoot: ZERO32,
      stateExpiry: Math.floor(Date.now() / 1000) + 3600,
      contextHash
    };
    const sigA = await signChannelState(state, payerWallet, {
      chainId: chain.chainId,
      contractAddress: contract.address
    });
    const paymentHeader = {
      scheme: "statechannel-direct-v1",
      invoiceId,
      paymentId,
      direct: {
        payer: payerWallet.address,
        payee: payeeWallet.address,
        asset: offer.asset,
        amount,
        expiry: Math.floor(Date.now() / 1000) + 120,
        invoiceId,
        paymentId,
        channelState: state,
        sigA
      }
    };

    const paid = await reqJson("GET", `http://${API_HOST}:${API_PORT}/premium`, {
      "payment-signature": JSON.stringify(paymentHeader)
    });

    expect(paid.statusCode).to.eq(402);
    expect(String(paid.body.error || "")).to.contain("channel does not exist on-chain");
  });

  it("accepts a valid direct payment on a real on-chain channel", async function () {
    const offer = await fetchPremiumOffer("statechannel-direct-v1");
    const ext = offer.extensions["statechannel-direct-v1"];
    const invoiceId = ext.invoiceId;
    const paymentId = `pay_real_direct_${Date.now()}`;
    const amount = offer.maxAmountRequired;
    const totalBalance = ethers.utils.parseEther("1");
    const block = await chain.provider.getBlock("latest");
    const openTx = await contract
      .connect(payerWallet)
      .openChannel(
        payeeWallet.address,
        ethers.constants.AddressZero,
        totalBalance,
        300,
        block.timestamp + 3600,
        ethers.utils.hexlify(crypto.randomBytes(32)),
        0,
        { value: totalBalance }
      );
    const openRc = await openTx.wait(1);
    const channelId = openRc.events.find((e) => e.event === "ChannelOpened").args.channelId;
    const contextHash = buildContextHash({
      payee: payeeWallet.address,
      resource: offer.resource,
      method: "GET",
      invoiceId,
      paymentId,
      amount,
      asset: offer.asset
    });
    const state = {
      channelId,
      stateNonce: 1,
      balA: totalBalance.sub(amount).toString(),
      balB: amount,
      locksRoot: ZERO32,
      stateExpiry: Math.floor(Date.now() / 1000) + 3600,
      contextHash
    };
    const sigA = await signChannelState(state, payerWallet, {
      chainId: chain.chainId,
      contractAddress: contract.address
    });
    const paymentHeader = {
      scheme: "statechannel-direct-v1",
      invoiceId,
      paymentId,
      direct: {
        payer: payerWallet.address,
        payee: payeeWallet.address,
        asset: offer.asset,
        amount,
        expiry: Math.floor(Date.now() / 1000) + 120,
        invoiceId,
        paymentId,
        channelState: state,
        sigA
      }
    };

    const paid = await reqJson("GET", `http://${API_HOST}:${API_PORT}/premium`, {
      "payment-signature": JSON.stringify(paymentHeader)
    });

    expect(paid.statusCode).to.eq(200);
    expect(paid.body.ok).to.eq(true);
    expect(paid.body.receipt.paymentId).to.eq(paymentId);
  });

  it("replays the same hub payment with the cached response instead of re-consuming it", async function () {
    const offer = await fetchPremiumOffer("statechannel-hub-v1");
    const ext = offer.extensions["statechannel-hub-v1"];
    const invoiceId = ext.invoiceId;
    const paymentId = `pay_hub_replay_${Date.now()}`;
    const amount = offer.maxAmountRequired;
    const draft = {
      ticketId: `tkt_${Date.now()}`,
      hub: hubWallet.address,
      payee: payeeWallet.address,
      invoiceId,
      paymentId,
      asset: offer.asset,
      amount,
      feeCharged: "0",
      totalDebit: amount,
      expiry: Math.floor(Date.now() / 1000) + 120,
      policyHash: ethers.utils.hexlify(crypto.randomBytes(32))
    };
    const sig = await signTicketDraft(draft, hubWallet);
    issuedByPaymentId.set(paymentId, draft.ticketId);
    const paymentHeader = {
      scheme: "statechannel-hub-v1",
      invoiceId,
      paymentId,
      ticket: { ...draft, sig }
    };

    const first = await reqJson("GET", `http://${API_HOST}:${API_PORT}/premium`, {
      "payment-signature": JSON.stringify(paymentHeader)
    });
    const second = await reqJson("GET", `http://${API_HOST}:${API_PORT}/premium`, {
      "payment-signature": JSON.stringify(paymentHeader)
    });

    expect(first.statusCode).to.eq(200);
    expect(second.statusCode).to.eq(200);
    expect(second.body).to.deep.equal(first.body);
  });
});
