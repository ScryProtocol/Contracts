/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { HttpJsonClient } = require("../scp-common/http-client");

function cfg() {
  return {
    role: process.env.ROLE || "agent",
    rpcUrl: process.env.RPC_URL || "",
    contractAddress: process.env.CONTRACT_ADDRESS || "",
    channelId: process.env.CHANNEL_ID || "",
    pollMs: Number(process.env.POLL_MS || 5000),
    safetyBufferSec: Number(process.env.SAFETY_BUFFER_SEC || 2),
    hubStorePath:
      process.env.HUB_STORE_PATH || path.resolve(__dirname, "../scp-hub/data/store.json"),
    agentStatePath:
      process.env.AGENT_STATE_PATH || path.resolve(__dirname, "../scp-agent/state/agent-state.json"),
    watcherKey: process.env.WATCHER_PRIVATE_KEY || "",
    hubUrl: process.env.HUB_URL || ""
  };
}

const ABI = [
  "function getChannel(bytes32 channelId) view returns ((address participantA,address participantB,address asset,uint64 challengePeriodSec,uint64 channelExpiry,uint256 totalBalance,bool isClosing,uint64 closeDeadline,uint64 latestNonce) params)",
  "function getChannelsByParticipant(address participant) view returns (bytes32[])",
  "function challenge((bytes32 channelId,uint64 stateNonce,uint256 balA,uint256 balB,bytes32 locksRoot,uint64 stateExpiry,bytes32 contextHash) newer, bytes sigFromCounterparty) external"
];

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_e) {
    return {};
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function readLocalProofForChannel(channelId, role) {
  const c = cfg();
  if (role === "hub") {
    const store = loadJson(c.hubStorePath);
    const ch = (store.channels || {})[channelId];
    if (!ch || !ch.latestState || !ch.sigA) return null;
    return { state: ch.latestState, counterpartySig: ch.sigA };
  }

  const state = loadJson(c.agentStatePath);
  const watch = ((state.watch || {}).byChannelId || {})[channelId];
  if (!watch || !watch.state || !watch.sigB) return null;
  return { state: watch.state, counterpartySig: watch.sigB };
}

// Track on-chain state per channel to detect transitions
const channelStates = new Map(); // channelId → { isClosing, nonce, deadline }

async function notifyHub(hubUrl, event, data) {
  if (!hubUrl) return;
  try {
    const http = new HttpJsonClient({ timeoutMs: 3000 });
    const adminToken = process.env.HUB_ADMIN_TOKEN || "";
    const headers = adminToken
      ? { authorization: `Bearer ${adminToken}` }
      : {};
    await http.request("POST", `${hubUrl}/v1/events/emit`, { event, data }, headers);
    http.close();
  } catch (_e) { /* hub unreachable — non-fatal */ }
}

async function tickChannel(contract, channelId, role, safetyBufferSec, hubUrl) {
  const local = readLocalProofForChannel(channelId, role);
  if (!local) return;

  const onchain = await contract.getChannel(channelId);
  if (!onchain.participantA || onchain.participantA === ethers.constants.AddressZero) return;

  const prev = channelStates.get(channelId) || { isClosing: false, nonce: 0, finalized: false };
  const onchainNonce = Number(onchain.latestNonce);
  const closeDeadline = Number(onchain.closeDeadline);
  const ts = now();

  // Detect state transitions
  if (onchain.isClosing && !prev.isClosing) {
    console.log(`[watch:${role}] ${channelId.slice(0, 10)}... close started, deadline ${closeDeadline}`);
    notifyHub(hubUrl, "channel.close_started", { channelId, closeDeadline, onchainNonce });
  }
  if (onchain.isClosing && onchainNonce > prev.nonce && prev.isClosing) {
    console.log(`[watch:${role}] ${channelId.slice(0, 10)}... challenged, nonce ${prev.nonce} → ${onchainNonce}`);
    notifyHub(hubUrl, "channel.challenged", { channelId, previousNonce: prev.nonce, newNonce: onchainNonce });
  }
  if (onchain.isClosing && ts >= closeDeadline && !prev.finalized) {
    console.log(`[watch:${role}] ${channelId.slice(0, 10)}... closed (deadline passed)`);
    notifyHub(hubUrl, "channel.closed", { channelId, finalNonce: onchainNonce });
    channelStates.set(channelId, { isClosing: true, nonce: onchainNonce, finalized: true });
    return;
  }

  channelStates.set(channelId, { isClosing: onchain.isClosing, nonce: onchainNonce, finalized: false });

  if (!onchain.isClosing) return;

  const localNonce = Number(local.state.stateNonce);
  if (ts + safetyBufferSec >= closeDeadline) {
    console.log(`[watch:${role}] ${channelId.slice(0, 10)}... too close/past deadline`);
    return;
  }
  if (localNonce <= onchainNonce) return;

  console.log(`[watch:${role}] ${channelId.slice(0, 10)}... challenging: local ${localNonce} > onchain ${onchainNonce}`);
  const tx = await contract.challenge(local.state, local.counterpartySig);
  const rc = await tx.wait(1);
  console.log(`[watch:${role}] challenge mined: ${rc.transactionHash}`);
  notifyHub(hubUrl, "channel.challenged", { channelId, previousNonce: onchainNonce, newNonce: localNonce, txHash: rc.transactionHash });
}

async function tick(contract, channelIds, role, safetyBufferSec, hubUrl) {
  for (const id of channelIds) {
    await tickChannel(contract, id, role, safetyBufferSec, hubUrl).catch((err) => {
      console.error(`[watch:${role}] ${id.slice(0, 10)}... error:`, err.message || err);
    });
  }
}

async function discoverChannels(contract, address) {
  try {
    return await contract.getChannelsByParticipant(address);
  } catch (_e) {
    return [];
  }
}

async function main() {
  const c = cfg();
  if (!c.rpcUrl || !c.contractAddress || !c.watcherKey) {
    throw new Error("missing env vars: RPC_URL, CONTRACT_ADDRESS, WATCHER_PRIVATE_KEY");
  }
  if (c.role !== "agent" && c.role !== "hub") {
    throw new Error("ROLE must be agent or hub");
  }

  const provider = new ethers.providers.JsonRpcProvider(c.rpcUrl);
  const signer = new ethers.Wallet(c.watcherKey, provider);
  const contract = new ethers.Contract(c.contractAddress, ABI, signer);

  let channelIds;
  if (c.channelId) {
    channelIds = [c.channelId];
    console.log(`[watch:${c.role}] watching channel ${c.channelId} as ${signer.address}`);
  } else {
    channelIds = await discoverChannels(contract, signer.address);
    console.log(`[watch:${c.role}] discovered ${channelIds.length} channels for ${signer.address}`);
    if (channelIds.length === 0) {
      console.log(`[watch:${c.role}] no channels found, will re-discover each poll`);
    }
  }

  const runTick = async () => {
    if (!c.channelId) {
      channelIds = await discoverChannels(contract, signer.address);
    }
    await tick(contract, channelIds, c.role, c.safetyBufferSec, c.hubUrl);
  };

  if (c.hubUrl) console.log(`[watch:${c.role}] hub notifications → ${c.hubUrl}`);
  await runTick();
  setInterval(() => {
    runTick().catch((err) => {
      console.error(`[watch:${c.role}] tick error:`, err.message || err);
    });
  }, c.pollMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { readLocalProofForChannel, discoverChannels };
