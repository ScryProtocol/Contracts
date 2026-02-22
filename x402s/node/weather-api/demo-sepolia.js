/* eslint-disable no-console */
const nodeHttp = require("http");
const crypto = require("crypto");
const { ethers } = require("ethers");
const { signChannelState } = require("../scp-hub/state-signing");
const { signPayeeAuth } = require("../scp-common/payee-auth");

const RPC = process.env.SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com";
const CONTRACT = "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b";
const AGENT_KEY = "0xe55248855119d2e3213dc3622fc28fe4c58f3c85f4908c3b704169392230b261";
const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
const ZERO32 = "0x" + "0".repeat(64);

const ABI = [
  "function openChannel(address hub, address asset, uint256 amount, uint64 challengePeriodSec, uint64 channelExpiry, bytes32 salt) external payable returns (bytes32 channelId)",
  "function cooperativeClose((bytes32 channelId, uint64 stateNonce, uint256 balA, uint256 balB, bytes32 locksRoot, uint64 stateExpiry, bytes32 contextHash) st, bytes sigA, bytes sigB) external",
  "function getChannel(bytes32 channelId) view returns ((address participantA, address participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry, uint256 totalBalance, bool isClosing, uint64 closeDeadline, uint64 latestNonce) params)",
  "event ChannelOpened(bytes32 indexed channelId, address indexed participantA, address indexed participantB, address asset, uint64 challengePeriodSec, uint64 channelExpiry)",
  "event ChannelClosed(bytes32 indexed channelId, uint64 indexed finalNonce, uint256 payoutA, uint256 payoutB)"
];

function now() { return Math.floor(Date.now() / 1000); }
function randomId(p) { return `${p}_${crypto.randomBytes(10).toString("hex")}`; }
function fmt(w) { return ethers.utils.formatEther(w); }

function httpReq(method, urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = body ? JSON.stringify(body) : null;
    const req = nodeHttp.request({
      method, hostname: u.hostname, port: u.port,
      path: u.pathname + u.search,
      headers: {
        "content-type": "application/json",
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        ...(headers || {})
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (_e) { reject(new Error("parse: " + d.slice(0, 300))); }
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const cities = process.argv.slice(2);
  if (!cities.length) cities.push("London", "Tokyo", "New York");

  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const agent = new ethers.Wallet(AGENT_KEY, provider);
  const hubWallet = new ethers.Wallet(HUB_KEY, provider);
  const contract = new ethers.Contract(CONTRACT, ABI, agent);
  const hubContract = new ethers.Contract(CONTRACT, ABI, hubWallet);

  // Payee B — random wallet (no gas needed for cooperative close via hub)
  const payeeWallet = ethers.Wallet.createRandom().connect(provider);
  const payeeAddr = payeeWallet.address;

  const agentBalStart = await agent.getBalance();
  const hubBalStart = await hubWallet.getBalance();
  console.log("Agent (A):", agent.address, "(" + fmt(agentBalStart) + " ETH)");
  console.log("Hub:      ", hubWallet.address, "(" + fmt(hubBalStart) + " ETH)");
  console.log("Payee (B):", payeeAddr);

  const depositA = ethers.utils.parseEther("0.003");
  const depositH = ethers.utils.parseEther("0.002");

  // ── 0. Fund hub wallet (so it can open Hub↔B channel) ──
  const hubNeedsFunding = hubBalStart.lt(depositH.add(ethers.utils.parseEther("0.002")));
  if (hubNeedsFunding) {
    const fundAmount = ethers.utils.parseEther("0.005");
    console.log("\n== 0. A funds Hub wallet (" + fmt(fundAmount) + " ETH) ==");
    const fundTx = await agent.sendTransaction({
      to: hubWallet.address, value: fundAmount, gasLimit: 21000
    });
    await fundTx.wait(1);
    console.log("tx:", fundTx.hash);
  }

  // ── 1. A opens A↔Hub channel ──
  console.log("\n== 1. A opens A↔Hub channel (0.003 ETH) ==");
  const saltA = ethers.utils.formatBytes32String(`wx-${now()}`);
  const openATx = await contract.openChannel(
    hubWallet.address, ethers.constants.AddressZero, depositA,
    300, now() + 86400, saltA,
    { value: depositA, gasLimit: 200000 }
  );
  const openARc = await openATx.wait(1);
  const channelIdAH = openARc.events.find(e => e.event === "ChannelOpened").args.channelId;
  console.log("A↔Hub channelId:", channelIdAH.slice(0, 18) + "...");
  console.log("tx:", openATx.hash);

  // ── 2. Hub opens Hub↔B channel ──
  console.log("\n== 2. Hub opens Hub↔B channel (0.002 ETH) ==");
  const saltH = ethers.utils.formatBytes32String(`hb-${now()}`);
  const openHTx = await hubContract.openChannel(
    payeeAddr, ethers.constants.AddressZero, depositH,
    300, now() + 86400, saltH,
    { value: depositH, gasLimit: 200000 }
  );
  const openHRc = await openHTx.wait(1);
  const channelIdHB = openHRc.events.find(e => e.event === "ChannelOpened").args.channelId;
  console.log("Hub↔B channelId:", channelIdHB.slice(0, 18) + "...");
  console.log("tx:", openHTx.hash);

  // Pause provider polling — the RPC provider's internal poll loop interferes
  // with the local HTTP event loop after long on-chain sequences.
  provider.polling = false;
  provider.removeAllListeners();

  // ── 3. Start hub + weather API ──
  console.log("\n== 3. Start hub + weather API ==");
  process.env.HUB_PRIVATE_KEY = HUB_KEY;
  process.env.STORE_PATH = ":memory:";
  process.env.RPC_URL = RPC;
  process.env.CONTRACT_ADDRESS = CONTRACT;
  const { createServer: createHub } = require("../scp-hub/server");
  const hub = createHub();
  const hubPort = await new Promise(r => hub.listen(0, "127.0.0.1", () => r(hub.address().port)));
  const hubUrl = `http://127.0.0.1:${hubPort}`;

  process.env.HUB_URL = hubUrl;
  process.env.WEATHER_PRICE = "200000000000000"; // 0.0002 ETH
  process.env.PAYEE_PRIVATE_KEY = payeeWallet.privateKey;
  const { createWeatherServer } = require("./server");
  const wxServer = createWeatherServer();
  const wxPort = await new Promise(r => wxServer.listen(0, "127.0.0.1", () => r(wxServer.address().port)));
  const wxUrl = `http://127.0.0.1:${wxPort}`;
  console.log("Hub:", hubUrl, "| Weather:", wxUrl);

  // Register Hub↔B channel in the hub's storage (opened on-chain above)
  const registerBody = {
    payee: payeeAddr,
    channelId: channelIdHB,
    asset: ethers.constants.AddressZero,
    totalDeposit: depositH.toString()
  };
  const registerTs = now();
  const registerSig = await signPayeeAuth({
    method: "POST",
    path: "/v1/hub/register-payee-channel",
    payee: payeeAddr,
    timestamp: registerTs,
    body: registerBody
  }, payeeWallet);
  await httpReq("POST", `${hubUrl}/v1/hub/register-payee-channel`, registerBody, {
    "x-scp-payee-signature": registerSig,
    "x-scp-payee-timestamp": String(registerTs)
  });

  // ── 4. A pays for weather through hub → B serves data ──
  let nonce = 0;
  let balA = depositA.toBigInt();
  let balB = 0n;
  let lastStateAH, lastSigA_AH, lastSigB_AH;

  console.log("\n== 4. A → Hub → B payments ==");
  for (const city of cities) {
    const offer = await httpReq("GET", `${wxUrl}/weather?city=${encodeURIComponent(city)}`);
    const ext = offer.body.accepts[0].extensions["statechannel-hub-v1"];
    const invoiceId = ext.invoiceId;
    const paymentId = randomId("pay");
    const amount = offer.body.price;
    const contextHash = ethers.utils.id(`wx:${city}:${paymentId}`);

    const quote = await httpReq("POST", `${hubUrl}/v1/tickets/quote`, {
      invoiceId, paymentId, channelId: channelIdAH,
      payee: ext.payeeAddress,
      asset: ethers.constants.AddressZero,
      amount, maxFee: ethers.utils.parseEther("0.001").toString(),
      quoteExpiry: now() + 120, contextHash
    });

    const totalDebit = BigInt(quote.body.totalDebit);
    nonce += 1;
    balA -= totalDebit;
    balB += totalDebit;
    const state = {
      channelId: channelIdAH, stateNonce: nonce,
      balA: balA.toString(), balB: balB.toString(),
      locksRoot: ZERO32, stateExpiry: now() + 3600, contextHash
    };
    const sigA = await signChannelState(state, agent);

    const issued = await httpReq("POST", `${hubUrl}/v1/tickets/issue`, {
      quote: quote.body, channelState: state, sigA
    });
    const ticket = { ...issued.body };
    lastSigB_AH = ticket.channelAck.sigB;
    lastStateAH = state;
    lastSigA_AH = sigA;
    delete ticket.channelAck;
    delete ticket.hubChannelAck;

    const wx = await httpReq("GET", `${wxUrl}/weather?city=${encodeURIComponent(city)}`, null, {
      "payment-signature": JSON.stringify({
        scheme: "statechannel-hub-v1", paymentId, invoiceId, ticket,
        channelProof: { channelId: channelIdAH, stateNonce: nonce, sigA }
      })
    });

    const c = wx.body.current;
    const loc = wx.body.location;
    console.log(`  ${loc.city}, ${loc.country}: ${c.temperature}°C — ${c.condition}`);
    console.log(`    paid ${fmt(amount)} + ${fmt(quote.body.fee)} fee`);
  }

  // ── 5. A checks spend ──
  console.log("\n== 5. A checks summary ==");
  const agentSummary = await httpReq("GET", `${hubUrl}/v1/agent/summary?channelId=${channelIdAH}`);
  const as = agentSummary.body;
  console.log("payments: ", as.payments);
  console.log("spent:    ", fmt(as.totalSpent), "ETH (to payees)");
  console.log("fees:     ", fmt(as.totalFees), "ETH (to hub)");
  console.log("totalDebit:", fmt(as.totalDebit), "ETH");

  // Re-enable provider for on-chain close operations
  provider.polling = true;

  // ── 6. A closes A↔Hub channel ──
  console.log("\n== 6. A closes A↔Hub channel ==");
  const closeATx = await contract.cooperativeClose(lastStateAH, lastSigA_AH, lastSigB_AH, { gasLimit: 150000 });
  const closeARc = await closeATx.wait(1);
  const evA = closeARc.events.find(e => e.event === "ChannelClosed");
  console.log("payoutA:", fmt(evA.args.payoutA), "ETH → Agent");
  console.log("payoutB:", fmt(evA.args.payoutB), "ETH → Hub");
  console.log("tx:", closeATx.hash);

  // ── 7. B gets Hub↔B channel state from hub ──
  console.log("\n== 7. B gets Hub↔B channel state ==");
  const hcState = await httpReq("GET", `${hubUrl}/v1/payee/channel-state?payee=${payeeAddr.toLowerCase()}`);
  console.log("Hub↔B channelId:", hcState.body.channelId.slice(0, 18) + "...");
  console.log("Hub↔B nonce:", hcState.body.nonce);
  console.log("Hub↔B balA (Hub):", fmt(hcState.body.balA), "ETH");
  console.log("Hub↔B balB (B):  ", fmt(hcState.body.balB), "ETH");

  // ── 8. B closes Hub↔B channel (TRUSTLESS — B calls contract directly!) ──
  console.log("\n== 8. B closes Hub↔B channel (trustless!) ==");
  const payeeBalBefore = await provider.getBalance(payeeAddr);
  console.log("B balance before:", fmt(payeeBalBefore), "ETH");

  // B gets the latest state + hub's signature (sigA, since hub is participantA)
  const hbState = hcState.body.latestState;
  const hubSigA = hcState.body.sigA;

  // B signs the state as participantB (payee is participantB in Hub↔B channel)
  const payeeSigB = await signChannelState(hbState, payeeWallet);

  // B calls cooperativeClose directly on the contract!
  // In Hub↔B: participantA=Hub, participantB=Payee
  // So sigA=hub's sig, sigB=payee's sig
  const payeeContract = new ethers.Contract(CONTRACT, ABI, payeeWallet);

  // B needs gas to call cooperativeClose — agent funds B with a tiny amount
  console.log("  (funding B with gas...)");
  const gasFundTx = await agent.sendTransaction({
    to: payeeAddr, value: ethers.utils.parseEther("0.002"), gasLimit: 21000
  });
  await gasFundTx.wait(1);

  const closeBTx = await payeeContract.cooperativeClose(hbState, hubSigA, payeeSigB, { gasLimit: 150000 });
  const closeBRc = await closeBTx.wait(1);
  const evB = closeBRc.events.find(e => e.event === "ChannelClosed");
  console.log("payoutA (Hub):", fmt(evB.args.payoutA), "ETH → Hub");
  console.log("payoutB (B):  ", fmt(evB.args.payoutB), "ETH → Payee!");
  console.log("tx:", closeBTx.hash);

  const payeeBalAfter = await provider.getBalance(payeeAddr);
  console.log("B balance after: ", fmt(payeeBalAfter), "ETH");
  console.log("B received:      ", fmt(payeeBalAfter.sub(payeeBalBefore)), "ETH (on-chain, trustless)");

  // ── 9. Final accounting ──
  console.log("\n== 9. Final accounting ==");
  const closedAH = await contract.getChannel(channelIdAH);
  const closedHB = await contract.getChannel(channelIdHB);
  console.log("A↔Hub channel deleted:", closedAH.participantA === ethers.constants.AddressZero ? "yes" : "no");
  console.log("Hub↔B channel deleted:", closedHB.participantA === ethers.constants.AddressZero ? "yes" : "no");

  const agentBalEnd = await agent.getBalance();
  const hubBalEnd = await hubWallet.getBalance();

  console.log("\n  Agent (A):");
  console.log("    started:    ", fmt(agentBalStart), "ETH");
  console.log("    deposited:  ", fmt(depositA), "ETH (A↔Hub)");
  console.log("    got back:   ", fmt(evA.args.payoutA), "ETH (A↔Hub close)");
  console.log("    net spend:  ", fmt(depositA.sub(evA.args.payoutA)), "ETH (payments + fees)");
  console.log("    final:      ", fmt(agentBalEnd), "ETH");

  console.log("  Hub:");
  console.log("    deposited:  ", fmt(depositH), "ETH (Hub↔B)");
  console.log("    from A↔Hub: ", fmt(evA.args.payoutB), "ETH (close payout)");
  console.log("    from Hub↔B: ", fmt(evB.args.payoutA), "ETH (remaining in Hub↔B)");
  console.log("    kept (fees):", fmt(BigInt(evA.args.payoutB) - BigInt(as.totalSpent)), "ETH");
  console.log("    final:      ", fmt(hubBalEnd), "ETH");

  console.log("  Payee (B):");
  console.log("    earned:     ", fmt(as.totalSpent), "ETH (from payments)");
  console.log("    received:   ", fmt(evB.args.payoutB), "ETH (from Hub↔B close, on-chain!)");
  console.log("    final:      ", fmt(payeeBalAfter), "ETH");

  console.log("\n== Etherscan ==");
  console.log("  A opens A↔Hub:     https://sepolia.etherscan.io/tx/" + openATx.hash);
  console.log("  Hub opens Hub↔B:   https://sepolia.etherscan.io/tx/" + openHTx.hash);
  console.log("  A closes A↔Hub:    https://sepolia.etherscan.io/tx/" + closeATx.hash);
  console.log("  B closes Hub↔B:    https://sepolia.etherscan.io/tx/" + closeBTx.hash);

  wxServer.close();
  hub.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
