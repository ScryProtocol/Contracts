const crypto = require("crypto");
const http = require("http");
const { EventEmitter } = require("events");
const { expect } = require("chai");

const { WebhookManager, EVENT } = require("../node/scp-hub/webhooks");

function waitFor(condition, timeoutMs = 3000, stepMs = 25) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("wait timeout"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

function createStoreStub() {
  const mem = {};
  return {
    _backend: {
      async get(collection, key) {
        return mem[`${collection}:${key}`] || null;
      },
      async set(collection, key, value) {
        mem[`${collection}:${key}`] = value;
      }
    }
  };
}

describe("SCP Webhooks Unit", function () {
  this.timeout(10000);

  it("rejects invalid webhook url and invalid events list", function () {
    const manager = new WebhookManager(createStoreStub());
    const badUrl = manager.register({
      url: "/not-absolute",
      events: [EVENT.PAYMENT_RECEIVED],
      channelId: "*"
    });
    expect(badUrl.error).to.contain("invalid webhook url");

    const badEvents = manager.register({
      url: "http://127.0.0.1:9999/hook",
      events: ["unknown.event"],
      channelId: "*"
    });
    expect(badEvents.error).to.contain("events must be");
    manager.close();
  });

  it("updates and removes hooks with validation", function () {
    const manager = new WebhookManager(createStoreStub());
    const reg = manager.register({
      url: "http://127.0.0.1:9999/hook",
      events: [EVENT.PAYMENT_RECEIVED],
      channelId: "chan-1",
      secret: "abc123"
    });
    const id = reg.webhookId;
    expect(id).to.be.a("string");

    const updated = manager.update(id, {
      url: "http://127.0.0.1:9999/new",
      events: [EVENT.BALANCE_LOW],
      status: "paused"
    });
    expect(updated.url).to.contain("/new");
    expect(updated.events).to.deep.eq([EVENT.BALANCE_LOW]);
    expect(updated.status).to.eq("paused");

    const invalidUpdate = manager.update(id, { events: ["not-valid"] });
    expect(invalidUpdate).to.eq(null);

    expect(manager.remove(id)).to.eq(true);
    expect(manager.remove(id)).to.eq(false);
    manager.close();
  });

  it("emits events, preserves query path delivery, and signs payloads", async function () {
    const originalRequest = http.request;
    const received = [];
    try {
      http.request = (opts, callback) => {
        let body = "";
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.destroy = () => {};
        req.write = (chunk) => {
          body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        };
        req.end = () => {
          received.push({ options: opts, body });
          const res = new EventEmitter();
          res.statusCode = 200;
          res.resume = () => {};
          process.nextTick(() => callback(res));
        };
        return req;
      };

      const manager = new WebhookManager(createStoreStub());
      const secret = "super-secret";
      const reg = manager.register({
        url: "http://example.test/hook/path?foo=bar",
        events: [EVENT.PAYMENT_RECEIVED],
        channelId: "*",
        secret
      });

      const emitted = manager.emit(EVENT.PAYMENT_RECEIVED, { channelId: "chan-x", amount: "7" });
      expect(emitted.seq).to.eq(1);
      await waitFor(() => received.length === 1);

      const req = received[0];
      expect(req.options.path).to.eq("/hook/path?foo=bar");
      expect(req.options.headers["X-SCP-Event"]).to.eq(EVENT.PAYMENT_RECEIVED);
      expect(req.options.headers["X-SCP-Delivery-Attempt"]).to.eq("1");

      const parsed = JSON.parse(req.body);
      expect(parsed.webhookId).to.eq(reg.webhookId);
      const expectedSig = `sha256=${crypto.createHmac("sha256", secret).update(req.body).digest("hex")}`;
      expect(req.options.headers["X-SCP-Signature"]).to.eq(expectedSig);

      manager.close();
    } finally {
      http.request = originalRequest;
    }
  });

  it("poll filters by channelId and respects limits", function () {
    const manager = new WebhookManager(createStoreStub());
    manager.emit(EVENT.PAYMENT_RECEIVED, { channelId: "c1", amount: "1" });
    manager.emit(EVENT.PAYMENT_REFUNDED, { channelId: "c2", amount: "2" });
    manager.emit(EVENT.BALANCE_LOW, { channelId: "c1", amount: "3" });

    const c1 = manager.poll({ since: 0, channelId: "c1", limit: 10 });
    expect(c1.count).to.eq(2);
    expect(c1.items.every((x) => x.data.channelId === "c1")).to.eq(true);

    const limited = manager.poll({ since: 0, limit: 1 });
    expect(limited.count).to.eq(1);
    expect(limited.nextCursor).to.eq(limited.items[0].seq);
    manager.close();
  });
});
