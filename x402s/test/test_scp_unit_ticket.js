const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

const {
  signTicketDraft,
  verifyTicket,
  verifyPayment,
  verifyDirectPayment,
  verifyPaymentFull,
  verifyPaymentSimple
} = require("../node/scp-hub/ticket");
const { signChannelState, hashChannelState } = require("../node/scp-hub/state-signing");

function now() {
  return Math.floor(Date.now() / 1000);
}

function sampleState(overrides = {}) {
  return {
    channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
    stateNonce: 1,
    balA: "999000000",
    balB: "1000",
    locksRoot: ethers.constants.HashZero,
    stateExpiry: now() + 300,
    contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f",
    ...overrides
  };
}

function sampleTicketDraft(hub, payee, overrides = {}) {
  return {
    ticketId: `tkt_${Date.now()}`,
    hub,
    payee,
    invoiceId: "inv_test_001",
    paymentId: "pay_test_001",
    asset: ethers.constants.AddressZero,
    amount: "1000",
    feeCharged: "10",
    totalDebit: "1010",
    expiry: now() + 300,
    policyHash: ethers.utils.hexlify(crypto.randomBytes(32)),
    ...overrides
  };
}

describe("SCP Ticket Unit", function () {
  const hubWallet = new ethers.Wallet("0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001");
  const payerWallet = new ethers.Wallet("0x7d577fdd4a1ec2aa00e7cdbf95db7fdbd7a6fd531f4be75f4fca31f6d8b3af88");
  const payeeWallet = new ethers.Wallet("0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555");

  it("signs and verifies ticket signer address", async function () {
    const draft = sampleTicketDraft(hubWallet.address, payeeWallet.address);
    const sig = await signTicketDraft(draft, hubWallet);
    const recovered = verifyTicket({ ...draft, sig });
    expect(recovered.toLowerCase()).to.eq(hubWallet.address.toLowerCase());
  });

  it("rejects hub payment when channel proof hash is tampered", async function () {
    const draft = sampleTicketDraft(hubWallet.address, payeeWallet.address);
    const sig = await signTicketDraft(draft, hubWallet);
    const state = sampleState();
    const sigA = await signChannelState(state, payerWallet);
    const payload = {
      scheme: "statechannel-hub-v1",
      paymentId: draft.paymentId,
      invoiceId: draft.invoiceId,
      ticket: { ...draft, sig },
      channelProof: {
        channelId: state.channelId,
        stateNonce: state.stateNonce,
        stateHash: ethers.utils.hexlify(crypto.randomBytes(32)),
        sigA,
        channelState: state
      }
    };
    const out = verifyPayment(JSON.stringify(payload), {
      hub: hubWallet.address,
      payee: payeeWallet.address,
      amount: draft.amount
    });
    expect(out.ok).to.eq(false);
    expect(out.error).to.eq("state hash mismatch");
  });

  it("verifies hub payment with valid channel proof", async function () {
    const draft = sampleTicketDraft(hubWallet.address, payeeWallet.address);
    const sig = await signTicketDraft(draft, hubWallet);
    const state = sampleState();
    const sigA = await signChannelState(state, payerWallet);
    const payload = {
      scheme: "statechannel-hub-v1",
      paymentId: draft.paymentId,
      invoiceId: draft.invoiceId,
      ticket: { ...draft, sig },
      channelProof: {
        channelId: state.channelId,
        stateNonce: state.stateNonce,
        stateHash: hashChannelState(state),
        sigA,
        channelState: state
      }
    };
    const out = verifyPayment(JSON.stringify(payload), {
      hub: hubWallet.address,
      payee: payeeWallet.address,
      amount: draft.amount
    });
    expect(out.ok).to.eq(true);
    expect(out.paymentId).to.eq(draft.paymentId);
  });

  it("verifies direct payment and tracks nonce progression", async function () {
    const state = sampleState({ balA: "5000", balB: "1000" });
    const sigA = await signChannelState(state, payerWallet);
    const payload = {
      scheme: "statechannel-direct-v1",
      invoiceId: "inv_dir_001",
      paymentId: "pay_dir_001",
      direct: {
        payer: payerWallet.address,
        payee: payeeWallet.address,
        asset: ethers.constants.AddressZero,
        amount: "1000",
        expiry: now() + 120,
        invoiceId: "inv_dir_001",
        paymentId: "pay_dir_001",
        channelState: state,
        sigA
      }
    };
    const channelState = new Map();
    const first = verifyDirectPayment(
      JSON.stringify(payload),
      { payee: payeeWallet.address, amount: "1000", asset: ethers.constants.AddressZero },
      channelState
    );
    expect(first.ok).to.eq(true);
    expect(channelState.get(state.channelId).nonce).to.eq(1);

    const second = verifyDirectPayment(
      JSON.stringify(payload),
      { payee: payeeWallet.address, amount: "1000", asset: ethers.constants.AddressZero },
      channelState
    );
    expect(second.ok).to.eq(false);
    expect(second.error).to.eq("stale direct nonce");
  });

  it("verifyPaymentFull performs hub metadata and payment-status checks", async function () {
    const draft = sampleTicketDraft(hubWallet.address, payeeWallet.address, {
      invoiceId: "inv_full_001",
      paymentId: "pay_full_001"
    });
    const sig = await signTicketDraft(draft, hubWallet);
    const payload = {
      scheme: "statechannel-hub-v1",
      paymentId: draft.paymentId,
      invoiceId: draft.invoiceId,
      ticket: { ...draft, sig }
    };
    const calls = [];
    const httpClient = {
      request: async (method, requestUrl) => {
        calls.push(`${method} ${requestUrl}`);
        if (requestUrl.endsWith("/.well-known/x402")) {
          return { statusCode: 200, body: { address: hubWallet.address } };
        }
        if (requestUrl.includes(`/v1/payments/${encodeURIComponent(draft.paymentId)}`)) {
          return { statusCode: 200, body: { status: "issued", ticketId: draft.ticketId } };
        }
        return { statusCode: 404, body: {} };
      }
    };
    const out = await verifyPaymentFull(JSON.stringify(payload), {
      payee: payeeWallet.address,
      amount: draft.amount,
      hubUrl: "http://hub.local:4021",
      httpClient,
      invoiceStore: new Map([[draft.invoiceId, { amount: draft.amount, asset: draft.asset }]])
    });

    expect(out.ok).to.eq(true);
    expect(out.scheme).to.eq("hub");
    expect(calls.length).to.eq(2);
  });

  it("verifyPaymentFull rejects unknown invoices", async function () {
    const draft = sampleTicketDraft(hubWallet.address, payeeWallet.address, {
      invoiceId: "inv_missing_001",
      paymentId: "pay_missing_001"
    });
    const sig = await signTicketDraft(draft, hubWallet);
    const out = await verifyPaymentFull(
      JSON.stringify({
        scheme: "statechannel-hub-v1",
        paymentId: draft.paymentId,
        invoiceId: draft.invoiceId,
        ticket: { ...draft, sig }
      }),
      {
        payee: payeeWallet.address,
        amount: draft.amount,
        hub: hubWallet.address,
        invoiceStore: new Map()
      }
    );
    expect(out.ok).to.eq(false);
    expect(out.error).to.eq("unknown invoice");
  });

  it("verifyPaymentSimple handles replayed payment IDs", async function () {
    const draft = sampleTicketDraft(hubWallet.address, payeeWallet.address, {
      paymentId: "pay_replay_unit_001",
      invoiceId: "inv_replay_unit_001"
    });
    const sig = await signTicketDraft(draft, hubWallet);
    const header = JSON.stringify({
      scheme: "statechannel-hub-v1",
      paymentId: draft.paymentId,
      invoiceId: draft.invoiceId,
      ticket: { ...draft, sig }
    });
    const seen = new Map([[draft.paymentId, { ok: true, receiptId: "r1" }]]);
    const out = verifyPaymentSimple(header, {
      hub: hubWallet.address,
      payee: payeeWallet.address,
      amount: draft.amount,
      seenPayments: seen
    });
    expect(out.ok).to.eq(true);
    expect(out.replayed).to.eq(true);
    expect(out.response.receiptId).to.eq("r1");
  });
});
