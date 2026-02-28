const http = require("http");
const { expect } = require("chai");
const { ethers } = require("ethers");
const { signTicketDraft } = require("../node/scp-hub/ticket");

describe("SCP Meow API", function () {
  const API_HOST = "127.0.0.1";
  const API_PORT = 4190;
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4191;
  const HUB_ENDPOINT = `http://${HUB_HOST}:${HUB_PORT}`;

  const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
  const PAYEE_KEY = "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555";
  const hubWallet = new ethers.Wallet(HUB_KEY);
  const payeeWallet = new ethers.Wallet(PAYEE_KEY);

  let apiServer;
  let hubServer;
  let createMeowServer;

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
          res.on("data", (c) => {
            data += c.toString("utf8");
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

  before(async function () {
    process.env.HOST = API_HOST;
    process.env.PORT = String(API_PORT);
    process.env.NETWORK = "base";
    process.env.HUB_NAME = "pay.eth";
    process.env.HUB_ENDPOINT = HUB_ENDPOINT;
    process.env.PAYEE_PRIVATE_KEY = PAYEE_KEY;
    process.env.MEOW_PRICE_ETH = "0.0000001";

    delete require.cache[require.resolve("../node/meow-api/server")];
    ({ createMeowServer } = require("../node/meow-api/server"));

    hubServer = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/.well-known/x402") {
        const body = JSON.stringify({ address: hubWallet.address });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/v1/payments/")) {
        const body = JSON.stringify({ status: "issued" });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      const body = JSON.stringify({ error: "not found" });
      res.writeHead(404, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });

    apiServer = createMeowServer();
    await new Promise((resolve) => hubServer.listen(HUB_PORT, HUB_HOST, resolve));
    await new Promise((resolve) => apiServer.listen(API_PORT, API_HOST, resolve));
  });

  after(async function () {
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => hubServer.close(resolve));
  });

  it("returns 402 offer for /meow with 0.0000001 ETH price", async function () {
    const res = await reqJson("GET", `http://${API_HOST}:${API_PORT}/meow`);
    expect(res.statusCode).to.eq(402);
    expect(res.body.message).to.contain("/meow");
    expect(res.body.pricing[0].human).to.eq("0.0000001");
    expect(res.body.pricing[0].price).to.eq("100000000000");
    expect(res.body.accepts[0].scheme).to.eq("statechannel-hub-v1");
    expect(res.body.accepts[0].maxAmountRequired).to.eq("100000000000");
    expect(res.body.accepts[0].asset).to.eq(ethers.constants.AddressZero);
  });

  it("accepts a valid hub payment header for /meow", async function () {
    const first = await reqJson("GET", `http://${API_HOST}:${API_PORT}/meow`);
    expect(first.statusCode).to.eq(402);

    const offer = first.body.accepts[0];
    const invoiceId = offer.extensions["statechannel-hub-v1"].invoiceId;
    const paymentId = `pay_${Date.now()}`;
    const amount = offer.maxAmountRequired;

    const draft = {
      ticketId: `tkt_${Date.now()}`,
      hub: hubWallet.address,
      payee: payeeWallet.address,
      invoiceId,
      paymentId,
      asset: ethers.constants.AddressZero,
      amount,
      feeCharged: "10",
      totalDebit: (BigInt(amount) + 10n).toString(),
      expiry: Math.floor(Date.now() / 1000) + 120,
      policyHash: ethers.utils.hexlify(ethers.utils.randomBytes(32))
    };
    const sig = await signTicketDraft(draft, hubWallet);
    const paymentHeader = {
      scheme: "statechannel-hub-v1",
      invoiceId,
      paymentId,
      ticket: { ...draft, sig }
    };

    const paid = await reqJson("GET", `http://${API_HOST}:${API_PORT}/meow`, {
      "payment-signature": JSON.stringify(paymentHeader)
    });
    expect(paid.statusCode).to.eq(200);
    expect(paid.body.ok).to.eq(true);
    expect(paid.body.meow).to.eq("meow");
    expect(paid.body.receipt.paymentId).to.eq(paymentId);
  });

  it("supports pay_once mode using access token after initial payment", async function () {
    const PAY_ONCE_PORT = 4192;
    process.env.PORT = String(PAY_ONCE_PORT);
    process.env.MEOW_PAYMENT_MODE = "pay_once";

    delete require.cache[require.resolve("../node/meow-api/server")];
    const { createMeowServer: createPayOnceServer } = require("../node/meow-api/server");
    const payOnceServer = createPayOnceServer();
    await new Promise((resolve) => payOnceServer.listen(PAY_ONCE_PORT, API_HOST, resolve));

    try {
      const first = await reqJson("GET", `http://${API_HOST}:${PAY_ONCE_PORT}/meow`);
      expect(first.statusCode).to.eq(402);

      const offer = first.body.accepts[0];
      const invoiceId = offer.extensions["statechannel-hub-v1"].invoiceId;
      const paymentId = `pay_${Date.now()}`;
      const amount = offer.maxAmountRequired;

      const draft = {
        ticketId: `tkt_${Date.now()}`,
        hub: hubWallet.address,
        payee: payeeWallet.address,
        invoiceId,
        paymentId,
        asset: ethers.constants.AddressZero,
        amount,
        feeCharged: "10",
        totalDebit: (BigInt(amount) + 10n).toString(),
        expiry: Math.floor(Date.now() / 1000) + 120,
        policyHash: ethers.utils.hexlify(ethers.utils.randomBytes(32))
      };
      const sig = await signTicketDraft(draft, hubWallet);
      const paymentHeader = {
        scheme: "statechannel-hub-v1",
        invoiceId,
        paymentId,
        ticket: { ...draft, sig }
      };

      const paid = await reqJson("GET", `http://${API_HOST}:${PAY_ONCE_PORT}/meow`, {
        "payment-signature": JSON.stringify(paymentHeader)
      });
      expect(paid.statusCode).to.eq(200);
      expect(paid.body.ok).to.eq(true);
      expect(paid.body.access.mode).to.eq("pay_once");
      expect(paid.body.access.token).to.be.a("string");

      const unlocked = await reqJson("GET", `http://${API_HOST}:${PAY_ONCE_PORT}/meow`, {
        "x-scp-access-token": paid.body.access.token
      });
      expect(unlocked.statusCode).to.eq(200);
      expect(unlocked.body.ok).to.eq(true);
      expect(unlocked.body.meow).to.eq("meow");
      expect(unlocked.body.access.mode).to.eq("pay_once");
    } finally {
      await new Promise((resolve) => payOnceServer.close(resolve));
      delete process.env.MEOW_PAYMENT_MODE;
      process.env.PORT = String(API_PORT);
      delete require.cache[require.resolve("../node/meow-api/server")];
      ({ createMeowServer } = require("../node/meow-api/server"));
    }
  });
});
