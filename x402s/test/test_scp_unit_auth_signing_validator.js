const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

const {
  buildPayeeAuthMessage,
  hashAuthBody,
  signPayeeAuth,
  recoverPayeeAuthSigner
} = require("../node/scp-common/payee-auth");
const {
  hashChannelState,
  signChannelState,
  recoverChannelStateSigner,
  setDomainDefaults
} = require("../node/scp-hub/state-signing");
const { buildValidators, validationMessage } = require("../node/scp-hub/validator");

function now() {
  return Math.floor(Date.now() / 1000);
}

function sampleChannelState(overrides = {}) {
  return {
    channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
    stateNonce: 1,
    balA: "1000",
    balB: "0",
    locksRoot: ethers.constants.HashZero,
    stateExpiry: now() + 120,
    contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f",
    ...overrides
  };
}

describe("SCP Auth/Signing/Validator Unit", function () {
  const payeeWallet = new ethers.Wallet("0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555");

  it("payee auth hash is stable across object key order", function () {
    const h1 = hashAuthBody({ b: 2, a: 1, nest: { z: 9, y: 8 } });
    const h2 = hashAuthBody({ nest: { y: 8, z: 9 }, a: 1, b: 2 });
    expect(h1).to.eq(h2);
  });

  it("payee auth sign/recover succeeds and detects tampering", async function () {
    const payload = {
      method: "post",
      path: "/v1/payee/settle",
      payee: payeeWallet.address.toUpperCase(),
      timestamp: now(),
      body: { payee: payeeWallet.address, amount: "1" }
    };
    const sig = await signPayeeAuth(payload, payeeWallet);
    const recovered = recoverPayeeAuthSigner({ ...payload, signature: sig });
    expect(recovered.toLowerCase()).to.eq(payeeWallet.address.toLowerCase());

    const tampered = recoverPayeeAuthSigner({
      ...payload,
      path: "/v1/payee/other",
      signature: sig
    });
    expect(tampered.toLowerCase()).to.not.eq(payeeWallet.address.toLowerCase());
  });

  it("payee auth message normalizes method and payee", function () {
    const msg = buildPayeeAuthMessage({
      method: "post",
      path: "/v1/test",
      payee: "0xABCD",
      timestamp: 123,
      body: {}
    });
    expect(msg).to.contain("\nPOST\n");
    expect(msg).to.contain("\n0xabcd\n");
  });

  it("state-signing recovers signer with explicit domain options", async function () {
    const wallet = new ethers.Wallet("0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001");
    const state = sampleChannelState();
    const opts = {
      chainId: 8453,
      contractAddress: "0x1111111111111111111111111111111111111111"
    };
    const sig = await signChannelState(state, wallet, opts);
    const recovered = recoverChannelStateSigner(state, sig, opts);
    expect(recovered.toLowerCase()).to.eq(wallet.address.toLowerCase());
  });

  it("state hash changes when domain changes", function () {
    const state = sampleChannelState();
    const hashA = hashChannelState(state, {
      chainId: 8453,
      contractAddress: "0x1111111111111111111111111111111111111111"
    });
    const hashB = hashChannelState(state, {
      chainId: 8453,
      contractAddress: "0x2222222222222222222222222222222222222222"
    });
    expect(hashA).to.not.eq(hashB);
  });

  it("setDomainDefaults accepts invalid values and falls back safely", function () {
    setDomainDefaults(-1, "bad-address");
    const state = sampleChannelState();
    const digest = hashChannelState(state);
    expect(/^0x[a-fA-F0-9]{64}$/.test(digest)).to.eq(true);
  });

  it("validators accept valid quote request and reject malformed issue/refund", function () {
    const validators = buildValidators();
    const goodQuoteReq = {
      invoiceId: "inv_val_001",
      paymentId: "pay_val_001",
      channelId: ethers.utils.hexlify(crypto.randomBytes(32)),
      payee: payeeWallet.address,
      asset: ethers.constants.AddressZero,
      amount: "1000",
      maxFee: "50",
      quoteExpiry: now() + 120,
      contextHash: "0x5f4cf45e4c1533216f69fcf4f6864db7a0b1f14f9788c61f2604961e59fb745f"
    };
    expect(validators.quoteRequest(goodQuoteReq)).to.eq(true);

    const badIssue = {
      quote: {},
      channelState: sampleChannelState(),
      sigA: "not-hex"
    };
    expect(validators.issueRequest(badIssue)).to.eq(false);
    expect(validationMessage(validators.issueRequest)).to.contain("should match pattern");

    const badRefund = {
      ticketId: "tkt_short",
      refundAmount: "-1",
      reason: ""
    };
    expect(validators.refundRequest(badRefund)).to.eq(false);
    expect(validationMessage(validators.refundRequest)).to.not.eq("invalid payload");
  });
});
