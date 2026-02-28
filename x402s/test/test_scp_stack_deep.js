const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

describe("SCP Deep Stack", function () {
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4121;
  const PAYEE_HOST = "127.0.0.1";
  const PAYEE_PORT = 4142;
  const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
  const PAYEE_URL = `http://${PAYEE_HOST}:${PAYEE_PORT}/v1/data`;
  const PAY_URL = `http://${PAYEE_HOST}:${PAYEE_PORT}/pay`;

  const storePath = path.resolve(__dirname, "../node/scp-hub/data/store.deep-test.json");
  const agentStateDir = path.resolve(__dirname, "../node/scp-agent/state/deep-test");
  const agentStatePath = path.join(agentStateDir, "agent-state.json");

  let createHubServer;
  let createPayeeServer;
  let ScpAgentClient;
  let verifyTicket;
  let recoverChannelStateSigner;
  let signChannelState;
  let hashChannelState;
  let signPayeeAuth;
  let readLocalProofForChannel;
  let PAYEE_ADDRESS;
  let hub;
  let payee;
  const TEST_AGENT_KEY = "0x7d577fdd4a1ec2aa00e7cdbf95db7fdbd7a6fd531f4be75f4fca31f6d8b3af88";
  const testPayer = new ethers.Wallet(TEST_AGENT_KEY);

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
            ...headers,
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
          }
        },
        (res) => {
          let data = "";
          res.on("data", (c) => {
            data += c.toString("utf8");
          });
          res.on("end", () => {
            try {
              resolve({
                statusCode: res.statusCode,
                body: data ? JSON.parse(data) : {},
                headers: res.headers
              });
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function makeValidPaymentBundle(paymentId) {
    const first = await reqJson("GET", PAYEE_URL);
    expect(first.statusCode).to.eq(402);
    const offer = first.body.accepts[0];
    const ext = offer.extensions["statechannel-hub-v1"];
    const invoiceId = ext.invoiceId;

    const channelId = ethers.utils.hexlify(crypto.randomBytes(32));
    const quoteReq = {
      invoiceId,
      paymentId,
      channelId,
      payee: PAYEE_ADDRESS,
      asset: offer.asset,
      amount: offer.maxAmountRequired,
      maxFee: "5000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    };
    const quote = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, quoteReq);
    expect(quote.statusCode).to.eq(200);

    const startingTotal = 1000000000n;
    const totalDebit = BigInt(quote.body.totalDebit);
    expect(totalDebit > 0n).to.eq(true);
    expect(totalDebit < startingTotal).to.eq(true);
    const state = {
      channelId: quoteReq.channelId,
      stateNonce: 1,
      balA: (startingTotal - totalDebit).toString(),
      balB: totalDebit.toString(),
      locksRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    };
    const sigA = await signChannelState(state, testPayer);
    const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: quote.body,
      channelState: state,
      sigA
    });
    expect(issue.statusCode).to.eq(200);

    const paymentPayload = {
      scheme: "statechannel-hub-v1",
      paymentId,
      invoiceId,
      ticket: (() => {
        const t = { ...issue.body };
        delete t.channelAck;
        return t;
      })(),
      channelProof: {
        channelId: state.channelId,
        stateNonce: state.stateNonce,
        stateHash: hashChannelState(state),
        sigA,
        channelState: state
      }
    };
    return { offer, invoiceId, quoteReq, quote: quote.body, issue: issue.body, paymentPayload, state };
  }

  before(async function () {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.mkdirSync(agentStateDir, { recursive: true });
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { force: true });
    if (fs.existsSync(agentStatePath)) fs.rmSync(agentStatePath, { force: true });

    process.env.HOST = HUB_HOST;
    process.env.PORT = String(HUB_PORT);
    process.env.STORE_PATH = storePath;
    process.env.PAYEE_HOST = PAYEE_HOST;
    process.env.PAYEE_PORT = String(PAYEE_PORT);
    process.env.HUB_URL = HUB_URL;
    // Test-only keys for deep stack integration tests
    if (!process.env.HUB_PRIVATE_KEY) {
      process.env.HUB_PRIVATE_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
    }
    if (!process.env.PAYEE_PRIVATE_KEY) {
      process.env.PAYEE_PRIVATE_KEY = "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555";
    }

    delete require.cache[require.resolve("../node/scp-hub/server")];
    delete require.cache[require.resolve("../node/scp-demo/payee-server")];
    delete require.cache[require.resolve("../node/scp-agent/agent-client")];
    delete require.cache[require.resolve("../node/scp-hub/ticket")];
    delete require.cache[require.resolve("../node/scp-hub/state-signing")];
    delete require.cache[require.resolve("../node/scp-watch/challenge-watcher")];

    ({ createServer: createHubServer } = require("../node/scp-hub/server"));
    ({ createPayeeServer, PAYEE_ADDRESS } = require("../node/scp-demo/payee-server"));
    ({ ScpAgentClient } = require("../node/scp-agent/agent-client"));
    ({ verifyTicket } = require("../node/scp-hub/ticket"));
    ({ recoverChannelStateSigner, signChannelState, hashChannelState } = require("../node/scp-hub/state-signing"));
    ({ signPayeeAuth } = require("../node/scp-common/payee-auth"));
    ({ readLocalProofForChannel } = require("../node/scp-watch/challenge-watcher"));

    hub = createHubServer();
    payee = createPayeeServer();
    await new Promise((r) => hub.listen(HUB_PORT, HUB_HOST, r));
    await new Promise((r) => payee.listen(PAYEE_PORT, PAYEE_HOST, r));
  });

  after(async function () {
    await new Promise((r) => payee.close(r));
    await new Promise((r) => hub.close(r));
  });

  it("agent can complete full payment flow", async function () {
    const agent = new ScpAgentClient({
      privateKey: TEST_AGENT_KEY,
      devMode: true,
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    const result = await agent.payResource(PAYEE_URL);
    expect(result.response.ok).to.eq(true);
    expect(result.response.receipt).to.have.property("paymentId");
  });

  it("hub API returns CORS headers for preflight, success, and error responses", async function () {
    const origin = "http://example.local";
    const preflight = await reqJson("OPTIONS", `${HUB_URL}/v1/tickets/quote`, null, {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,payment-signature,x-scp-payee-signature"
    });
    expect(preflight.statusCode).to.eq(204);
    expect(preflight.headers["access-control-allow-origin"]).to.eq("*");
    expect(String(preflight.headers["access-control-allow-methods"] || "")).to.include("OPTIONS");
    expect(String(preflight.headers["access-control-allow-headers"] || "").toLowerCase()).to.include("payment-signature");
    expect(String(preflight.headers["access-control-expose-headers"] || "").toLowerCase()).to.include("retry-after");

    const okRes = await reqJson("GET", `${HUB_URL}/.well-known/x402`, null, { origin });
    expect(okRes.statusCode).to.eq(200);
    expect(okRes.headers["access-control-allow-origin"]).to.eq("*");
    expect(String(okRes.headers["access-control-allow-methods"] || "")).to.include("GET");

    const errRes = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {}, { origin });
    expect(errRes.statusCode).to.eq(400);
    expect(errRes.headers["access-control-allow-origin"]).to.eq("*");
    expect(String(errRes.headers["access-control-allow-headers"] || "").toLowerCase()).to.include("content-type");
  });

  it("agent keeps local hub state unchanged if ticket issue fails", async function () {
    const isolatedStateDir = path.resolve(
      __dirname,
      `../node/scp-agent/state/deep-test-issue-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fs.mkdirSync(isolatedStateDir, { recursive: true });
    const agent = new ScpAgentClient({
      privateKey: ethers.Wallet.createRandom().privateKey,
      devMode: true,
      stateDir: isolatedStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    try {
      const first = await reqJson("GET", PAYEE_URL);
      expect(first.statusCode).to.eq(402);
      const offer = first.body.accepts.find((o) => o.scheme === "statechannel-hub-v1");
      const ext = offer.extensions["statechannel-hub-v1"];

      const channel = agent.channelForHub(HUB_URL);
      const before = { nonce: channel.nonce, balA: channel.balA, balB: channel.balB };
      const contextHash = "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f";
      const quoteReq = {
        invoiceId: ext.invoiceId,
        paymentId: `pay_issue_fail_${Date.now()}`,
        // Intentionally mismatch quote channelId with local channel to force /issue rejection.
        channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
        payee: ext.payeeAddress,
        asset: offer.asset,
        amount: offer.maxAmountRequired,
        maxFee: "5000",
        quoteExpiry: Math.floor(Date.now() / 1000) + 120,
        contextHash
      };

      let failed = false;
      try {
        await agent.quoteAndIssueHubTicket(HUB_URL, contextHash, quoteReq);
      } catch (err) {
        failed = true;
        expect(String(err.message || err)).to.contain("issue failed");
      }
      expect(failed).to.eq(true);

      const after = agent.channelForHub(HUB_URL);
      expect(after.nonce).to.eq(before.nonce);
      expect(after.balA).to.eq(before.balA);
      expect(after.balB).to.eq(before.balB);
    } finally {
      agent.close();
      fs.rmSync(isolatedStateDir, { recursive: true, force: true });
    }
  });

  it("agent rejects hub issue ack signed by wrong key", async function () {
    const isolatedStateDir = path.resolve(
      __dirname,
      `../node/scp-agent/state/deep-test-bad-sigb-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    fs.mkdirSync(isolatedStateDir, { recursive: true });
    const agent = new ScpAgentClient({
      privateKey: ethers.Wallet.createRandom().privateKey,
      devMode: true,
      stateDir: isolatedStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    try {
      const first = await reqJson("GET", PAYEE_URL);
      expect(first.statusCode).to.eq(402);
      const offer = first.body.accepts.find((o) => o.scheme === "statechannel-hub-v1");
      const ext = offer.extensions["statechannel-hub-v1"];

      const channel = agent.channelForHub(HUB_URL);
      const before = { nonce: channel.nonce, balA: channel.balA, balB: channel.balB };
      const contextHash = "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f";
      const quoteReq = {
        invoiceId: ext.invoiceId,
        paymentId: `pay_bad_sigb_${Date.now()}`,
        channelId: channel.channelId,
        payee: ext.payeeAddress,
        asset: offer.asset,
        amount: offer.maxAmountRequired,
        maxFee: "5000",
        quoteExpiry: Math.floor(Date.now() / 1000) + 120,
        contextHash
      };

      const badHubWallet = ethers.Wallet.createRandom();
      const originalRequest = agent.http.request.bind(agent.http);
      agent.http.request = async (method, endpoint, body, headers) => {
        const res = await originalRequest(method, endpoint, body, headers);
        if (method === "POST" && endpoint === `${HUB_URL}/v1/tickets/issue` && res.statusCode === 200) {
          const forgedSigB = await signChannelState(body.channelState, badHubWallet);
          return {
            ...res,
            body: {
              ...res.body,
              channelAck: {
                ...(res.body.channelAck || {}),
                sigB: forgedSigB
              }
            }
          };
        }
        return res;
      };

      let failed = false;
      try {
        await agent.quoteAndIssueHubTicket(HUB_URL, contextHash, quoteReq);
      } catch (err) {
        failed = true;
        expect(String(err.message || err)).to.contain("channelAck signer mismatch");
      }
      expect(failed).to.eq(true);

      const after = agent.channelForHub(HUB_URL);
      expect(after.nonce).to.eq(before.nonce);
      expect(after.balA).to.eq(before.balA);
      expect(after.balB).to.eq(before.balB);
    } finally {
      agent.close();
      fs.rmSync(isolatedStateDir, { recursive: true, force: true });
    }
  });

  it("enforces maxFee policy at agent", async function () {
    const agent = new ScpAgentClient({
      privateKey: TEST_AGENT_KEY,
      devMode: true,
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "1",
      maxAmountDefault: "5000000"
    });
    let failed = false;
    try {
      await agent.payResource(PAYEE_URL);
    } catch (err) {
      failed = true;
      expect(String(err.message || err)).to.contain("quote failed");
    }
    expect(failed).to.eq(true);
  });

  it("payee rejects tampered ticket", async function () {
    const bundle = await makeValidPaymentBundle(`pay_tamper_${Date.now()}`);
    bundle.paymentPayload.ticket.amount = String(BigInt(bundle.paymentPayload.ticket.amount) + 1n);

    const paid = await reqJson("GET", PAYEE_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    });
    expect(paid.statusCode).to.eq(402);
    expect(
      String(paid.body.error || "").includes("invalid ticket signature") ||
        String(paid.body.error || "").includes("ticket signer mismatch")
    ).to.eq(true);
  });

  it("payee rejects mismatched channel proof hash", async function () {
    const bundle = await makeValidPaymentBundle(`pay_badproof_${Date.now()}`);
    bundle.paymentPayload.channelProof.stateHash = ethers.utils.hexlify(crypto.randomBytes(32));

    const paid = await reqJson("GET", PAYEE_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    });
    expect(paid.statusCode).to.eq(402);
    expect(paid.body.error).to.contain("state hash mismatch");
  });

  it("payee rejects wrong scheme", async function () {
    const bundle = await makeValidPaymentBundle(`pay_scheme_${Date.now()}`);
    bundle.paymentPayload.scheme = "other-scheme";
    const paid = await reqJson("GET", PAYEE_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    });
    expect(paid.statusCode).to.eq(402);
    expect(paid.body.error).to.contain("wrong scheme");
  });

  it("payee rejects direct payment when invoice amount mismatches", async function () {
    const first = await reqJson("GET", PAYEE_URL);
    expect(first.statusCode).to.eq(402);
    const offer = first.body.accepts.find((o) => o.scheme === "statechannel-direct-v1");
    expect(offer).to.not.eq(undefined);

    const ext = offer.extensions["statechannel-direct-v1"];
    const invoiceId = ext.invoiceId;
    const paymentId = `pay_direct_under_${Date.now()}`;
    const directAmount = "1";
    const state = {
      channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
      stateNonce: 1,
      balA: "999999999",
      balB: "1",
      locksRoot: ethers.constants.HashZero,
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    };
    const sigA = await signChannelState(state, testPayer);

    const paymentPayload = {
      scheme: "statechannel-direct-v1",
      paymentId,
      invoiceId,
      direct: {
        payer: testPayer.address,
        payee: PAYEE_ADDRESS,
        asset: offer.asset,
        amount: directAmount,
        expiry: Math.floor(Date.now() / 1000) + 120,
        invoiceId,
        paymentId,
        channelState: state,
        sigA
      }
    };
    const paid = await reqJson("GET", PAYEE_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
    });
    expect(paid.statusCode).to.eq(402);
  });

  it("payee is idempotent on repeated paymentId", async function () {
    const bundle = await makeValidPaymentBundle(`pay_replay_${Date.now()}`);
    const headers = {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    };
    const first = await reqJson("GET", PAYEE_URL, null, headers);
    const second = await reqJson("GET", PAYEE_URL, null, headers);
    expect(first.statusCode).to.eq(200);
    expect(second.statusCode).to.eq(200);
    expect(second.body.receipt.receiptId).to.eq(first.body.receipt.receiptId);
  });

  it("agent summary reports issued payment totals", async function () {
    const bundle = await makeValidPaymentBundle(`pay_summary_${Date.now()}`);
    const summary = await reqJson(
      "GET",
      `${HUB_URL}/v1/agent/summary?channelId=${encodeURIComponent(bundle.state.channelId)}`
    );
    expect(summary.statusCode).to.eq(200);
    expect(summary.body.payments).to.eq(1);
    expect(summary.body.totalSpent).to.eq(bundle.quote.ticketDraft.amount);
    expect(summary.body.totalFees).to.eq(bundle.quote.ticketDraft.feeCharged);
    expect(summary.body.totalDebit).to.eq(bundle.quote.totalDebit);
  });

  it("hub rejects ticket issue when channel mismatches quote", async function () {
    // C6: quotes are consumed after first issue, so the bundle's quote is gone.
    // Instead, test by creating a fresh quote then issuing with wrong channelId.
    const first = await reqJson("GET", PAYEE_URL);
    expect(first.statusCode).to.eq(402);
    const offer = first.body.accepts[0];
    const ext = offer.extensions["statechannel-hub-v1"];
    const channelId = ethers.utils.hexlify(crypto.randomBytes(32));
    const quoteReq = {
      invoiceId: ext.invoiceId,
      paymentId: `pay_mismatch_${Date.now()}`,
      channelId,
      payee: PAYEE_ADDRESS,
      asset: offer.asset,
      amount: offer.maxAmountRequired,
      maxFee: "5000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    };
    const quote = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, quoteReq);
    expect(quote.statusCode).to.eq(200);

    const badState = {
      channelId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      stateNonce: 1,
      balA: "999000000",
      balB: "1000",
      locksRoot: ethers.constants.HashZero,
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    };
    const badIssue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: quote.body,
      channelState: badState,
      sigA: "0x1234"
    });
    expect(badIssue.statusCode).to.eq(409);
    expect(badIssue.body.errorCode).to.eq("SCP_009_POLICY_VIOLATION");
  });

  it("hub rejects ticket issue when quote payload is tampered", async function () {
    const first = await reqJson("GET", PAYEE_URL);
    expect(first.statusCode).to.eq(402);
    const offer = first.body.accepts.find((o) => o.scheme === "statechannel-hub-v1");
    const ext = offer.extensions["statechannel-hub-v1"];
    const channelId = ethers.utils.hexlify(crypto.randomBytes(32));
    const contextHash = "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f";
    const quoteRes = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {
      invoiceId: ext.invoiceId,
      paymentId: `pay_tampered_quote_${Date.now()}`,
      channelId,
      payee: PAYEE_ADDRESS,
      asset: offer.asset,
      amount: offer.maxAmountRequired,
      maxFee: "5000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash
    });
    expect(quoteRes.statusCode).to.eq(200);

    const tamperedQuote = JSON.parse(JSON.stringify(quoteRes.body));
    tamperedQuote.ticketDraft.amount = (BigInt(tamperedQuote.ticketDraft.amount) + 1000n).toString();

    const state = {
      channelId,
      stateNonce: 1,
      balA: "999000000",
      balB: "1000",
      locksRoot: ethers.constants.HashZero,
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash
    };
    const sigA = await signChannelState(state, testPayer);
    const issue = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: tamperedQuote,
      channelState: state,
      sigA
    });

    expect(issue.statusCode).to.eq(409);
    expect(issue.body.errorCode).to.eq("SCP_009_POLICY_VIOLATION");
    expect(String(issue.body.message || "")).to.contain("quote mismatch");
  });

  it("hub signs ticket and channel ack with hub address", async function () {
    const bundle = await makeValidPaymentBundle(`pay_sigs_${Date.now()}`);
    const hubInfo = await reqJson("GET", `${HUB_URL}/.well-known/x402`);
    expect(hubInfo.statusCode).to.eq(200);

    const recoveredTicketSigner = verifyTicket(bundle.paymentPayload.ticket);
    expect(recoveredTicketSigner.toLowerCase()).to.eq(hubInfo.body.address.toLowerCase());

    const recoveredStateSigner = recoverChannelStateSigner(bundle.state, bundle.issue.channelAck.sigB);
    expect(recoveredStateSigner.toLowerCase()).to.eq(hubInfo.body.address.toLowerCase());
  });

  it("/pay returns offers with 200", async function () {
    const res = await reqJson("GET", PAY_URL);
    expect(res.statusCode).to.eq(200);
    expect(res.body.accepts).to.be.an("array");
    expect(res.body.accepts.length).to.be.greaterThan(0);
    const hub = res.body.accepts.find((o) => o.scheme === "statechannel-hub-v1");
    const direct = res.body.accepts.find((o) => o.scheme === "statechannel-direct-v1");
    expect(hub).to.not.eq(undefined);
    expect(direct).to.not.eq(undefined);
    expect(hub.maxAmountRequired).to.be.a("string");
    expect(hub.resource).to.contain("/v1/data");
  });

  it("/pay accepts payment with PAYMENT-SIGNATURE header", async function () {
    const bundle = await makeValidPaymentBundle(`pay_via_pay_${Date.now()}`);
    const paid = await reqJson("GET", PAY_URL, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(bundle.paymentPayload)
    });
    expect(paid.statusCode).to.eq(200);
    expect(paid.body.ok).to.eq(true);
    expect(paid.body.receipt).to.have.property("paymentId");
  });

  it("multi-route payee serves different prices per path", async function () {
    const MULTI_PORT = 4143;
    const multiPayee = createPayeeServer({
      host: PAYEE_HOST,
      port: MULTI_PORT,
      routes: {
        "/v1/basic": { price: "500000" },
        "/v1/premium": { price: "5000000" }
      }
    });
    await new Promise((r) => multiPayee.listen(MULTI_PORT, PAYEE_HOST, r));
    try {
      // /pay lists all routes
      const payRes = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/pay`);
      expect(payRes.statusCode).to.eq(200);
      const resources = payRes.body.accepts.map((o) => o.resource);
      expect(resources.some((r) => r.includes("/v1/basic"))).to.eq(true);
      expect(resources.some((r) => r.includes("/v1/premium"))).to.eq(true);

      // basic route returns 402 with its price
      const basic = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/v1/basic`);
      expect(basic.statusCode).to.eq(402);
      expect(basic.body.accepts[0].maxAmountRequired).to.eq("500000");

      // premium route returns 402 with its price
      const premium = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/v1/premium`);
      expect(premium.statusCode).to.eq(402);
      expect(premium.body.accepts[0].maxAmountRequired).to.eq("5000000");

      // unknown route returns 404
      const notFound = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI_PORT}/v1/other`);
      expect(notFound.statusCode).to.eq(404);
    } finally {
      await new Promise((r) => multiPayee.close(r));
    }
  });

  it("multi-network payee advertises all network/asset/hub combos", async function () {
    const MULTI2_PORT = 4144;
    const multiPayee = createPayeeServer({
      host: PAYEE_HOST,
      port: MULTI2_PORT,
      routes: {
        "/v1/data": {
          price: "1000000",
          accepts: [
            { network: "eip155:8453", asset: "0xUSDC_BASE", hub: "http://hub-base:4021", hubName: "base.hub" },
            { network: "eip155:11155111", asset: "0xUSDC_SEPOLIA", hub: "http://hub-sepolia:4021", hubName: "sep.hub" }
          ]
        }
      }
    });
    await new Promise((r) => multiPayee.listen(MULTI2_PORT, PAYEE_HOST, r));
    try {
      // 402 on resource lists all combos
      const res402 = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI2_PORT}/v1/data`);
      expect(res402.statusCode).to.eq(402);
      // 2 networks × 2 schemes (hub + direct) = 4 offers
      expect(res402.body.accepts.length).to.eq(4);

      const hubOffers = res402.body.accepts.filter((o) => o.scheme === "statechannel-hub-v1");
      const directOffers = res402.body.accepts.filter((o) => o.scheme === "statechannel-direct-v1");
      expect(hubOffers.length).to.eq(2);
      expect(directOffers.length).to.eq(2);

      const networks = hubOffers.map((o) => o.network).sort();
      expect(networks).to.deep.eq(["eip155:11155111", "eip155:8453"]);

      expect(hubOffers[0].extensions["statechannel-hub-v1"].hubEndpoint).to.contain("hub-base");
      expect(hubOffers[1].extensions["statechannel-hub-v1"].hubEndpoint).to.contain("hub-sepolia");

      // /pay lists same offers
      const payRes = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI2_PORT}/pay`);
      expect(payRes.statusCode).to.eq(200);
      expect(payRes.body.accepts.length).to.eq(4);
    } finally {
      await new Promise((r) => multiPayee.close(r));
    }
  });

  it("per-asset pricing returns different prices per asset", async function () {
    const MULTI3_PORT = 4145;
    const multiPayee = createPayeeServer({
      host: PAYEE_HOST,
      port: MULTI3_PORT,
      routes: {
        "/v1/data": {
          accepts: [
            { network: "eip155:8453", asset: "0xUSDC", price: "1000000" },
            { network: "eip155:8453", asset: "0xWETH", price: "500000000000000" }
          ]
        }
      }
    });
    await new Promise((r) => multiPayee.listen(MULTI3_PORT, PAYEE_HOST, r));
    try {
      const res = await reqJson("GET", `http://${PAYEE_HOST}:${MULTI3_PORT}/v1/data`);
      expect(res.statusCode).to.eq(402);
      // 2 assets × 2 schemes = 4 offers
      expect(res.body.accepts.length).to.eq(4);

      const hubUsdc = res.body.accepts.find(
        (o) => o.scheme === "statechannel-hub-v1" && o.asset === "0xUSDC"
      );
      const hubWeth = res.body.accepts.find(
        (o) => o.scheme === "statechannel-hub-v1" && o.asset === "0xWETH"
      );
      expect(hubUsdc.maxAmountRequired).to.eq("1000000");
      expect(hubWeth.maxAmountRequired).to.eq("500000000000000");

      // each offer has its own invoiceId
      const usdcInv = hubUsdc.extensions["statechannel-hub-v1"].invoiceId;
      const wethInv = hubWeth.extensions["statechannel-hub-v1"].invoiceId;
      expect(usdcInv).to.not.eq(wethInv);
    } finally {
      await new Promise((r) => multiPayee.close(r));
    }
  });

  it("agent chooseOffer filters by asset option", function () {
    const agent = new ScpAgentClient({
      privateKey: TEST_AGENT_KEY,
      devMode: true,
      networkAllowlist: ["eip155:8453"],
      persistEnabled: false
    });
    const offers = [
      { scheme: "statechannel-hub-v1", network: "eip155:8453", asset: "0xUSDC", maxAmountRequired: "1000000" },
      { scheme: "statechannel-direct-v1", network: "eip155:8453", asset: "0xUSDC", maxAmountRequired: "1000000" },
      { scheme: "statechannel-hub-v1", network: "eip155:8453", asset: "0xWETH", maxAmountRequired: "500000000000000" },
      { scheme: "statechannel-direct-v1", network: "eip155:8453", asset: "0xWETH", maxAmountRequired: "500000000000000" }
    ];

    // no filter — picks first hub
    const defaultOffer = agent.chooseOffer(offers, "hub");
    expect(defaultOffer.asset).to.eq("0xUSDC");

    // filter by WETH
    const wethOffer = agent.chooseOffer(offers, "hub", { asset: "0xWETH" });
    expect(wethOffer.asset).to.eq("0xWETH");
    expect(wethOffer.maxAmountRequired).to.eq("500000000000000");

    // filter by WETH direct
    const wethDirect = agent.chooseOffer(offers, "direct", { asset: "0xWETH" });
    expect(wethDirect.asset).to.eq("0xWETH");
    expect(wethDirect.scheme).to.eq("statechannel-direct-v1");

    // filter by unknown asset — undefined
    const none = agent.chooseOffer(offers, "hub", { asset: "0xDAI" });
    expect(none).to.eq(undefined);

    agent.close();
  });

  it("agent auto route prefers direct when funded direct channel exists", function () {
    const agent = new ScpAgentClient({
      privateKey: TEST_AGENT_KEY,
      devMode: true,
      networkAllowlist: ["eip155:8453"],
      persistEnabled: false
    });
    const payee = "0x1111111111111111111111111111111111111111";
    agent.state.channels[`direct:${payee.toLowerCase()}`] = {
      channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
      nonce: 0,
      balA: "5000000",
      balB: "0"
    };
    const offers = [
      {
        scheme: "statechannel-hub-v1",
        network: "eip155:8453",
        asset: "0xUSDC",
        maxAmountRequired: "1000000",
        extensions: { "statechannel-hub-v1": { hubEndpoint: "http://127.0.0.1:4021" } }
      },
      {
        scheme: "statechannel-direct-v1",
        network: "eip155:8453",
        asset: "0xUSDC",
        maxAmountRequired: "1000000",
        extensions: { "statechannel-direct-v1": { payeeAddress: payee } }
      }
    ];
    const selected = agent.chooseOffer(offers, "auto");
    expect(selected.scheme).to.eq("statechannel-direct-v1");
    agent.close();
  });

  it("agent discovers offers via /pay and completes payment", async function () {
    const agent = new ScpAgentClient({
      privateKey: TEST_AGENT_KEY,
      devMode: true,
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    const result = await agent.payResource(PAY_URL);
    expect(result.response.ok).to.eq(true);
    expect(result.response.receipt).to.have.property("paymentId");
  });

  it("persists watcher proof material for both agent and hub", async function () {
    const agent = new ScpAgentClient({
      privateKey: TEST_AGENT_KEY,
      devMode: true,
      stateDir: agentStateDir,
      networkAllowlist: ["eip155:8453"],
      maxFeeDefault: "5000",
      maxAmountDefault: "5000000"
    });
    await agent.payResource(PAYEE_URL, { paymentId: `pay_watch_${Date.now()}` });

    const s = JSON.parse(fs.readFileSync(agentStatePath, "utf8"));
    const channelIds = Object.keys((s.watch || {}).byChannelId || {});
    expect(channelIds.length).to.be.greaterThan(0);

    const hubStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const hubChannels = hubStore.channels || {};
    const intersect = channelIds.filter((id) => !!hubChannels[id]);
    expect(intersect.length).to.be.greaterThan(0);
    const channelId = intersect[intersect.length - 1];

    process.env.ROLE = "agent";
    process.env.AGENT_STATE_PATH = agentStatePath;
    const agentProof = readLocalProofForChannel(channelId, "agent");
    expect(agentProof).to.not.eq(null);
    expect(agentProof.counterpartySig).to.be.a("string");

    process.env.ROLE = "hub";
    process.env.HUB_STORE_PATH = storePath;
    const hubProof = readLocalProofForChannel(channelId, "hub");
    expect(hubProof).to.not.eq(null);
    expect(hubProof.counterpartySig).to.be.a("string");
  });

  it("hub enforces +1 nonce and quote debit delta on issue", async function () {
    const first = await reqJson("GET", PAYEE_URL);
    expect(first.statusCode).to.eq(402);
    const offer = first.body.accepts.find((o) => o.scheme === "statechannel-hub-v1");
    const ext = offer.extensions["statechannel-hub-v1"];
    const channelId = ethers.utils.hexlify(crypto.randomBytes(32));
    const baseContext = "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f";

    const q1 = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {
      invoiceId: ext.invoiceId,
      paymentId: `pay_nonce_1_${Date.now()}`,
      channelId,
      payee: PAYEE_ADDRESS,
      asset: offer.asset,
      amount: offer.maxAmountRequired,
      maxFee: "5000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: baseContext
    });
    expect(q1.statusCode).to.eq(200);
    const s1 = {
      channelId,
      stateNonce: 1,
      balA: "999000000",
      balB: "1000",
      locksRoot: ethers.constants.HashZero,
      stateExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: baseContext
    };
    const sig1 = await signChannelState(s1, testPayer);
    const i1 = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, { quote: q1.body, channelState: s1, sigA: sig1 });
    expect(i1.statusCode).to.eq(200);

    const q2 = await reqJson("GET", PAYEE_URL);
    const offer2 = q2.body.accepts.find((o) => o.scheme === "statechannel-hub-v1");
    const ext2 = offer2.extensions["statechannel-hub-v1"];
    const q2res = await reqJson("POST", `${HUB_URL}/v1/tickets/quote`, {
      invoiceId: ext2.invoiceId,
      paymentId: `pay_nonce_2_${Date.now()}`,
      channelId,
      payee: PAYEE_ADDRESS,
      asset: offer2.asset,
      amount: offer2.maxAmountRequired,
      maxFee: "5000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      contextHash: baseContext
    });
    expect(q2res.statusCode).to.eq(200);

    const i2BadNonce = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: q2res.body,
      channelState: { ...s1, stateNonce: 3, balA: "997000000", balB: "2001000" },
      sigA: await signChannelState({ ...s1, stateNonce: 3, balA: "997000000", balB: "2001000" }, testPayer)
    });
    expect(i2BadNonce.statusCode).to.eq(409);
    expect(i2BadNonce.body.errorCode).to.eq("SCP_005_NONCE_CONFLICT");

    const i2BadDelta = await reqJson("POST", `${HUB_URL}/v1/tickets/issue`, {
      quote: q2res.body,
      channelState: { ...s1, stateNonce: 2, balA: "998000000", balB: "1001000" },
      sigA: await signChannelState({ ...s1, stateNonce: 2, balA: "998000000", balB: "1001000" }, testPayer)
    });
    expect(i2BadDelta.statusCode).to.eq(409);
    expect(i2BadDelta.body.errorCode).to.eq("SCP_009_POLICY_VIOLATION");
  });

  it("refund endpoint returns normalized amount and emits pollable event", async function () {
    // C4: refund now requires a real issued ticket — create one first
    const bundle = await makeValidPaymentBundle(`pay_refund_${Date.now()}`);
    const ticketId = bundle.issue.ticketId;
    const totalDebit = BigInt(bundle.quote.totalDebit);
    const refund = await reqJson("POST", `${HUB_URL}/v1/refunds`, {
      ticketId,
      refundAmount: bundle.quote.ticketDraft.amount,
      reason: "test-refund"
    });
    expect(refund.statusCode).to.eq(200);
    expect(refund.body.amount).to.eq(bundle.quote.ticketDraft.amount);
    expect(refund.body.refundedTotalDebit).to.eq(bundle.quote.totalDebit);
    expect(refund.body.channelState).to.be.an("object");
    expect(refund.body.channelAck).to.be.an("object");

    const hubInfo = await reqJson("GET", `${HUB_URL}/.well-known/x402`);
    expect(hubInfo.statusCode).to.eq(200);
    const refundSigner = recoverChannelStateSigner(refund.body.channelState, refund.body.channelAck.sigB);
    expect(refundSigner.toLowerCase()).to.eq(hubInfo.body.address.toLowerCase());
    expect(refund.body.channelAck.stateHash).to.eq(hashChannelState(refund.body.channelState));

    const ch = await reqJson("GET", `${HUB_URL}/v1/channels/${encodeURIComponent(bundle.state.channelId)}`);
    expect(ch.statusCode).to.eq(200);
    expect(Number(ch.body.latestNonce)).to.eq(Number(bundle.state.stateNonce) + 1);
    expect(ch.body.latestState.balA).to.eq((BigInt(bundle.state.balA) + totalDebit).toString());
    expect(ch.body.latestState.balB).to.eq((BigInt(bundle.state.balB) - totalDebit).toString());

    const events = await reqJson("GET", `${HUB_URL}/v1/events?since=0&limit=100`);
    expect(events.statusCode).to.eq(200);
    const refunded = events.body.items.find((e) => e.event === "payment.refunded" && e.data.ticketId === refund.body.ticketId);
    expect(refunded).to.not.eq(undefined);
    expect(refunded.data.amount).to.eq(bundle.quote.ticketDraft.amount);
  });

  it("exposes merchant/payee and agent receipt views with filters", async function () {
    const payeeReceipts = await reqJson(
      "GET",
      `${HUB_URL}/v1/payee/receipts?payee=${encodeURIComponent(PAYEE_ADDRESS)}&since=0&limit=50`
    );
    expect(payeeReceipts.statusCode).to.eq(200);
    expect(Array.isArray(payeeReceipts.body.items)).to.eq(true);
    expect(payeeReceipts.body.items.length).to.be.greaterThan(0);
    const p0 = payeeReceipts.body.items[0];
    expect(p0).to.have.property("paymentId");
    expect(p0).to.have.property("ticketId");
    expect(p0).to.have.property("amount");
    expect(p0).to.have.property("asset");

    const agentReceipts = await reqJson(
      "GET",
      `${HUB_URL}/v1/agent/receipts?since=0&limit=100&payee=${encodeURIComponent(PAYEE_ADDRESS)}`
    );
    expect(agentReceipts.statusCode).to.eq(200);
    expect(Array.isArray(agentReceipts.body.items)).to.eq(true);
    expect(agentReceipts.body.items.length).to.be.greaterThan(0);
    const a0 = agentReceipts.body.items[0];
    expect(a0).to.have.property("channelId");
    expect(a0).to.have.property("totalDebit");
    expect(a0).to.have.property("fee");
    expect(String(a0.payee).toLowerCase()).to.eq(PAYEE_ADDRESS.toLowerCase());

    const byChannel = await reqJson(
      "GET",
      `${HUB_URL}/v1/agent/receipts?channelId=${encodeURIComponent(a0.channelId)}&since=0&limit=100`
    );
    expect(byChannel.statusCode).to.eq(200);
    expect(byChannel.body.items.length).to.be.greaterThan(0);
    for (const it of byChannel.body.items) {
      expect(it.channelId).to.eq(a0.channelId);
    }
  });

  it("requires payee signature auth on payee-channel admin routes", async function () {
    const registerBody = {
      payee: PAYEE_ADDRESS,
      channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
      asset: ethers.constants.AddressZero,
      totalDeposit: "1000"
    };

    const noAuth = await reqJson("POST", `${HUB_URL}/v1/hub/register-payee-channel`, registerBody);
    expect(noAuth.statusCode).to.eq(401);
    expect(noAuth.body.errorCode).to.eq("SCP_012_UNAUTHORIZED");

    const ts = Math.floor(Date.now() / 1000);
    const payeeSigner = new ethers.Wallet(process.env.PAYEE_PRIVATE_KEY);
    const sig = await signPayeeAuth({
      method: "POST",
      path: "/v1/hub/register-payee-channel",
      payee: PAYEE_ADDRESS,
      timestamp: ts,
      body: registerBody
    }, payeeSigner);

    const yesAuth = await reqJson(
      "POST",
      `${HUB_URL}/v1/hub/register-payee-channel`,
      registerBody,
      {
        "x-scp-payee-signature": sig,
        "x-scp-payee-timestamp": String(ts)
      }
    );
    expect(yesAuth.statusCode).to.eq(200);
    expect(String(yesAuth.body.payee || "").toLowerCase()).to.eq(PAYEE_ADDRESS.toLowerCase());
  });
});
