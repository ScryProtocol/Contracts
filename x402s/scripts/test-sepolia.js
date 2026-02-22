/* eslint-disable no-console */
const http = require("http");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { signChannelState } = require("../node/scp-hub/state-signing");

// --- Config ---
const RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const CONTRACT = "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b";
const AGENT_KEY = "0xe55248855119d2e3213dc3622fc28fe4c58f3c85f4908c3b704169392230b261";
const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
const ZERO32 = "0x" + "0".repeat(64);

const NUM_CHANNELS = Number(process.env.CHANNELS || 3);
const PAYMENTS_PER_CHANNEL = Number(process.env.PAYMENTS || 4);
const DEPOSIT_ETH = process.env.DEPOSIT || "0.003";
const PAYMENT_ETH = process.env.PAYMENT || "0.0002";

const ABI = [
  "function openChannel(address hub, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt) external payable returns (bytes32 channelId)",
  "function cooperativeClose((bytes32 channelId, uint64 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint64 stateExpiry, bytes32 contextHash) st, bytes sigA, bytes sigB) external",
  "function getChannel(bytes32 channelId) view returns ((address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalBalance, bool isClosing, uint64 closeDeadline, uint64 latestNonce) params)",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry)",
  "event ChannelClosed(bytes32 indexed channelId, uint64 indexed finalNonce, uint256 payoutA, uint256 payoutB)"
];

// --- Helpers ---

function requestJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: { "Content-Type": "application/json" }
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_e) { reject(new Error("parse error: " + data)); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString("hex")}`;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function fmt(wei) {
  return ethers.utils.formatEther(wei);
}

// --- Main ---

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const agent = new ethers.Wallet(AGENT_KEY, provider);
  const hubWallet = new ethers.Wallet(HUB_KEY);
  const contract = new ethers.Contract(CONTRACT, ABI, agent);

  const startBal = await agent.getBalance();
  console.log("Agent:   ", agent.address);
  console.log("Hub:     ", hubWallet.address);
  console.log("Balance: ", fmt(startBal), "ETH");
  console.log("Plan:    ", NUM_CHANNELS, "channels x", PAYMENTS_PER_CHANNEL, "payments =", NUM_CHANNELS * PAYMENTS_PER_CHANNEL, "total");
  console.log();

  // ═══════════════════════════════════════════
  // 1. Start hub server
  // ═══════════════════════════════════════════
  process.env.HUB_PRIVATE_KEY = HUB_KEY;
  process.env.STORE_PATH = "/tmp/sepolia-multi-" + now() + ".json";
  const { createServer } = require("../node/scp-hub/server");
  const hubServer = createServer();
  const hubPort = await new Promise((r) => {
    hubServer.listen(0, "127.0.0.1", () => r(hubServer.address().port));
  });
  const hubUrl = `http://127.0.0.1:${hubPort}`;
  console.log("Hub running at", hubUrl);

  // ═══════════════════════════════════════════
  // 2. Open channels on-chain
  // ═══════════════════════════════════════════
  console.log("\n=== Opening", NUM_CHANNELS, "channels ===");
  const depositAmount = ethers.utils.parseEther(DEPOSIT_ETH);
  const channels = [];

  for (let i = 0; i < NUM_CHANNELS; i++) {
    const salt = ethers.utils.formatBytes32String(`ch${i}-${now()}`);
    const tx = await contract.openChannel(
      hubWallet.address,
      ethers.constants.AddressZero,
      depositAmount,
      300,
      now() + 86400,
      salt,
      { value: depositAmount, gasLimit: 200000 }
    );
    const rc = await tx.wait(1);
    const channelId = rc.events.find(e => e.event === "ChannelOpened").args.channelId;
    channels.push({
      id: channelId,
      totalBalance: depositAmount.toBigInt(),
      nonce: 0,
      balA: depositAmount.toBigInt(),
      balB: 0n,
      payments: [],
      openTx: tx.hash
    });
    console.log(`  ch${i}: ${channelId.slice(0, 18)}... (${fmt(depositAmount)} ETH) tx:${tx.hash.slice(0, 18)}...`);
  }

  // ═══════════════════════════════════════════
  // 3. Make payments through hub
  // ═══════════════════════════════════════════
  const paymentWei = ethers.utils.parseEther(PAYMENT_ETH).toString();
  const payees = [];
  for (let i = 0; i < NUM_CHANNELS; i++) {
    payees.push("0x" + crypto.createHash("sha256").update(`payee-${i}`).digest("hex").slice(0, 40));
  }

  console.log("\n=== Making", NUM_CHANNELS * PAYMENTS_PER_CHANNEL, "payments ===");

  for (let i = 0; i < NUM_CHANNELS; i++) {
    const ch = channels[i];
    const payeeAddr = payees[i];

    for (let p = 0; p < PAYMENTS_PER_CHANNEL; p++) {
      const invoiceId = randomId("inv");
      const paymentId = randomId("pay");
      const contextHash = ethers.utils.id(`payment-ch${i}-p${p}`);

      // Quote
      const quoteRes = await requestJson("POST", `${hubUrl}/v1/tickets/quote`, {
        invoiceId,
        paymentId,
        channelId: ch.id,
        payee: payeeAddr,
        asset: ethers.constants.AddressZero,
        amount: paymentWei,
        maxFee: ethers.utils.parseEther("0.001").toString(),
        quoteExpiry: now() + 120,
        contextHash
      });
      if (quoteRes.status !== 200) throw new Error(`quote failed ch${i} p${p}: ${JSON.stringify(quoteRes.body)}`);

      // Update balances
      const totalDebit = BigInt(quoteRes.body.totalDebit);
      ch.nonce += 1;
      ch.balA -= totalDebit;
      ch.balB += totalDebit;

      const channelState = {
        channelId: ch.id,
        stateNonce: ch.nonce,
        balA: ch.balA.toString(),
        balB: ch.balB.toString(),
        locksRoot: ZERO32,
        stateExpiry: now() + 3600,
        contextHash
      };

      // Sign & issue
      const sigA = await signChannelState(channelState, agent);
      const issueRes = await requestJson("POST", `${hubUrl}/v1/tickets/issue`, {
        quote: quoteRes.body,
        channelState,
        sigA
      });
      if (issueRes.status !== 200) throw new Error(`issue failed ch${i} p${p}: ${JSON.stringify(issueRes.body)}`);

      ch.payments.push({
        paymentId,
        ticketId: issueRes.body.ticketId,
        amount: paymentWei,
        fee: quoteRes.body.fee,
        totalDebit: quoteRes.body.totalDebit
      });
      ch.lastState = channelState;
      ch.lastSigA = sigA;
      ch.lastSigB = issueRes.body.channelAck.sigB;

      console.log(`  ch${i} pay${p}: ${fmt(paymentWei)} ETH + ${fmt(quoteRes.body.fee)} fee → ticket ${issueRes.body.ticketId}`);
    }
  }

  // ═══════════════════════════════════════════
  // 4. Close all channels on-chain
  // ═══════════════════════════════════════════
  console.log("\n=== Closing", NUM_CHANNELS, "channels ===");
  const closeTxs = [];

  for (let i = 0; i < NUM_CHANNELS; i++) {
    const ch = channels[i];
    const tx = await contract.cooperativeClose(ch.lastState, ch.lastSigA, ch.lastSigB, { gasLimit: 150000 });
    const rc = await tx.wait(1);
    const ev = rc.events.find(e => e.event === "ChannelClosed");
    closeTxs.push(tx.hash);

    console.log(`  ch${i}: payoutA=${fmt(ev.args.payoutA)} payoutB=${fmt(ev.args.payoutB)} nonce=${ch.nonce} tx:${tx.hash.slice(0, 18)}...`);
  }

  // ═══════════════════════════════════════════
  // 5. Summary
  // ═══════════════════════════════════════════
  const endBal = await agent.getBalance();
  const totalPayments = NUM_CHANNELS * PAYMENTS_PER_CHANNEL;
  let totalPaidToHub = 0n;
  let totalFees = 0n;

  console.log("\n=== Summary ===");
  console.log("Channels:  ", NUM_CHANNELS);
  console.log("Payments:  ", totalPayments);

  for (let i = 0; i < NUM_CHANNELS; i++) {
    const ch = channels[i];
    totalPaidToHub += ch.balB;
    const chFees = ch.payments.reduce((s, p) => s + BigInt(p.fee), 0n);
    totalFees += chFees;
    console.log(`  ch${i}: ${ch.payments.length} pays, agent kept ${fmt(ch.balA)}, hub got ${fmt(ch.balB)} (fees: ${fmt(chFees)})`);
  }

  // Check payee inboxes
  console.log("\nPayee inboxes:");
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const inbox = await requestJson("GET", `${hubUrl}/v1/payee/inbox?payee=${payees[i]}`);
    console.log(`  payee${i}: ${inbox.body.count} payments received`);
  }

  console.log("\nTotals:");
  console.log("  Paid to hub:  ", fmt(totalPaidToHub), "ETH");
  console.log("  Hub fees:     ", fmt(totalFees), "ETH");
  console.log("  Gas spent:    ", fmt(startBal.sub(endBal).sub(depositAmount.mul(NUM_CHANNELS))), "ETH");
  console.log("  Agent balance:", fmt(endBal), "ETH (was", fmt(startBal) + ")");

  console.log("\nEtherscan:");
  for (let i = 0; i < NUM_CHANNELS; i++) {
    console.log(`  ch${i} open:  https://sepolia.etherscan.io/tx/${channels[i].openTx}`);
    console.log(`  ch${i} close: https://sepolia.etherscan.io/tx/${closeTxs[i]}`);
  }

  hubServer.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
