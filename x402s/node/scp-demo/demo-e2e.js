/* eslint-disable no-console */
const http = require("http");
const { createServer: createHubServer } = require("../scp-hub/server");
const { createPayeeServer, PAYEE_ADDRESS, RESOURCE_PATH } = require("./payee-server");
const { hashChannelState } = require("../scp-hub/state-signing");

const HUB_HOST = "127.0.0.1";
const HUB_PORT = Number(process.env.HUB_PORT || 4021);
const PAYEE_HOST = "127.0.0.1";
const PAYEE_PORT = Number(process.env.PAYEE_PORT || 4042);

function requestJson(method, endpoint, body, headers = {}) {
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
        res.on("data", (chunk) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              body: data ? JSON.parse(data) : {}
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const hub = createHubServer();
  const payee = createPayeeServer();
  await new Promise((r) => hub.listen(HUB_PORT, HUB_HOST, r));
  await new Promise((r) => payee.listen(PAYEE_PORT, PAYEE_HOST, r));

  const hubUrl = `http://${HUB_HOST}:${HUB_PORT}`;
  const payeeUrl = `http://${PAYEE_HOST}:${PAYEE_PORT}${RESOURCE_PATH}`;

  try {
    const first = await requestJson("GET", payeeUrl);
    assert(first.statusCode === 402, "payee should return 402 first");
    const offer = first.body.accepts[0];
    const ext = offer.extensions["statechannel-hub-v1"];
    const invoiceId = ext.invoiceId;
    const paymentId = `pay_demo_${Date.now()}`;

    const quoteReq = {
      invoiceId,
      paymentId,
      channelId: "0x7a0de7b4f53d675f6fc0f21a32c6b957f8e477e2acbe92d2ab36ef0f7d5e57a0",
      payee: PAYEE_ADDRESS,
      asset: offer.asset,
      amount: offer.maxAmountRequired,
      maxFee: "5000",
      quoteExpiry: Math.floor(Date.now() / 1000) + 120
    };
    const quote = await requestJson("POST", `${hubUrl}/v1/tickets/quote`, quoteReq);
    assert(quote.statusCode === 200, "quote should succeed");

    const issueReq = {
      quote: quote.body,
      channelState: {
        channelId: quoteReq.channelId,
        stateNonce: 1,
        balA: "999000000",
        balB: "1000",
        locksRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
        stateExpiry: Math.floor(Date.now() / 1000) + 120,
        contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
      },
      sigA: "0x1234"
    };
    const ticketResp = await requestJson("POST", `${hubUrl}/v1/tickets/issue`, issueReq);
    assert(ticketResp.statusCode === 200, "ticket issue should succeed");
    const ticket = { ...ticketResp.body };
    delete ticket.channelAck;
    delete ticket.hubChannelAck;

    const paymentPayload = {
      scheme: "statechannel-hub-v1",
      paymentId,
      invoiceId,
      ticket,
      channelProof: {
        channelId: quoteReq.channelId,
        stateNonce: 1,
        stateHash: hashChannelState(issueReq.channelState),
        sigA: "0xabcd"
      }
    };

    const paid = await requestJson("GET", payeeUrl, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
    });
    assert(paid.statusCode === 200, "paid request should succeed");
    assert(paid.body.ok === true, "payee should return ok=true");

    console.log("e2e ok");
    console.log(JSON.stringify(paid.body, null, 2));
  } finally {
    await new Promise((r) => payee.close(r));
    await new Promise((r) => hub.close(r));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
