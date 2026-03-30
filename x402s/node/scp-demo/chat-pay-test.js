/* eslint-disable no-console */
const https = require("https");
const http = require("http");
const { ethers } = require("ethers");
const { hashChannelState, signChannelState, setDomainDefaults } = require("../scp-hub/state-signing");
const { resolveNetwork, resolveContract } = require("../scp-common/networks");

const CHAT = "http://127.0.0.1:4044";

// Agent key with funded Base channel
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY || "0x8875568F529BBA388542EA5D0E1D524D09DA520AEDFBF2CD20553BBB687D4D09";
const agentWallet = new ethers.Wallet(AGENT_KEY);
console.log("Agent:", agentWallet.address);

// Channel to use (from hub lookup — 0.001 ETH balance, nonce 2)
const CHANNEL_ID = process.env.CHANNEL_ID || "0xa0b2c546a1265dfdf9d09f58e6e6ff03d2c3341cec3d4a906b46c4004b73ed99";
const PREV_NONCE = Number(process.env.PREV_NONCE || 3);
const PREV_BAL_A = process.env.PREV_BAL_A || "979900000000000";
const PREV_BAL_B = process.env.PREV_BAL_B || "20100000000000";

function req(method, url, body, headers = {}) {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const r = mod.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      rejectUnauthorized: false,
      headers: {
        "content-type": "application/json", ...headers,
        ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let d = "";
      res.on("data", c => { d += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || "{}") }); }
        catch (e) { reject(new Error("parse error: " + d.slice(0, 200))); }
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function run() {
  // 1. Discover offers
  console.log("\n1. Discovering offers...");
  const disc = await req("GET", CHAT + "/pay");
  if (disc.status !== 402) throw new Error("expected 402, got " + disc.status);
  const offer = disc.body.accepts[0]; // ETH offer
  const ext = offer.extensions["statechannel-hub-v1"];
  const HUB = ext.hubEndpoint;
  console.log("   ETH price:", offer.maxAmountRequired, "wei to", ext.payeeAddress.slice(0, 12) + "...");
  console.log("   Hub:", HUB);

  // Set EIP-712 domain to match hub (Base mainnet)
  const baseNet = resolveNetwork("base");
  const baseContract = resolveContract(baseNet.chainId);
  setDomainDefaults(baseNet.chainId, baseContract);
  console.log("   Domain: chainId=" + baseNet.chainId, "contract=" + baseContract);

  // 2. Quote
  console.log("\n2. Quoting...");
  const paymentId = "pay_chat_" + Date.now();
  const amount = offer.maxAmountRequired;
  const ctxData = {
    payee: ext.payeeAddress,
    resource: offer.resource || CHAT + "/chat",
    method: "POST",
    invoiceId: ext.invoiceId,
    paymentId,
    amount,
    asset: offer.asset
  };
  const contextHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(JSON.stringify(ctxData, Object.keys(ctxData).sort()))
  );
  const quoteRes = await req("POST", HUB + "/v1/tickets/quote", {
    invoiceId: ext.invoiceId,
    paymentId,
    channelId: CHANNEL_ID,
    payee: ext.payeeAddress,
    asset: offer.asset,
    amount,
    maxFee: "5000000000000",
    quoteExpiry: Math.floor(Date.now() / 1000) + 120,
    contextHash
  });
  if (quoteRes.status !== 200) {
    console.log("   Quote failed:", JSON.stringify(quoteRes.body));
    return;
  }
  const totalDebit = BigInt(quoteRes.body.totalDebit);
  console.log("   Fee:", quoteRes.body.fee, "Total debit:", totalDebit.toString());

  // 3. Sign state update
  console.log("\n3. Signing state (nonce " + PREV_NONCE + " -> " + (PREV_NONCE + 1) + ")...");
  const prevA = BigInt(PREV_BAL_A);
  const prevB = BigInt(PREV_BAL_B);
  const channelState = {
    channelId: CHANNEL_ID,
    stateNonce: PREV_NONCE + 1,
    balA: (prevA - totalDebit).toString(),
    balB: (prevB + totalDebit).toString(),
    locksRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    stateExpiry: Math.floor(Date.now() / 1000) + 120,
    contextHash
  };
  const stateHash = hashChannelState(channelState);
  const sigA = await signChannelState(channelState, agentWallet);
  console.log("   balA:", channelState.balA, "balB:", channelState.balB);

  // 4. Issue ticket
  console.log("\n4. Issuing ticket...");
  const issueRes = await req("POST", HUB + "/v1/tickets/issue", {
    quote: quoteRes.body,
    channelState,
    sigA
  });
  if (issueRes.status !== 200) {
    console.log("   Issue failed:", JSON.stringify(issueRes.body));
    return;
  }
  const ticket = { ...issueRes.body };
  delete ticket.channelAck;
  delete ticket.hubChannelAck;
  console.log("   Ticket:", ticket.ticketId);

  // 5. Send paid message
  const msg = process.argv[2] || "gm from SCP agent on Base!";
  console.log("\n5. Sending: \"" + msg + "\"");
  const paymentPayload = {
    scheme: "statechannel-hub-v1",
    paymentId,
    invoiceId: ext.invoiceId,
    ticket,
    channelProof: {
      channelId: CHANNEL_ID,
      stateNonce: channelState.stateNonce,
      stateHash,
      sigA
    }
  };
  const chatRes = await req("POST", CHAT + "/chat",
    { message: msg },
    { "Payment-Signature": JSON.stringify(paymentPayload) }
  );
  console.log("   Status:", chatRes.status);
  console.log("   Response:", JSON.stringify(chatRes.body, null, 2));

  // 6. Read back
  console.log("\n6. Reading chat...");
  const readRes = await req("GET", CHAT + "/chat");
  console.log("   " + readRes.body.messages.length + " message(s)");
  const last = readRes.body.messages[readRes.body.messages.length - 1];
  if (last) console.log("   Latest:", last.from.slice(0, 10) + "...:", last.message);
}

run().catch(e => console.error("Failed:", e.message));
