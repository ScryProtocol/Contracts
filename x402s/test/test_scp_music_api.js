const http = require("http");
const { expect } = require("chai");
const { ethers } = require("ethers");
const WebSocketModule = require("ws");
const { signTicketDraft } = require("../node/scp-hub/ticket");

const WebSocket = WebSocketModule.WebSocket || WebSocketModule;

describe("SCP Music API", function () {
  const API_HOST = "127.0.0.1";
  const API_PORT = 4295;
  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4296;
  const HUB_ENDPOINT = `http://${HUB_HOST}:${HUB_PORT}`;

  const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
  const PAYEE_KEY = "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555";
  const hubWallet = new ethers.Wallet(HUB_KEY);
  const payeeWallet = new ethers.Wallet(PAYEE_KEY);

  let apiServer;
  let hubServer;
  let createMusicServer;
  const issuedByPaymentId = new Map();

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

  function openWs(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const messages = [];
      ws.on("message", (raw) => {
        try {
          messages.push(JSON.parse(String(raw || "{}")));
        } catch (_e) {
          // no-op
        }
      });
      ws.once("open", () => resolve({ ws, messages }));
      ws.once("error", reject);
    });
  }

  function waitWsEvent(messages, wantedType, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const loop = () => {
        const idx = messages.findIndex((m) => m && m.type === wantedType);
        if (idx >= 0) {
          const [msg] = messages.splice(idx, 1);
          return resolve(msg);
        }
        if (Date.now() - started >= timeoutMs) {
          return reject(new Error(`timeout waiting for ws event ${wantedType}`));
        }
        setTimeout(loop, 20);
      };
      loop();
    });
  }

  before(async function () {
    process.env.MUSIC_HOST = API_HOST;
    process.env.MUSIC_PORT = String(API_PORT);
    process.env.NETWORK = "base";
    process.env.HUB_NAME = "pay.eth";
    process.env.HUB_ENDPOINT = HUB_ENDPOINT;
    process.env.PAYEE_PRIVATE_KEY = PAYEE_KEY;
    process.env.MUSIC_PRICE_ETH = "0.0000001";
    process.env.MUSIC_STREAM_T_SEC = "5";

    delete require.cache[require.resolve("../node/scp-demo/music-api/server")];
    ({ createMusicServer } = require("../node/scp-demo/music-api/server"));

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
        const body = JSON.stringify({ status: "issued" });
        const payload = JSON.stringify({ status: "issued", ticketId });
        res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      const body = JSON.stringify({ error: "not found" });
      res.writeHead(404, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });

    apiServer = createMusicServer();
    await new Promise((resolve) => hubServer.listen(HUB_PORT, HUB_HOST, resolve));
    await new Promise((resolve) => apiServer.listen(API_PORT, API_HOST, resolve));
  });

  after(async function () {
    await new Promise((resolve) => apiServer.close(resolve));
    await new Promise((resolve) => hubServer.close(resolve));
  });

  it("returns 402 offer with stream metadata for music chunk", async function () {
    const res = await reqJson("GET", `http://${API_HOST}:${API_PORT}/v1/music/chunk?track=neon-sky&cursor=0`);
    expect(res.statusCode).to.eq(402);
    expect(res.body.accepts[0].scheme).to.eq("statechannel-hub-v1");
    const ext = res.body.accepts[0].extensions["statechannel-hub-v1"];
    expect(ext.stream.t).to.eq(5);
    expect(ext.stream.amount).to.eq(res.body.accepts[0].maxAmountRequired);
  });

  it("supports meow-style /music route for 402 discovery", async function () {
    const res = await reqJson("GET", `http://${API_HOST}:${API_PORT}/music?track=neon-sky&cursor=0`, {
      accept: "application/json"
    });
    expect(res.statusCode).to.eq(402);
    expect(res.body.accepts[0].scheme).to.eq("statechannel-hub-v1");
    expect(res.body.accepts[0].resource).to.include("/music?track=neon-sky&cursor=0");
    expect(res.body.accepts[0].extensions["statechannel-hub-v1"].stream.t).to.eq(5);
  });

  it("returns 402 on /music without explicit track query", async function () {
    const res = await reqJson("GET", `http://${API_HOST}:${API_PORT}/music`, {
      accept: "application/json"
    });
    expect(res.statusCode).to.eq(402);
    expect(res.body.accepts[0].scheme).to.eq("statechannel-hub-v1");
    expect(res.body.accepts[0].resource).to.include("/music?track=neon-sky&cursor=0");
  });

  it("accepts a valid paid chunk request", async function () {
    const first = await reqJson("GET", `http://${API_HOST}:${API_PORT}/v1/music/chunk?track=neon-sky&cursor=0`);
    expect(first.statusCode).to.eq(402);

    const offer = first.body.accepts[0];
    const ext = offer.extensions["statechannel-hub-v1"];
    const invoiceId = ext.invoiceId;
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
      feeCharged: "0",
      totalDebit: amount,
      expiry: Math.floor(Date.now() / 1000) + 120,
      policyHash: ethers.utils.hexlify(ethers.utils.randomBytes(32))
    };
    const sig = await signTicketDraft(draft, hubWallet);
    issuedByPaymentId.set(paymentId, draft.ticketId);
    const paymentHeader = {
      scheme: "statechannel-hub-v1",
      invoiceId,
      paymentId,
      ticket: { ...draft, sig }
    };

    const paid = await reqJson("GET", `http://${API_HOST}:${API_PORT}/v1/music/chunk?track=neon-sky&cursor=0`, {
      "payment-signature": JSON.stringify(paymentHeader)
    });

    expect(paid.statusCode).to.eq(200);
    expect(paid.body.ok).to.eq(true);
    expect(paid.body.track.id).to.eq("neon-sky");
    expect(paid.body.stream.t).to.eq(5);
    expect(paid.body.stream.nextCursor).to.eq(5);
    expect(paid.body.receipt.paymentId).to.eq(paymentId);
  });

  it("supports websocket offer -> scp.approve(amount,t) -> start/stop", async function () {
    const sessionId = `sess_${Date.now()}`;
    const { ws, messages } = await openWs(`ws://${API_HOST}:${API_PORT}/music/ws?session=${sessionId}`);

    const connected = await waitWsEvent(messages, "ws.connected");
    expect(connected.sessionId).to.eq(sessionId);

    ws.send(JSON.stringify({ type: "offer.get", track: "neon-sky", cursor: 0 }));
    const offerEvent = await waitWsEvent(messages, "offer");
    const stream = offerEvent.offer.accepts[0].extensions["statechannel-hub-v1"].stream;
    expect(stream.t).to.eq(5);

    ws.send(JSON.stringify({ type: "scp.approve", amount: stream.amount, t: stream.t }));
    const approved = await waitWsEvent(messages, "scp.approved");
    expect(approved.amount).to.eq(stream.amount);
    expect(approved.t).to.eq(stream.t);

    ws.send(JSON.stringify({ type: "control.start" }));
    const started = await waitWsEvent(messages, "stream.start");
    expect(started.amount).to.eq(stream.amount);
    expect(started.t).to.eq(stream.t);

    ws.send(JSON.stringify({ type: "control.stop" }));
    const stopped = await waitWsEvent(messages, "stream.stop");
    expect(stopped.sessionId).to.eq(sessionId);

    ws.close();
  });
});
