const { ethers } = require("ethers");

const NETWORKS = {
  mainnet:      { chainId: 1,        rpc: "https://eth.llamarpc.com",   name: "Ethereum" },
  ethereum:     { chainId: 1,        rpc: "https://eth.llamarpc.com",   name: "Ethereum" },
  eth:          { chainId: 1,        rpc: "https://eth.llamarpc.com",   name: "Ethereum" },
  base:         { chainId: 8453,     rpc: "https://mainnet.base.org",   name: "Base" },
  sepolia:      { chainId: 11155111, rpc: "https://rpc.sepolia.org",    name: "Sepolia" },
  "base-sepolia": { chainId: 84532, rpc: "https://sepolia.base.org",   name: "Base Sepolia" }
};

const ASSETS = {
  // Ethereum mainnet
  "1:usdc":  { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
  "1:usdt":  { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" },
  "1:eth":   { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" },
  // Base
  "8453:usdc":  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
  "8453:usdt":  { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, symbol: "USDT" },
  "8453:eth":   { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" },
  // Sepolia
  "11155111:usdc": { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", decimals: 6, symbol: "USDC" },
  "11155111:eth":  { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" },
  // Base Sepolia
  "84532:usdc": { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, symbol: "USDC" },
  "84532:eth":  { address: ethers.constants.AddressZero, decimals: 18, symbol: "ETH" }
};

// Deterministic CREATE2 deployment (same salt/factory/bytecode).
const C2_CANONICAL_CONTRACT = "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b";

// Explicitly listed chains (same address as canonical).
const CONTRACTS = {
  8453: C2_CANONICAL_CONTRACT,      // Base
  11155111: C2_CANONICAL_CONTRACT   // Sepolia
};

function resolveNetwork(name) {
  const key = (name || "").toLowerCase().replace(/\s+/g, "-");
  const net = NETWORKS[key];
  if (!net) {
    const names = [...new Set(Object.values(NETWORKS).map(n => n.name.toLowerCase()))];
    throw new Error(`Unknown network: ${name}. Known: ${names.join(", ")}`);
  }
  return net;
}

function normalizeChainId(networkOrChainId) {
  if (networkOrChainId === null || networkOrChainId === undefined) return null;
  const raw = String(networkOrChainId).trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith("eip155:")) {
    const n = Number(raw.split(":")[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  try {
    return resolveNetwork(raw).chainId;
  } catch (_e) {
    return null;
  }
}

function toCaip2(networkOrChainId) {
  const chainId = normalizeChainId(networkOrChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  return `eip155:${chainId}`;
}

function hubPathForChainId(chainId) {
  if (chainId === 1) return "/hub/eth";
  if (chainId === 8453) return "/hub/base";
  if (chainId === 11155111) return "/hub/sepolia";
  if (chainId === 84532) return "/hub/base-sepolia";
  return "/hub/sepolia";
}

function resolveHubEndpointForNetwork(networkOrChainId, options = {}) {
  const chainId = normalizeChainId(networkOrChainId);
  const baseUrl = String(
    options.baseUrl ||
    process.env.HUB_BASE_URL ||
    process.env.PUBLIC_HUB_BASE_URL ||
    "https://159.223.150.70"
  ).replace(/\/+$/, "");
  return `${baseUrl}${hubPathForChainId(chainId)}`;
}

function resolveAsset(chainId, symbol) {
  const key = `${chainId}:${(symbol || "eth").toLowerCase()}`;
  const asset = ASSETS[key];
  if (!asset) {
    const available = Object.keys(ASSETS)
      .filter(k => k.startsWith(`${chainId}:`))
      .map(k => k.split(":")[1]);
    throw new Error(`Unknown asset: ${symbol} on chain ${chainId}. Available: ${available.join(", ")}`);
  }
  return asset;
}

function resolveContract(chainId) {
  return CONTRACTS[chainId] || process.env.CONTRACT_ADDRESS || C2_CANONICAL_CONTRACT;
}

function parseAmount(humanAmount, decimals) {
  return ethers.utils.parseUnits(String(humanAmount), decimals).toString();
}

function formatAmount(rawAmount, decimals) {
  return ethers.utils.formatUnits(String(rawAmount), decimals);
}

module.exports = {
  NETWORKS, ASSETS, CONTRACTS,
  resolveNetwork, resolveAsset, resolveContract,
  normalizeChainId, toCaip2, resolveHubEndpointForNetwork,
  parseAmount, formatAmount
};
