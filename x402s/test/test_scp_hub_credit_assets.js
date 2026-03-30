const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

const { startLocalChain, localAccount } = require("./helpers/local-chain");
const { signChannelState } = require("../node/scp-hub/state-signing");
const { signPayeeAuth } = require("../node/scp-common/payee-auth");

describe("SCP Hub Asset-Scoped Credits", function () {
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4386;
  const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
  const STORE_PATH = path.resolve(__dirname, "../node/scp-hub/data/store.credit-assets-test.json");
  const ZERO32 = ethers.constants.HashZero;
  const ZERO_ADDR = ethers.constants.AddressZero;
  const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";

  const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
  const PAYEE_KEY = "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555";
  const PAYER_KEY = "0x7d577fdd4a1ec2aa00e7cdbf95db7fdbd7a6fd531f4be75f4fca31f6d8b3af88";

  let chain;
  let hubServer;
  let createHubServer;
  let contract;
  let hubWallet;
  let payeeWallet;
  let payerWallet;

  function now() {
    return Math.floor(Date.now() / 1000);
  }

  function emptyStore(overrides = {}) {
    return {
      quotes: {},
      payments: {},
      paymentsByTicketId: {},
      paymentIdsByChannel: {},
      paymentIdsByPayee: {},
      channels: {},
      hubChannels: {},
      payeeLedger: {},
      payerCredits: {},
      legacyScalarCredits: {},
      nextSeq: 1,
      ...overrides
    };
  }

  function readStore() {
    return fs.existsSync(STORE_PATH) ? JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) : emptyStore();
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

  async function openRealHubChannel(totalBalance = "1000000") {
    const amount = ethers.BigNumber.from(String(totalBalance));
    const block = await chain.provider.getBlock("latest");
    const salt = ethers.utils.hexlify(crypto.randomBytes(32));
    const tx = await contract.connect(payerWallet).openChannel(
      hubWallet.address,
      ZERO_ADDR,
      amount,
      300,
      block.timestamp + 86400,
      salt,
      2,
      { value: amount }
    );
    const rc = await tx.wait(1);
    return {
      channelId: rc.events.find((e) => e.event === "ChannelOpened").args.channelId,
      totalBalance: BigInt(amount.toString())
    };
  }

  function trackedChannel({ channelId, totalBalance, balB = "0", asset = ZERO_ADDR, payer = payerWallet.address, nonce = 1 }) {
    const balBBn = BigInt(balB);
    const totalBn = BigInt(totalBalance);
    return {
      channelId,
      latestNonce: nonce,
      status: "open",
      asset,
      participantA: payer,
      latestState: {
        channelId,
        stateNonce: nonce,
        balA: (totalBn - balBBn).toString(),
        balB: balBBn.toString(),
        locksRoot: ZERO32,
        stateExpiry: now() + 3600,
        contextHash: ZERO32
      }
    };
  }

  async function quoteAndIssueTracked({ paymentId, invoiceId, tracked, payee, amount = "5000" }) {
    const quote = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {
      invoiceId,
      paymentId,
      channelId: tracked.channelId,
      payee,
      asset: tracked.asset,
      amount,
      maxFee: "0",
      quoteExpiry: now() + 120,
      contextHash: ZERO32
    });
    expect(quote.statusCode).to.eq(200);
    const totalDebit = BigInt(quote.body.totalDebit);
    const payerCredit = BigInt(quote.body.payerCredit || "0");
    const netDebit = totalDebit > payerCredit ? totalDebit - payerCredit : 0n;
    const state = {
      channelId: tracked.channelId,
      stateNonce: Number(tracked.latestNonce) + 1,
      balA: (BigInt(tracked.latestState.balA) - netDebit).toString(),
      balB: (BigInt(tracked.latestState.balB) + netDebit).toString(),
      locksRoot: ZERO32,
      stateExpiry: now() + 120,
      contextHash: ZERO32
    };
    const sigA = await signChannelState(state, payerWallet);
    const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: quote.body,
      channelState: state,
      sigA
    });
    expect(issue.statusCode).to.eq(200);
    return { quote: quote.body, issue: issue.body, state };
  }

  async function payeeAuthHeaders(pathname, body) {
    const timestamp = now();
    const sig = await signPayeeAuth({
      method: "POST",
      path: pathname,
      payee: payeeWallet.address,
      timestamp,
      body
    }, payeeWallet);
    return {
      "x-scp-payee-timestamp": String(timestamp),
      "x-scp-payee-signature": sig
    };
  }

  before(async function () {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    if (fs.existsSync(STORE_PATH)) fs.rmSync(STORE_PATH, { force: true });

    chain = await startLocalChain({
      chainId: 8453,
      accounts: [
        localAccount("hub", HUB_KEY, "100"),
        localAccount("payee", PAYEE_KEY, "100"),
        localAccount("payer", PAYER_KEY, "100")
      ]
    });
    contract = await chain.deploy(chain.wallets.hub);
    hubWallet = chain.wallets.hub;
    payeeWallet = chain.wallets.payee;
    payerWallet = chain.wallets.payer;

    process.env.HOST = HUB_HOST;
    process.env.PORT = String(HUB_PORT);
    process.env.STORE_PATH = STORE_PATH;
    process.env.NETWORK = "base";
    process.env.RPC_URL = chain.rpcUrl;
    process.env.CONTRACT_ADDRESS = contract.address;
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

  beforeEach(function () {
    writeStore(emptyStore());
  });

  it("quotes only same-asset credit and ignores legacy scalar balances", async function () {
    const opened = await openRealHubChannel("1000000");
    const tracked = trackedChannel({
      channelId: opened.channelId,
      totalBalance: opened.totalBalance.toString(),
      balB: "1200",
      nonce: 1
    });

    writeStore(emptyStore({
      channels: {
        [tracked.channelId]: tracked
      },
      payerCredits: {
        [payerWallet.address.toLowerCase()]: {
          [ZERO_ADDR.toLowerCase()]: "900",
          [USDC_ADDR.toLowerCase()]: "7000"
        }
      },
      legacyScalarCredits: {
        [payerWallet.address.toLowerCase()]: "5000"
      }
    }));

    const quote = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {
      invoiceId: `inv_quote_${Date.now()}`,
      paymentId: `pay_quote_${Date.now()}`,
      channelId: tracked.channelId,
      payee: payeeWallet.address,
      asset: ZERO_ADDR,
      amount: "5000",
      maxFee: "0",
      quoteExpiry: now() + 120,
      contextHash: ZERO32
    });

    expect(quote.statusCode).to.eq(200);
    expect(quote.body.payerCredit).to.eq("900");

    const balance = await reqJson("GET", `${HUB_URL}/v1/credit/balance?address=${payerWallet.address}`);
    expect(balance.statusCode).to.eq(200);
    expect(balance.body.creditsByAsset[ZERO_ADDR.toLowerCase()]).to.eq("900");
    expect(balance.body.creditsByAsset[USDC_ADDR.toLowerCase()]).to.eq("7000");
    expect(balance.body.legacyScalarCredit).to.eq("5000");
    expect(balance.body.credit).to.eq("5000");
  });

  it("issue consumes same-asset credit and refund restores only that asset bucket", async function () {
    const opened = await openRealHubChannel("1000000");
    const tracked = trackedChannel({
      channelId: opened.channelId,
      totalBalance: opened.totalBalance.toString(),
      balB: "2000",
      nonce: 1
    });

    writeStore(emptyStore({
      channels: {
        [tracked.channelId]: tracked
      },
      payerCredits: {
        [payerWallet.address.toLowerCase()]: {
          [ZERO_ADDR.toLowerCase()]: "1200",
          [USDC_ADDR.toLowerCase()]: "7000"
        }
      }
    }));

    const bundle = await quoteAndIssueTracked({
      paymentId: `pay_issue_${Date.now()}`,
      invoiceId: `inv_issue_${Date.now()}`,
      tracked,
      payee: payeeWallet.address
    });

    const afterIssue = readStore();
    expect(afterIssue.payerCredits[payerWallet.address.toLowerCase()][ZERO_ADDR.toLowerCase()]).to.eq("0");
    expect(afterIssue.payerCredits[payerWallet.address.toLowerCase()][USDC_ADDR.toLowerCase()]).to.eq("7000");
    expect(afterIssue.payerCredits[payeeWallet.address.toLowerCase()][ZERO_ADDR.toLowerCase()]).to.eq("5000");

    const refundBody = {
      ticketId: bundle.issue.ticketId,
      refundAmount: bundle.quote.ticketDraft.amount,
      reason: "asset-test"
    };
    const refund = await reqJson("POST", `${HUB_URL}/v1/refunds`, refundBody, await payeeAuthHeaders("/v1/refunds", refundBody));
    expect(refund.statusCode).to.eq(200);

    const afterRefund = readStore();
    expect(afterRefund.payerCredits[payeeWallet.address.toLowerCase()][ZERO_ADDR.toLowerCase()] || "0").to.eq("0");
    expect(afterRefund.payerCredits[payeeWallet.address.toLowerCase()][USDC_ADDR.toLowerCase()] || "0").to.eq("0");
    expect(afterRefund.payments[bundle.quote.paymentId].status).to.eq("refunded");
  });

  it("close and confirm-close only consume the channel asset bucket", async function () {
    const opened = await openRealHubChannel("1000000");
    const tracked = trackedChannel({
      channelId: opened.channelId,
      totalBalance: opened.totalBalance.toString(),
      balB: "1500",
      nonce: 1
    });

    writeStore(emptyStore({
      channels: {
        [tracked.channelId]: tracked
      },
      payerCredits: {
        [payerWallet.address.toLowerCase()]: {
          [ZERO_ADDR.toLowerCase()]: "600",
          [USDC_ADDR.toLowerCase()]: "7000"
        }
      }
    }));

    const closeSig = await payerWallet.signMessage(ethers.utils.arrayify(tracked.channelId));
    const closeRes = await reqJson("POST", `${HUB_URL}/v1/channels/${tracked.channelId}/close`, { sig: closeSig });
    expect(closeRes.statusCode).to.eq(200);
    expect(closeRes.body.creditApplied).to.eq("600");
    let store = readStore();
    expect(store.channels[tracked.channelId].pendingCloseCredit.amount).to.eq("600");
    expect(store.channels[tracked.channelId].pendingCloseCredit.asset).to.eq(ZERO_ADDR.toLowerCase());

    const confirmChannelId = ethers.utils.hexlify(crypto.randomBytes(32));
    store = emptyStore({
      channels: {
        [confirmChannelId]: {
          channelId: confirmChannelId,
          participantA: payerWallet.address,
          asset: ZERO_ADDR,
          status: "open",
          pendingCloseCredit: {
            amount: "600",
            asset: ZERO_ADDR
          }
        }
      },
      payerCredits: {
        [payerWallet.address.toLowerCase()]: {
          [ZERO_ADDR.toLowerCase()]: "600",
          [USDC_ADDR.toLowerCase()]: "7000"
        }
      }
    });
    writeStore(store);

    const confirm = await reqJson("POST", `${HUB_URL}/v1/channels/${confirmChannelId}/confirm-close`, {});
    expect(confirm.statusCode).to.eq(200);

    const afterConfirm = readStore();
    expect(afterConfirm.channels[confirmChannelId].status).to.eq("closed");
    expect(afterConfirm.payerCredits[payerWallet.address.toLowerCase()][ZERO_ADDR.toLowerCase()] || "0").to.eq("0");
    expect(afterConfirm.payerCredits[payerWallet.address.toLowerCase()][USDC_ADDR.toLowerCase()]).to.eq("7000");
  });

  it("credit-pay transfers the declared asset and records that asset in the payee ledger", async function () {
    writeStore(emptyStore({
      payerCredits: {
        [payerWallet.address.toLowerCase()]: {
          [USDC_ADDR.toLowerCase()]: "5000"
        }
      }
    }));

    const amount = "1200";
    const nonce = `cp_${Date.now()}`;
    const msg = ethers.utils.solidityKeccak256(
      ["address", "address", "address", "uint256", "string", "string"],
      [payerWallet.address, payeeWallet.address, USDC_ADDR.toLowerCase(), amount, "inv_credit_asset", nonce]
    );
    const sig = await payerWallet.signMessage(ethers.utils.arrayify(msg));
    const res = await reqJson("POST", `${HUB_URL}/v1/credit/pay`, {
      payer: payerWallet.address,
      payee: payeeWallet.address,
      asset: USDC_ADDR,
      amount,
      sig,
      invoiceId: "inv_credit_asset",
      nonce
    });

    expect(res.statusCode).to.eq(200);
    expect(res.body.asset).to.eq(USDC_ADDR.toLowerCase());

    const store = readStore();
    expect(store.payerCredits[payerWallet.address.toLowerCase()][USDC_ADDR.toLowerCase()]).to.eq("3800");
    expect(store.payerCredits[payeeWallet.address.toLowerCase()][USDC_ADDR.toLowerCase()]).to.eq("1200");
    expect(store.payeeLedger[payeeWallet.address.toLowerCase()][0].asset).to.eq(USDC_ADDR.toLowerCase());
  });

  it("withdraw rejects unsupported assets and succeeds for ETH-scoped credit", async function () {
    writeStore(emptyStore({
      payerCredits: {
        [payerWallet.address.toLowerCase()]: {
          [USDC_ADDR.toLowerCase()]: "2500",
          [ZERO_ADDR.toLowerCase()]: "1000000000000000"
        }
      }
    }));

    const badNonce = `wd_bad_${Date.now()}`;
    const badMsg = ethers.utils.solidityKeccak256(
      ["address", "address", "uint256", "string", "string"],
      [payerWallet.address, USDC_ADDR.toLowerCase(), "2500", badNonce, "withdraw"]
    );
    const badSig = await payerWallet.signMessage(ethers.utils.arrayify(badMsg));
    const bad = await reqJson("POST", `${HUB_URL}/v1/credit/withdraw`, {
      address: payerWallet.address,
      asset: USDC_ADDR,
      amount: "2500",
      sig: badSig,
      nonce: badNonce
    });
    expect(bad.statusCode).to.eq(400);
    expect(String(bad.body.message || "")).to.contain("only ETH");

    const goodAmount = "1000000000000000";
    const goodNonce = `wd_good_${Date.now()}`;
    const goodMsg = ethers.utils.solidityKeccak256(
      ["address", "address", "uint256", "string", "string"],
      [payerWallet.address, ZERO_ADDR.toLowerCase(), goodAmount, goodNonce, "withdraw"]
    );
    const goodSig = await payerWallet.signMessage(ethers.utils.arrayify(goodMsg));
    const good = await reqJson("POST", `${HUB_URL}/v1/credit/withdraw`, {
      address: payerWallet.address,
      asset: ZERO_ADDR,
      amount: goodAmount,
      sig: goodSig,
      nonce: goodNonce
    });
    expect(good.statusCode).to.eq(200);
    expect(good.body.asset).to.eq(ZERO_ADDR.toLowerCase());

    const store = readStore();
    expect(store.payerCredits[payerWallet.address.toLowerCase()][ZERO_ADDR.toLowerCase()] || "0").to.eq("0");
    expect(store.payerCredits[payerWallet.address.toLowerCase()][USDC_ADDR.toLowerCase()]).to.eq("2500");
  });

  it("surfaces legacy scalar credit but does not auto-apply it to quotes", async function () {
    const opened = await openRealHubChannel("1000000");
    const tracked = trackedChannel({
      channelId: opened.channelId,
      totalBalance: opened.totalBalance.toString(),
      balB: "2500",
      nonce: 1
    });

    writeStore(emptyStore({
      channels: {
        [tracked.channelId]: tracked
      },
      payerCredits: {
        [payerWallet.address.toLowerCase()]: "3333"
      }
    }));

    const balance = await reqJson("GET", `${HUB_URL}/v1/channels/${tracked.channelId}`);
    expect(balance.statusCode).to.eq(200);
    expect(balance.body.payerCreditsByAsset).to.deep.eq({});
    expect(balance.body.payerCredit).to.eq("3333");

    const quote = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {
      invoiceId: `inv_legacy_${Date.now()}`,
      paymentId: `pay_legacy_${Date.now()}`,
      channelId: tracked.channelId,
      payee: payeeWallet.address,
      asset: ZERO_ADDR,
      amount: "5000",
      maxFee: "0",
      quoteExpiry: now() + 120,
      contextHash: ZERO32
    });
    expect(quote.statusCode).to.eq(200);
    expect(quote.body.payerCredit).to.eq("0");
  });
});
