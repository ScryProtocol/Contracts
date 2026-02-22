const { EventEmitter } = require("events");
const { handleRequest } = require("./server");

class FakeReq extends EventEmitter {
  constructor(method, path, bodyObj) {
    super();
    this.method = method;
    this.url = path;
    this._bodyObj = bodyObj;
  }

  start() {
    process.nextTick(() => {
      if (this._bodyObj !== undefined) {
        const data = JSON.stringify(this._bodyObj);
        this.emit("data", Buffer.from(data, "utf8"));
      }
      this.emit("end");
    });
  }
}

class FakeRes {
  constructor(done) {
    this.statusCode = 200;
    this.headers = {};
    this._body = "";
    this._done = done;
  }

  writeHead(code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
  }

  end(data) {
    this._body = data ? String(data) : "";
    this._done({
      statusCode: this.statusCode,
      headers: this.headers,
      body: this._body ? JSON.parse(this._body) : {}
    });
  }
}

function invoke(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const req = new FakeReq(method, path, bodyObj);
    const res = new FakeRes(resolve);
    handleRequest(req, res).catch(reject);
    req.start();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const x402 = await invoke("GET", "/.well-known/x402");
  assert(x402.statusCode === 200, "well-known should return 200");
  assert(Array.isArray(x402.body.schemes), "well-known should include schemes");

  const quoteReq = {
    invoiceId: "inv_01JXYZP2F8NT4M44RRFV78MNVW",
    paymentId: "pay_01JXYZP5A3GQ3T6WXPXJQW3HSA",
    channelId: "0x7a0de7b4f53d675f6fc0f21a32c6b957f8e477e2acbe92d2ab36ef0f7d5e57a0",
    payee: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913",
    amount: "1000000",
    maxFee: "5000",
    quoteExpiry: 2000000000
  };

  const quote = await invoke("POST", "/v1/tickets/quote", quoteReq);
  assert(quote.statusCode === 200, "quote should return 200");
  assert(quote.body.fee, "quote should include fee");

  const issueReq = {
    quote: quote.body,
    channelState: {
      channelId: quoteReq.channelId,
      stateNonce: 1,
      balA: "999000000",
      balB: "1000",
      locksRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      stateExpiry: 2000000001,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    },
    sigA: "0x1234"
  };
  const ticket = await invoke("POST", "/v1/tickets/issue", issueReq);
  assert(ticket.statusCode === 200, "issue should return 200");
  assert(ticket.body.sig, "ticket should include signature");

  const payment = await invoke("GET", `/v1/payments/${quoteReq.paymentId}`);
  assert(payment.statusCode === 200, "payment status should return 200");
  assert(payment.body.status === "issued", "payment status should be issued");

  console.log("http-selftest ok");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
