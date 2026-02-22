const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");

const {
  MemoryBackend,
  JsonFileBackend,
  createStorage
} = require("../node/scp-hub/storage");

function tempFile(name) {
  return path.join(
    os.tmpdir(),
    `scp-storage-${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

describe("SCP Storage Unit", function () {
  it("memory backend tx writes and reads state", async function () {
    const backend = new MemoryBackend();
    await backend.tx((s) => {
      s.payments.p1 = { paymentId: "p1", status: "issued" };
      s.channels.c1 = { channelId: "c1", latestNonce: 1 };
    });
    const payment = await backend.get("payments", "p1");
    const channel = await backend.get("channels", "c1");
    expect(payment.status).to.eq("issued");
    expect(channel.latestNonce).to.eq(1);
  });

  it("memory backend trims payee ledger to max entries", async function () {
    const backend = new MemoryBackend();
    const payee = "0xabc";
    for (let i = 0; i < 10020; i++) {
      await backend.appendLedger(payee, { seq: i + 1, amount: "1" });
    }
    const ledger = await backend.getLedger(payee);
    expect(ledger.length).to.eq(10000);
    expect(ledger[0].seq).to.eq(21);
    expect(ledger[ledger.length - 1].seq).to.eq(10020);
  });

  it("json backend persists records across instances", async function () {
    const filePath = tempFile("persist");
    try {
      const b1 = new JsonFileBackend(filePath);
      await b1.set("payments", "pay_1", { paymentId: "pay_1", status: "issued" });
      await b1.appendLedger("0xpayee", { seq: 1, amount: "10" });

      const b2 = new JsonFileBackend(filePath);
      const payment = await b2.get("payments", "pay_1");
      const ledger = await b2.getLedger("0xpayee");
      expect(payment.status).to.eq("issued");
      expect(ledger.length).to.eq(1);
      expect(ledger[0].amount).to.eq("10");
    } finally {
      fs.rmSync(filePath, { force: true });
      fs.rmSync(`${filePath}.lock`, { force: true });
    }
  });

  it("json backend serializes concurrent increments", async function () {
    const filePath = tempFile("incr");
    try {
      const backend = new JsonFileBackend(filePath);
      await Promise.all(
        Array.from({ length: 25 }, () => backend.incr("nextSeq"))
      );
      const seq = await backend.getSeq();
      expect(seq).to.eq(26);
    } finally {
      fs.rmSync(filePath, { force: true });
      fs.rmSync(`${filePath}.lock`, { force: true });
    }
  });

  it("createStorage(:memory:) supports tx/list/get wrappers", async function () {
    const store = createStorage(":memory:");
    await store.tx((s) => {
      s.payments.pay_2 = { paymentId: "pay_2", status: "quoted" };
    });
    const payment = await store.getPayment("pay_2");
    const list = await store.listPayments();
    expect(payment.status).to.eq("quoted");
    expect(Object.keys(list)).to.include("pay_2");
  });

  it("createStorage indexed helpers resolve ticket/channel/payee payment views", async function () {
    const store = createStorage(":memory:");
    await store.tx((s) => {
      s.payments.pay_3 = {
        paymentId: "pay_3",
        status: "issued",
        ticketId: "tkt_3",
        channelId: "ch_3",
        payee: "0xabc"
      };
      s.paymentsByTicketId.tkt_3 = "pay_3";
      s.paymentIdsByChannel.ch_3 = { pay_3: 1 };
      s.paymentIdsByPayee["0xabc"] = { pay_3: 1 };
    });

    const byTicket = await store.getPaymentByTicketId("tkt_3");
    const byChannel = await store.listPaymentsByChannel("ch_3");
    const byPayee = await store.listPaymentsByPayee("0xAbC");

    expect(byTicket.paymentId).to.eq("pay_3");
    expect(byChannel.length).to.eq(1);
    expect(byChannel[0].paymentId).to.eq("pay_3");
    expect(byPayee.length).to.eq(1);
    expect(byPayee[0].paymentId).to.eq("pay_3");
  });

  it("createStorage with custom redis client supports tx-backed writes", async function () {
    const kv = new Map();
    const fakeRedis = {
      async watch(_key) {},
      async unwatch() {},
      async get(key) { return kv.has(key) ? kv.get(key) : null; },
      multi() {
        const ops = [];
        return {
          set: (key, value) => {
            ops.push([key, value]);
            return this;
          },
          exec: async () => {
            for (const [key, value] of ops) kv.set(key, value);
            return ["OK"];
          }
        };
      },
      async quit() {}
    };

    const store = createStorage({ redis: fakeRedis, ready: Promise.resolve() });
    await store.tx((s) => {
      s.payments.pay_redis = { paymentId: "pay_redis", status: "issued" };
    });
    const payment = await store.getPayment("pay_redis");
    expect(payment.status).to.eq("issued");
  });
});
