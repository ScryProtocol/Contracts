const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("X402StateChannel", function () {
  let hub;
  let token;
  let failingToken;
  let a;
  let b;
  let other;
  let third;

  const ONE_ETH = ethers.utils.parseEther("1");

  const EIP712_TYPES = {
    ChannelState: [
      { name: "channelId", type: "bytes32" },
      { name: "stateNonce", type: "uint64" },
      { name: "balA", type: "uint256" },
      { name: "balB", type: "uint256" },
      { name: "locksRoot", type: "bytes32" },
      { name: "stateExpiry", type: "uint64" },
      { name: "contextHash", type: "bytes32" }
    ]
  };

  function eip712Domain() {
    return {
      name: "X402StateChannel",
      version: "1",
      chainId: 31337, // hardhat default
      verifyingContract: hub.address
    };
  }

  async function signState(state, signer) {
    return signer._signTypedData(eip712Domain(), EIP712_TYPES, state);
  }

  async function increaseTime(seconds) {
    await network.provider.send("evm_increaseTime", [seconds]);
    await network.provider.send("evm_mine");
  }

  beforeEach(async function () {
    [a, b, other, third] = await ethers.getSigners();

    const Hub = await ethers.getContractFactory("X402StateChannel");
    hub = await Hub.deploy();
    await hub.deployed();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy("Mock USD", "mUSD", 6);
    await token.deployed();

    const MockERC20FailingTransfer = await ethers.getContractFactory("MockERC20FailingTransfer");
    failingToken = await MockERC20FailingTransfer.deploy("Mock Fail USD", "mfUSD", 6);
    await failingToken.deployed();
  });

  async function openEthChannel(amount, challenge, expiryDelta, saltLabel) {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const salt = ethers.utils.formatBytes32String(saltLabel);
    const tx = await hub
      .connect(a)
      .openChannel(b.address, ethers.constants.AddressZero, amount, challenge, now + expiryDelta, salt, {
        value: amount,
      });
    const rc = await tx.wait();
    const channelId = rc.events.find((e) => e.event === "ChannelOpened").args.channelId;
    return { channelId, now };
  }

  it("opens and deposits ETH channel", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const salt = ethers.utils.formatBytes32String("eth-open");
    const openTx = await hub
      .connect(a)
      .openChannel(b.address, ethers.constants.AddressZero, ONE_ETH, 3600, now + 7200, salt, {
        value: ONE_ETH,
      });

    const openRc = await openTx.wait();
    const ev = openRc.events.find((e) => e.event === "ChannelOpened");
    const channelId = ev.args.channelId;

    const ch = await hub.getChannel(channelId);
    expect(ch.participantA).to.eq(a.address);
    expect(ch.participantB).to.eq(b.address);
    expect(ch.totalBalance).to.eq(ONE_ETH);

    const addAmount = ethers.utils.parseEther("0.25");
    await hub.connect(b).deposit(channelId, addAmount, { value: addAmount });

    const ch2 = await hub.getChannel(channelId);
    expect(ch2.totalBalance).to.eq(ONE_ETH.add(addAmount));
  });

  it("cooperative close settles ETH balances", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const salt = ethers.utils.formatBytes32String("coop-eth");
    const amount = ethers.utils.parseEther("1");

    const openTx = await hub
      .connect(a)
      .openChannel(b.address, ethers.constants.AddressZero, amount, 600, now + 7200, salt, {
        value: amount,
      });
    const openRc = await openTx.wait();
    const channelId = openRc.events.find((e) => e.event === "ChannelOpened").args.channelId;

    const state = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.7"),
      balB: ethers.utils.parseEther("0.3"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 1800,
      contextHash: ethers.utils.id("payee:demo"),
    };

    const sigA = await signState(state, a);
    const sigB = await signState(state, b);

    const hBalBefore = await ethers.provider.getBalance(b.address);
    await hub.connect(other).cooperativeClose(state, sigA, sigB);
    const hBalAfter = await ethers.provider.getBalance(b.address);

    expect(hBalAfter.sub(hBalBefore)).to.eq(state.balB);

    const closed = await hub.getChannel(channelId);
    expect(closed.participantA).to.eq(ethers.constants.AddressZero);
    expect(await ethers.provider.getBalance(hub.address)).to.eq(0);
  });

  it("unilateral close can be challenged with newer nonce", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const salt = ethers.utils.formatBytes32String("challenge-eth");
    const amount = ethers.utils.parseEther("1");

    const openTx = await hub
      .connect(a)
      .openChannel(b.address, ethers.constants.AddressZero, amount, 100, now + 7200, salt, {
        value: amount,
      });
    const openRc = await openTx.wait();
    const channelId = openRc.events.find((e) => e.event === "ChannelOpened").args.channelId;

    const state1 = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.8"),
      balB: ethers.utils.parseEther("0.2"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 1800,
      contextHash: ethers.utils.id("n1"),
    };

    const state2 = {
      channelId,
      stateNonce: 2,
      balA: ethers.utils.parseEther("0.75"),
      balB: ethers.utils.parseEther("0.25"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 1800,
      contextHash: ethers.utils.id("n2"),
    };

    const sigBOn1 = await signState(state1, b);
    await hub.connect(a).startClose(state1, sigBOn1);

    const sigAOn2 = await signState(state2, a);
    await hub.connect(b).challenge(state2, sigAOn2);

    await increaseTime(101);

    const hBalBefore = await ethers.provider.getBalance(b.address);
    await hub.connect(other).finalizeClose(channelId);
    const hBalAfter = await ethers.provider.getBalance(b.address);

    expect(hBalAfter.sub(hBalBefore)).to.eq(state2.balB);
  });

  it("rejects expired state in cooperative close", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const salt = ethers.utils.formatBytes32String("expired");

    const openTx = await hub
      .connect(a)
      .openChannel(b.address, ethers.constants.AddressZero, ONE_ETH, 600, now + 7200, salt, {
        value: ONE_ETH,
      });
    const openRc = await openTx.wait();
    const channelId = openRc.events.find((e) => e.event === "ChannelOpened").args.channelId;

    const expiredState = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.9"),
      balB: ethers.utils.parseEther("0.1"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now - 1,
      contextHash: ethers.utils.id("expired"),
    };

    const sigA = await signState(expiredState, a);
    const sigB = await signState(expiredState, b);

    await expect(hub.connect(other).cooperativeClose(expiredState, sigA, sigB)).to.be.revertedWith(
      "SCP: state expired"
    );
  });

  it("supports ERC20 channel open and cooperative close", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const amount = ethers.BigNumber.from("1000000");

    await token.mint(a.address, amount);
    await token.connect(a).approve(hub.address, amount);

    const salt = ethers.utils.formatBytes32String("erc20");
    const openTx = await hub.connect(a).openChannel(b.address, token.address, amount, 600, now + 7200, salt);
    const openRc = await openTx.wait();
    const channelId = openRc.events.find((e) => e.event === "ChannelOpened").args.channelId;

    const state = {
      channelId,
      stateNonce: 1,
      balA: ethers.BigNumber.from("750000"),
      balB: ethers.BigNumber.from("250000"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 1800,
      contextHash: ethers.utils.id("erc20-state"),
    };

    const sigA = await signState(state, a);
    const sigB = await signState(state, b);

    await hub.connect(other).cooperativeClose(state, sigA, sigB);

    expect(await token.balanceOf(a.address)).to.eq(state.balA);
    expect(await token.balanceOf(b.address)).to.eq(state.balB);
    expect(await token.balanceOf(hub.address)).to.eq(0);
  });

  it("defers failed ERC20 payouts and allows later withdrawal", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const amount = ethers.BigNumber.from("1000000");

    await failingToken.mint(a.address, amount);
    await failingToken.connect(a).approve(hub.address, amount);
    await failingToken.setFailure(b.address, true);

    const salt = ethers.utils.formatBytes32String("erc20-defer");
    const openTx = await hub
      .connect(a)
      .openChannel(b.address, failingToken.address, amount, 600, now + 7200, salt);
    const openRc = await openTx.wait();
    const channelId = openRc.events.find((e) => e.event === "ChannelOpened").args.channelId;

    const state = {
      channelId,
      stateNonce: 1,
      balA: ethers.BigNumber.from("750000"),
      balB: ethers.BigNumber.from("250000"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 1800,
      contextHash: ethers.utils.id("erc20-defer-state"),
    };
    const sigA = await signState(state, a);
    const sigB = await signState(state, b);

    await hub.connect(other).cooperativeClose(state, sigA, sigB);

    const closed = await hub.getChannel(channelId);
    expect(closed.participantA).to.eq(ethers.constants.AddressZero);
    expect(await failingToken.balanceOf(a.address)).to.eq(state.balA);
    expect(await failingToken.balanceOf(b.address)).to.eq(0);
    expect(await hub.pendingPayout(failingToken.address, b.address)).to.eq(state.balB);
    expect(await failingToken.balanceOf(hub.address)).to.eq(state.balB);

    await failingToken.setFailure(b.address, false);
    await hub.connect(b).withdrawPayout(failingToken.address);

    expect(await hub.pendingPayout(failingToken.address, b.address)).to.eq(0);
    expect(await failingToken.balanceOf(b.address)).to.eq(state.balB);
    expect(await failingToken.balanceOf(hub.address)).to.eq(0);
  });

  it("rejects non-participant deposits", async function () {
    const { channelId } = await openEthChannel(ONE_ETH, 3600, 7200, "deposit-auth");
    await expect(
      hub.connect(other).deposit(channelId, ethers.utils.parseEther("0.1"), { value: ethers.utils.parseEther("0.1") })
    ).to.be.revertedWith("SCP: not participant");
  });

  it("rejects ETH deposits with wrong msg.value", async function () {
    const { channelId } = await openEthChannel(ONE_ETH, 3600, 7200, "deposit-value");
    await expect(
      hub.connect(b).deposit(channelId, ethers.utils.parseEther("0.1"), { value: ethers.utils.parseEther("0.09") })
    ).to.be.revertedWith("SCP: bad msg.value");
  });

  it("rejects opening duplicate channel id", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const salt = ethers.utils.formatBytes32String("dup");
    await hub
      .connect(a)
      .openChannel(b.address, ethers.constants.AddressZero, ONE_ETH, 600, now + 3600, salt, { value: ONE_ETH });
    await expect(
      hub
        .connect(a)
        .openChannel(b.address, ethers.constants.AddressZero, ONE_ETH, 600, now + 3600, salt, { value: ONE_ETH })
    ).to.be.revertedWith("SCP: exists");
  });

  it("rejects cooperative close with invalid counterparty signature", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 600, 7200, "bad-sig-close");
    const state = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.6"),
      balB: ethers.utils.parseEther("0.4"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("bad-sig"),
    };
    const sigA = await signState(state, a);
    const sigNotHub = await signState(state, other);
    await expect(hub.connect(other).cooperativeClose(state, sigA, sigNotHub)).to.be.revertedWith("SCP: bad sigB");
  });

  it("rejects cooperative close if balances do not sum to channel total", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 600, 7200, "bad-bal");
    const state = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.95"),
      balB: ethers.utils.parseEther("0.02"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("bad-bal"),
    };
    const sigA = await signState(state, a);
    const sigB = await signState(state, b);
    await expect(hub.connect(other).cooperativeClose(state, sigA, sigB)).to.be.revertedWith("SCP: bad balances");
  });

  it("rejects startClose by non-participant", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 600, 7200, "startclose-auth");
    const state = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.8"),
      balB: ethers.utils.parseEther("0.2"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("start-auth"),
    };
    const sigB = await signState(state, b);
    await expect(hub.connect(other).startClose(state, sigB)).to.be.revertedWith("SCP: not participant");
  });

  it("rejects challenge with stale nonce", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 100, 7200, "stale-challenge");
    const state1 = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.8"),
      balB: ethers.utils.parseEther("0.2"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("c1"),
    };
    const sigBOn1 = await signState(state1, b);
    await hub.connect(a).startClose(state1, sigBOn1);
    const sigAOn1 = await signState(state1, a);
    await expect(hub.connect(b).challenge(state1, sigAOn1)).to.be.revertedWith("SCP: stale nonce");
  });

  it("rejects finalizeClose before deadline", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 300, 7200, "finalize-early");
    const state1 = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.8"),
      balB: ethers.utils.parseEther("0.2"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("fe"),
    };
    const sigB = await signState(state1, b);
    await hub.connect(a).startClose(state1, sigB);
    await expect(hub.connect(other).finalizeClose(channelId)).to.be.revertedWith("SCP: challenge open");
  });

  it("rejects challenge after deadline", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 50, 7200, "challenge-late");
    const state1 = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.8"),
      balB: ethers.utils.parseEther("0.2"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("late-1"),
    };
    const state2 = {
      channelId,
      stateNonce: 2,
      balA: ethers.utils.parseEther("0.75"),
      balB: ethers.utils.parseEther("0.25"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("late-2"),
    };
    const sigB = await signState(state1, b);
    await hub.connect(a).startClose(state1, sigB);
    await increaseTime(51);
    const sigA = await signState(state2, a);
    await expect(hub.connect(b).challenge(state2, sigA)).to.be.revertedWith("SCP: deadline passed");
  });

  it("rejects repeated startClose after channel enters closing", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 100, 7200, "startclose-repeat");
    const state1 = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.8"),
      balB: ethers.utils.parseEther("0.2"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 600,
      contextHash: ethers.utils.id("repeat-startclose"),
    };
    const sigBOn1 = await signState(state1, b);
    await hub.connect(a).startClose(state1, sigBOn1);
    await expect(hub.connect(a).startClose(state1, sigBOn1)).to.be.revertedWith("SCP: already closing");
  });

  it("rejects reopening a previously closed channel id", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const amount = ONE_ETH;
    const salt = ethers.utils.formatBytes32String("reopen-same-id");
    const openTx = await hub
      .connect(a)
      .openChannel(b.address, ethers.constants.AddressZero, amount, 600, now + 7200, salt, {
        value: amount,
      });
    const openRc = await openTx.wait();
    const channelId = openRc.events.find((e) => e.event === "ChannelOpened").args.channelId;

    const closeState = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.7"),
      balB: ethers.utils.parseEther("0.3"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 1800,
      contextHash: ethers.utils.id("close-once"),
    };
    const sigA = await signState(closeState, a);
    const sigB = await signState(closeState, b);
    await hub.connect(other).cooperativeClose(closeState, sigA, sigB);

    await expect(
      hub
        .connect(a)
        .openChannel(b.address, ethers.constants.AddressZero, amount, 600, now + 7200, salt, {
          value: amount,
        })
    ).to.be.revertedWith("SCP: id used");
  });

  it("rejects ERC20 open without allowance", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    const amount = ethers.BigNumber.from("1000000");
    await token.mint(a.address, amount);
    await expect(
      hub.connect(a).openChannel(b.address, token.address, amount, 600, now + 3600, ethers.utils.formatBytes32String("no-allow"))
    ).to.be.revertedWith("SCP: transferFrom");
  });

  it("rejects operations on unknown channels", async function () {
    const fake = ethers.utils.id("fake");
    await expect(hub.getChannel(fake)).to.not.be.reverted;
    await expect(hub.connect(a).deposit(fake, 1, { value: 1 })).to.be.revertedWith("SCP: not found");
    await expect(hub.connect(a).finalizeClose(fake)).to.be.revertedWith("SCP: not found");
  });

  it("removes closed channels from active indexes", async function () {
    const { channelId, now } = await openEthChannel(ONE_ETH, 600, 7200, "index-cleanup");
    const state = {
      channelId,
      stateNonce: 1,
      balA: ethers.utils.parseEther("0.6"),
      balB: ethers.utils.parseEther("0.4"),
      locksRoot: ethers.constants.HashZero,
      stateExpiry: now + 1800,
      contextHash: ethers.utils.id("cleanup"),
    };
    const sigA = await signState(state, a);
    const sigB = await signState(state, b);

    await hub.connect(other).cooperativeClose(state, sigA, sigB);

    expect(await hub.getChannelCount()).to.eq(0);
    const ids = await hub.getChannelIds(0, 10);
    expect(ids.length).to.eq(0);
    const aIds = await hub.getChannelsByParticipant(a.address);
    const bIds = await hub.getChannelsByParticipant(b.address);
    expect(aIds.length).to.eq(0);
    expect(bIds.length).to.eq(0);
  });

  it("rejects open with invalid params", async function () {
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await expect(
      hub
        .connect(a)
        .openChannel(
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          ONE_ETH,
          600,
          now + 3600,
          ethers.utils.formatBytes32String("bad-h"),
          { value: ONE_ETH }
        )
    ).to.be.revertedWith("SCP: bad participantB");

    await expect(
      hub
        .connect(a)
        .openChannel(
          b.address,
          ethers.constants.AddressZero,
          ONE_ETH,
          0,
          now + 3600,
          ethers.utils.formatBytes32String("bad-c"),
          { value: ONE_ETH }
        )
    ).to.be.revertedWith("SCP: bad challenge");
  });
});
