/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { ethers } = require("ethers");
const { resolveNetwork, resolveAsset, resolveHubEndpointForNetwork } = require("../node/scp-common/networks");

const ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT, ".env");
const C2_CONTRACT_ADDRESS = "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b";

const PRESET_NETWORKS = [
  {
    key: "sepolia",
    label: "Sepolia",
    chainId: 11155111,
    rpcUrl: "https://rpc.sepolia.org"
  },
  {
    key: "base-sepolia",
    label: "Base Sepolia",
    chainId: 84532,
    rpcUrl: "https://sepolia.base.org"
  },
  {
    key: "base",
    label: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org"
  },
  {
    key: "mainnet",
    label: "Ethereum Mainnet",
    chainId: 1,
    rpcUrl: "https://eth.llamarpc.com"
  }
];

const CHAIN_TO_PRESET = new Map(PRESET_NETWORKS.map((n) => [n.chainId, n]));
const KNOWN_ASSET_SYMBOLS = ["eth", "usdc", "usdt"];
const CAP_ASSET_SYMBOLS = ["ETH", "USDC"];
const DEFAULT_MAX_AMOUNT = "1000000000000";
const DEFAULT_MAX_FEE = "500000000";
const DEFAULT_MAX_AMOUNT_ETH = "100000000000000";
const DEFAULT_MAX_FEE_ETH = "500000000";
const DEFAULT_MAX_AMOUNT_USDC = "500000";
const DEFAULT_MAX_FEE_USDC = "50000";

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  return out;
}

function ensurePrivateKey(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(value || "");
}

function ensureAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(value || "");
}

function ensurePositiveNumberString(value) {
  return /^[0-9]+$/.test(value || "");
}

function ensurePositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isTrue(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "y";
}

function printSupportedNetworks() {
  console.log("Supported preset networks (with default RPCs):");
  for (const n of PRESET_NETWORKS) {
    console.log(`  - ${n.key} (eip155:${n.chainId}) -> ${n.rpcUrl}`);
  }
  console.log("You can still enter custom CAIP2 networks (for example eip155:10,eip155:137).");
  console.log("");
}

function printSupportedNetworkDetails() {
  console.log("Preset network details:");
  for (const n of PRESET_NETWORKS) {
    const assets = [];
    for (const sym of KNOWN_ASSET_SYMBOLS) {
      try {
        const a = resolveAsset(n.chainId, sym);
        assets.push(`${a.symbol}:${a.address}`);
      } catch (_e) {
        // token not mapped for this preset network
      }
    }
    console.log(`  - ${n.key} (eip155:${n.chainId})`);
    console.log(`    rpc: ${n.rpcUrl}`);
    if (assets.length) console.log(`    mapped assets: ${assets.join(", ")}`);
    else console.log("    mapped assets: none (use custom token address)");
  }
  console.log("");
}

function toPosixRelative(absPath) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join("/");
  if (!rel || rel === ".") return "./";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function normalizeNetworkToken(token) {
  const raw = String(token || "").trim().toLowerCase();
  if (!raw) throw new Error("network value cannot be empty");

  if (raw.startsWith("eip155:")) {
    const chainId = Number(raw.split(":")[1]);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new Error(`invalid CAIP2 network: ${token}`);
    }
    const preset = CHAIN_TO_PRESET.get(chainId);
    return {
      chainId,
      caip2: `eip155:${chainId}`,
      envValue: preset ? preset.key : `eip155:${chainId}`,
      label: preset ? preset.label : `Chain ${chainId}`
    };
  }

  if (/^\d+$/.test(raw)) {
    const chainId = Number(raw);
    if (!Number.isFinite(chainId) || chainId <= 0) {
      throw new Error(`invalid chain id: ${token}`);
    }
    const preset = CHAIN_TO_PRESET.get(chainId);
    return {
      chainId,
      caip2: `eip155:${chainId}`,
      envValue: preset ? preset.key : `eip155:${chainId}`,
      label: preset ? preset.label : `Chain ${chainId}`
    };
  }

  const net = resolveNetwork(raw);
  const preset = CHAIN_TO_PRESET.get(net.chainId);
  return {
    chainId: net.chainId,
    caip2: `eip155:${net.chainId}`,
    envValue: preset ? preset.key : raw,
    label: preset ? preset.label : raw
  };
}

function parseNetworkList(input, fallback) {
  const raw = String(input || "").trim();
  if (!raw) return fallback;
  const tokens = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (!tokens.length) return fallback;
  const parsed = tokens.map(normalizeNetworkToken);
  return dedupeBy(parsed, (n) => n.caip2);
}

function defaultNetworkFromExisting(existing) {
  try {
    const n = normalizeNetworkToken(existing.NETWORK || "sepolia");
    return n;
  } catch (_e) {
    return normalizeNetworkToken("sepolia");
  }
}

function defaultNetworksFromExisting(existing, primary) {
  try {
    return parseNetworkList(existing.NETWORKS || existing.NETWORK || primary.envValue, [primary]);
  } catch (_e) {
    return [primary];
  }
}

function defaultAssetSymbolFor(chainId, address) {
  if (!address || !ensureAddress(address)) return null;
  for (const sym of KNOWN_ASSET_SYMBOLS) {
    try {
      const a = resolveAsset(chainId, sym);
      if (a.address.toLowerCase() === address.toLowerCase()) return sym;
    } catch (_e) {
      // unsupported symbol on this network
    }
  }
  return null;
}

async function ask(rl, label, defaultValue) {
  const suffix = defaultValue !== undefined && defaultValue !== null && defaultValue !== ""
    ? ` [${defaultValue}]`
    : "";
  return new Promise((resolve) => {
    rl.question(`${label}${suffix}: `, (answer) => {
      const trimmed = String(answer || "").trim();
      if (trimmed) return resolve(trimmed);
      return resolve(defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : "");
    });
  });
}

async function askYesNo(rl, label, defaultYes) {
  const defaultHint = defaultYes ? "Y/n" : "y/N";
  while (true) {
    const answer = (await ask(rl, `${label} (${defaultHint})`, "")).toLowerCase();
    if (!answer) return defaultYes;
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    console.log("Please answer y or n.");
  }
}

async function askWithValidator(rl, label, defaultValue, validator, errorMessage) {
  while (true) {
    const value = await ask(rl, label, defaultValue);
    if (validator(value)) return value;
    console.log(errorMessage);
  }
}

async function askChoice(rl, label, options, defaultValue) {
  const map = new Map(options.map((opt) => [opt.value, opt]));
  const hint = options.map((opt) => `${opt.value}=${opt.label}`).join(", ");
  while (true) {
    const value = (await ask(rl, `${label} (${hint})`, defaultValue)).toLowerCase();
    if (map.has(value)) return value;
    console.log(`Choose one of: ${options.map((o) => o.value).join(", ")}`);
  }
}

function presetIndexForNetwork(network) {
  const idx = PRESET_NETWORKS.findIndex((n) => n.chainId === network.chainId);
  return idx >= 0 ? idx + 1 : null;
}

function defaultPresetSelection(defaults) {
  const indexes = defaults
    .map(presetIndexForNetwork)
    .filter((x) => Number.isInteger(x));
  if (!indexes.length) return "1";
  return dedupeBy(indexes, (x) => String(x)).join(",");
}

async function askPresetNetworks(rl, label, defaults) {
  console.log(`${label}: preset networks`);
  PRESET_NETWORKS.forEach((n, i) => {
    console.log(`  ${i + 1}. ${n.key} (eip155:${n.chainId})`);
  });
  const raw = await ask(
    rl,
    "Select one or more preset networks (comma numbers)",
    defaultPresetSelection(defaults)
  );
  const parts = String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("select at least one preset network");
  const out = [];
  for (const p of parts) {
    const idx = Number(p);
    if (!Number.isInteger(idx) || idx < 1 || idx > PRESET_NETWORKS.length) {
      throw new Error(`invalid preset index: ${p}`);
    }
    const n = PRESET_NETWORKS[idx - 1];
    out.push(normalizeNetworkToken(n.key));
  }
  return dedupeBy(out, (n) => n.caip2);
}

async function askNetworks(rl, label, defaults) {
  while (true) {
    try {
      const mode = await askChoice(
        rl,
        `${label} input mode`,
        [
          { value: "preset", label: "choose from preset list" },
          { value: "custom", label: "enter names/CAIP2 manually" },
          { value: "more", label: "show more preset details" }
        ],
        "preset"
      );

      if (mode === "more") {
        printSupportedNetworkDetails();
        continue;
      }

      if (mode === "preset") {
        const parsed = await askPresetNetworks(rl, label, defaults);
        if (!parsed.length) throw new Error("select at least one network");
        return parsed;
      }

      const defaultRaw = defaults.map((n) => n.envValue).join(",");
      const input = await ask(
        rl,
        `${label} (comma names or CAIP2, e.g. sepolia,base or eip155:11155111)`,
        defaultRaw
      );
      const parsed = parseNetworkList(input, defaults);
      if (!parsed.length) throw new Error("select at least one network");
      return parsed;
    } catch (err) {
      console.log(`Invalid networks: ${err.message}`);
    }
  }
}

async function askPrivateKey(rl, label, defaultValue) {
  return askWithValidator(
    rl,
    label,
    defaultValue || "",
    ensurePrivateKey,
    "Use a valid 0x-prefixed 32-byte private key."
  );
}

function parseTokenInput(raw) {
  const parts = String(raw || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return dedupeBy(parts, (x) => x.toLowerCase());
}

async function resolvePayeeTokensForNetworks(rl, networks, existingDefaultAsset) {
  const primary = networks[0];
  const defaultToken = defaultAssetSymbolFor(primary.chainId, existingDefaultAsset) || "usdc";

  while (true) {
    const raw = await ask(
      rl,
      "Payee tokens (comma symbols eth/usdc/usdt or token addresses)",
      defaultToken
    );
    const tokens = parseTokenInput(raw);
    if (!tokens.length) {
      console.log("Choose at least one token.");
      continue;
    }

    const out = [];
    let ok = true;

    for (const token of tokens) {
      if (ensureAddress(token)) {
        const symbol = await askWithValidator(
          rl,
          `Symbol for custom token ${token}`,
          "TOKEN",
          (v) => /^[A-Za-z0-9]{2,12}$/.test(v || ""),
          "Use 2-12 alphanumeric characters."
        );
        const decimals = await askWithValidator(
          rl,
          `Decimals for custom token ${token}`,
          "18",
          (v) => {
            const n = Number(v);
            return Number.isInteger(n) && n >= 0 && n <= 255;
          },
          "Use an integer between 0 and 255."
        );
        out.push({
          type: "custom",
          symbol: symbol.toUpperCase(),
          symbolLower: symbol.toLowerCase(),
          address: token,
          decimals: Number(decimals)
        });
        continue;
      }

      const sym = token.toLowerCase();
      if (!KNOWN_ASSET_SYMBOLS.includes(sym)) {
        console.log(`Unknown token "${token}". Use eth/usdc/usdt or token addresses.`);
        ok = false;
        break;
      }

      for (const net of networks) {
        try {
          resolveAsset(net.chainId, sym);
        } catch (_e) {
          console.log(`Token ${sym.toUpperCase()} is not supported by default on ${net.envValue}. Use a custom token address for this network.`);
          ok = false;
          break;
        }
      }
      if (!ok) break;

      const assetOnPrimary = resolveAsset(primary.chainId, sym);
      out.push({
        type: "symbol",
        symbol: assetOnPrimary.symbol,
        symbolLower: sym,
        address: assetOnPrimary.address,
        decimals: assetOnPrimary.decimals
      });
    }

    if (!ok) continue;
    return dedupeBy(out, (t) => `${t.symbolLower}:${t.address.toLowerCase()}`);
  }
}

async function askTokenPrices(rl, tokenEntries, existingPriceRaw) {
  const out = [];
  for (const t of tokenEntries) {
    const defaultHumanBySymbol = {
      eth: "0.00001",
      usdc: "0.005",
      usdt: "0.005"
    };
    let defaultHuman = defaultHumanBySymbol[t.symbolLower] || "0.005";
    if (existingPriceRaw && ensurePositiveNumberString(existingPriceRaw)) {
      try {
        defaultHuman = ethers.utils.formatUnits(existingPriceRaw, t.decimals);
      } catch (_e) {
        // keep fallback
      }
    }

    while (true) {
      const human = await ask(rl, `API Price for ${t.symbol} (human units)`, defaultHuman);
      try {
        const raw = ethers.utils.parseUnits(String(human), t.decimals).toString();
        out.push({ ...t, priceHuman: String(human), priceRaw: raw });
        break;
      } catch (_e) {
        console.log(`Invalid amount for ${t.symbol}.`);
      }
    }
  }
  return out;
}

function resolveAgentAssetAllowlist(input, networks) {
  const raw = String(input || "").trim();
  if (!raw || raw.toLowerCase() === "all") {
    return { value: "", summary: "all" };
  }

  const tokens = parseTokenInput(raw);
  const out = [];

  for (const token of tokens) {
    if (ensureAddress(token)) {
      out.push(token);
      continue;
    }

    const sym = token.toLowerCase();
    if (!KNOWN_ASSET_SYMBOLS.includes(sym)) {
      throw new Error(`unknown token "${token}"`);
    }

    let foundForAny = false;
    for (const n of networks) {
      try {
        const a = resolveAsset(n.chainId, sym);
        out.push(a.address);
        foundForAny = true;
      } catch (_e) {
        // token unavailable on this network, continue
      }
    }
    if (!foundForAny) {
      throw new Error(`token ${sym.toUpperCase()} not available on selected networks`);
    }
  }

  const deduped = dedupeBy(out, (x) => x.toLowerCase());
  return { value: deduped.join(","), summary: deduped.join(",") };
}

function makePayeeOffersConfig(payee) {
  const modeList = [];
  if (payee.acceptHub) modeList.push("hub");
  if (payee.acceptDirect) modeList.push("direct");
  if (!modeList.length) modeList.push("direct");
  let hubBaseUrl = null;
  if (payee.hubUrl) {
    try {
      const u = new URL(payee.hubUrl);
      hubBaseUrl = `${u.protocol}//${u.host}`;
    } catch (_e) {
      hubBaseUrl = null;
    }
  }

  const offers = payee.networks.map((network) => {
    const row = {
      network: network.envValue,
      mode: modeList.join(","),
      assets: payee.tokens.map((t) => {
        if (t.type === "symbol") return t.symbolLower;
        return {
          symbol: t.symbol,
          address: t.address,
          decimals: t.decimals
        };
      }),
      prices: payee.tokens.map((t) => t.priceHuman)
    };

    if (payee.acceptHub) {
      row.hubName = payee.hubName;
      row.hubEndpoint = hubBaseUrl
        ? resolveHubEndpointForNetwork(network.envValue, { baseUrl: hubBaseUrl })
        : resolveHubEndpointForNetwork(network.envValue);
    }

    return row;
  });

  const pathPrices = {
    "/v1/data": {}
  };
  for (const t of payee.tokens) {
    pathPrices["/v1/data"][t.symbol] = t.priceHuman;
  }

  return { offers, pathPrices };
}

function pushKey(lines, key, value) {
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    lines.push(`${key}=${value}`);
  } else {
    lines.push(`# ${key}=`);
  }
}

function formatEnv(finalEnv, existing) {
  const lines = [];
  lines.push("# x402s generated by startup wizard");
  lines.push(`# Generated at ${new Date().toISOString()}`);
  lines.push("");

  lines.push("# Role keys (set only for roles you run)");
  pushKey(lines, "AGENT_PRIVATE_KEY", finalEnv.AGENT_PRIVATE_KEY);
  pushKey(lines, "PAYEE_PRIVATE_KEY", finalEnv.PAYEE_PRIVATE_KEY);
  pushKey(lines, "HUB_PRIVATE_KEY", finalEnv.HUB_PRIVATE_KEY);
  lines.push("");

  lines.push("# Chain / contract");
  pushKey(lines, "NETWORK", finalEnv.NETWORK);
  pushKey(lines, "NETWORKS", finalEnv.NETWORKS);
  pushKey(lines, "RPC_URL", finalEnv.RPC_URL);
  pushKey(lines, "CONTRACT_ADDRESS", finalEnv.CONTRACT_ADDRESS);
  pushKey(lines, "DEFAULT_ASSET", finalEnv.DEFAULT_ASSET);
  lines.push("");

  lines.push("# Agent settings");
  pushKey(lines, "AGENT_DEFAULT_ROUTE", finalEnv.AGENT_DEFAULT_ROUTE);
  pushKey(lines, "AGENT_APPROVAL_MODE", finalEnv.AGENT_APPROVAL_MODE);
  pushKey(lines, "AGENT_START_PAYEE", finalEnv.AGENT_START_PAYEE);
  pushKey(lines, "ASSET_ALLOWLIST", finalEnv.ASSET_ALLOWLIST);
  pushKey(lines, "MAX_AMOUNT", finalEnv.MAX_AMOUNT);
  pushKey(lines, "MAX_FEE", finalEnv.MAX_FEE);
  pushKey(lines, "MAX_AMOUNT_ETH", finalEnv.MAX_AMOUNT_ETH);
  pushKey(lines, "MAX_FEE_ETH", finalEnv.MAX_FEE_ETH);
  pushKey(lines, "MAX_AMOUNT_USDC", finalEnv.MAX_AMOUNT_USDC);
  pushKey(lines, "MAX_FEE_USDC", finalEnv.MAX_FEE_USDC);
  pushKey(lines, "MAX_AMOUNT_USDT", finalEnv.MAX_AMOUNT_USDT);
  pushKey(lines, "MAX_FEE_USDT", finalEnv.MAX_FEE_USDT);
  pushKey(lines, "AGENT_STATE_DIR", finalEnv.AGENT_STATE_DIR || "./node/scp-agent/state");
  lines.push("");

  lines.push("# Payee / hub endpoint settings");
  pushKey(lines, "HUB_NAME", finalEnv.HUB_NAME);
  pushKey(lines, "HUB_URL", finalEnv.HUB_URL);
  pushKey(lines, "HUB_ENDPOINT", finalEnv.HUB_ENDPOINT || finalEnv.HUB_URL);
  pushKey(lines, "PRICE", finalEnv.PRICE);
  pushKey(lines, "OFFERS_FILE", finalEnv.OFFERS_FILE || "./offers.local.json");
  lines.push("");

  lines.push("# Hub storage / scaling");
  pushKey(lines, "STORE_PATH", finalEnv.STORE_PATH || "./node/scp-hub/data/store.json");
  pushKey(lines, "REDIS_URL", finalEnv.REDIS_URL);
  pushKey(lines, "HUB_WORKERS", finalEnv.HUB_WORKERS || "0");
  pushKey(lines, "ALLOW_UNSAFE_CLUSTER", finalEnv.ALLOW_UNSAFE_CLUSTER);
  lines.push("");

  lines.push("# Optional hardening");
  pushKey(lines, "HUB_ADMIN_TOKEN", finalEnv.HUB_ADMIN_TOKEN);
  pushKey(lines, "PAYEE_AUTH_MAX_SKEW_SEC", finalEnv.PAYEE_AUTH_MAX_SKEW_SEC || "300");
  lines.push("");

  const known = new Set([
    "AGENT_PRIVATE_KEY",
    "PAYEE_PRIVATE_KEY",
    "HUB_PRIVATE_KEY",
    "NETWORK",
    "NETWORKS",
    "RPC_URL",
    "CONTRACT_ADDRESS",
    "DEFAULT_ASSET",
    "AGENT_DEFAULT_ROUTE",
    "AGENT_APPROVAL_MODE",
    "AGENT_START_PAYEE",
    "ASSET_ALLOWLIST",
    "MAX_AMOUNT",
    "MAX_FEE",
    "MAX_AMOUNT_ETH",
    "MAX_FEE_ETH",
    "MAX_AMOUNT_USDC",
    "MAX_FEE_USDC",
    "MAX_AMOUNT_USDT",
    "MAX_FEE_USDT",
    "AGENT_STATE_DIR",
    "HUB_NAME",
    "HUB_URL",
    "HUB_ENDPOINT",
    "PRICE",
    "OFFERS_FILE",
    "STORE_PATH",
    "REDIS_URL",
    "HUB_WORKERS",
    "ALLOW_UNSAFE_CLUSTER",
    "HUB_ADMIN_TOKEN",
    "PAYEE_AUTH_MAX_SKEW_SEC"
  ]);

  const extras = Object.entries(existing)
    .filter(([k]) => !known.has(k))
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (extras.length) {
    lines.push("# Preserved existing keys");
    for (const [k, v] of extras) lines.push(`${k}=${v}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function run() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Startup wizard requires an interactive terminal.");
    process.exit(1);
  }

  const existing = parseEnvFile(ENV_PATH);
  const hasExisting = fs.existsSync(ENV_PATH);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\nx402s Startup Wizard");
  console.log("Role-based setup for agent/payee/hub config files.\n");

  if (hasExisting) {
    const overwrite = await askYesNo(rl, ".env already exists. Overwrite it", false);
    if (!overwrite) {
      console.log("Keeping existing .env. No changes made.");
      rl.close();
      return;
    }
  }

  let enableAgent = await askYesNo(rl, "Configure AGENT (payer)", true);
  let enablePayee = await askYesNo(rl, "Configure PAYEE (API)", false);
  const enableHub = await askYesNo(rl, "Configure HUB operator", false);

  if (!enableAgent && !enablePayee && !enableHub) {
    console.log("No role selected; enabling AGENT by default.");
    enableAgent = true;
  }

  const primaryNetwork = defaultNetworkFromExisting(existing);

  const finalEnv = { ...existing };
  let selectedPrimaryNetwork = null;

  let sharedHubName = existing.HUB_NAME || "pay.eth";
  let sharedHubUrl = existing.HUB_URL || resolveHubEndpointForNetwork(primaryNetwork.envValue);

  if (enableAgent) {
    const agentKey = await askPrivateKey(rl, "AGENT_PRIVATE_KEY", existing.AGENT_PRIVATE_KEY);
    finalEnv.AGENT_PRIVATE_KEY = agentKey;

    const route = await askChoice(
      rl,
      "Agent payment route",
      [
        { value: "hub", label: "hub-routed" },
        { value: "direct", label: "direct" },
        { value: "auto", label: "auto" }
      ],
      String(existing.AGENT_DEFAULT_ROUTE || "hub").toLowerCase()
    );
    finalEnv.AGENT_DEFAULT_ROUTE = route;

    const approvalMode = await askChoice(
      rl,
      "Agent approval mode",
      [
        { value: "auto", label: "auto approve all payments" },
        { value: "per_payment", label: "approve each payment" },
        { value: "per_api", label: "approve each API once, then auto" }
      ],
      String(existing.AGENT_APPROVAL_MODE || "auto").toLowerCase()
    );
    finalEnv.AGENT_APPROVAL_MODE = approvalMode;

    const startLocalPayee = await askYesNo(
      rl,
      "When running `npm run scp:agent`, start local payee for agent-to-agent `/pay`",
      isTrue(existing.AGENT_START_PAYEE)
    );
    if (startLocalPayee) finalEnv.AGENT_START_PAYEE = "1";
    else delete finalEnv.AGENT_START_PAYEE;

    console.log("Choose agent networks for payments (including agent-to-agent /pay targets).");
    const agentNetworks = await askNetworks(
      rl,
      "Agent networks",
      defaultNetworksFromExisting(existing, primaryNetwork)
    );
    selectedPrimaryNetwork = selectedPrimaryNetwork || agentNetworks[0];
    finalEnv.NETWORKS = agentNetworks.map((n) => n.caip2).join(",");
    finalEnv.NETWORK = agentNetworks[0].envValue;

    while (true) {
      try {
        const assetInput = await ask(
          rl,
          "Agent tokens (all | comma symbols eth/usdc/usdt | token addresses)",
          existing.ASSET_ALLOWLIST ? existing.ASSET_ALLOWLIST : "all"
        );
        const allow = resolveAgentAssetAllowlist(assetInput, agentNetworks);
        if (allow.value) {
          finalEnv.ASSET_ALLOWLIST = allow.value;
        } else {
          delete finalEnv.ASSET_ALLOWLIST;
        }
        break;
      } catch (err) {
        console.log(`Invalid token selection: ${err.message}`);
      }
    }

    const suggestedMaxAmount = existing.MAX_AMOUNT || DEFAULT_MAX_AMOUNT;
    const suggestedMaxFee = existing.MAX_FEE || DEFAULT_MAX_FEE;
    const suggestedEthAmount = existing.MAX_AMOUNT_ETH || DEFAULT_MAX_AMOUNT_ETH;
    const suggestedEthFee = existing.MAX_FEE_ETH || DEFAULT_MAX_FEE_ETH;
    const suggestedUsdcAmount = existing.MAX_AMOUNT_USDC || DEFAULT_MAX_AMOUNT_USDC;
    const suggestedUsdcFee = existing.MAX_FEE_USDC || DEFAULT_MAX_FEE_USDC;
    const useDefaultCaps = await askYesNo(rl, "Use recommended payment caps", true);
    if (useDefaultCaps) {
      finalEnv.MAX_AMOUNT = suggestedMaxAmount;
      finalEnv.MAX_FEE = suggestedMaxFee;
      finalEnv.MAX_AMOUNT_ETH = suggestedEthAmount;
      finalEnv.MAX_FEE_ETH = suggestedEthFee;
      finalEnv.MAX_AMOUNT_USDC = suggestedUsdcAmount;
      finalEnv.MAX_FEE_USDC = suggestedUsdcFee;
      console.log("Using recommended global caps (MAX_AMOUNT/MAX_FEE).");
      console.log(`MAX_AMOUNT=${finalEnv.MAX_AMOUNT}`);
      console.log(`MAX_FEE=${finalEnv.MAX_FEE}`);
      console.log("Using recommended ETH/USDC per-asset caps:");
      console.log(`MAX_AMOUNT_ETH=${finalEnv.MAX_AMOUNT_ETH}`);
      console.log(`MAX_FEE_ETH=${finalEnv.MAX_FEE_ETH}`);
      console.log(`MAX_AMOUNT_USDC=${finalEnv.MAX_AMOUNT_USDC}`);
      console.log(`MAX_FEE_USDC=${finalEnv.MAX_FEE_USDC}`);
      console.log("You can still customize ETH/USDC caps next.");
    } else {
      console.log("Custom caps (smallest units; integer values only).");
      console.log("Applies to whichever asset the offer uses (ETH=wei, USDC=6 decimals).");
      finalEnv.MAX_AMOUNT = await askWithValidator(
        rl,
        "MAX_AMOUNT",
        "",
        ensurePositiveNumberString,
        "Use a non-negative integer string."
      );
      finalEnv.MAX_FEE = await askWithValidator(
        rl,
        "MAX_FEE",
        "",
        ensurePositiveNumberString,
        "Use a non-negative integer string."
      );
    }

    const existingPerAssetCaps =
      ensurePositiveNumberString(existing.MAX_AMOUNT_ETH) ||
      ensurePositiveNumberString(existing.MAX_FEE_ETH) ||
      ensurePositiveNumberString(existing.MAX_AMOUNT_USDC) ||
      ensurePositiveNumberString(existing.MAX_FEE_USDC);
    const usePerAssetCaps = await askYesNo(rl, "Set different caps per asset (ETH/USDC)", useDefaultCaps || existingPerAssetCaps);
    if (usePerAssetCaps) {
      console.log("Per-asset caps override MAX_AMOUNT/MAX_FEE when ETH or USDC is used.");
      for (const symbol of CAP_ASSET_SYMBOLS) {
        const amountKey = `MAX_AMOUNT_${symbol}`;
        const feeKey = `MAX_FEE_${symbol}`;
        const hasExisting = ensurePositiveNumberString(existing[amountKey]) || ensurePositiveNumberString(existing[feeKey]);
        const setAssetCaps = await askYesNo(rl, `Set ${symbol} specific caps`, Boolean(hasExisting));
        if (!setAssetCaps) {
          delete finalEnv[amountKey];
          delete finalEnv[feeKey];
          continue;
        }
        finalEnv[amountKey] = await askWithValidator(
          rl,
          amountKey,
          finalEnv[amountKey] || existing[amountKey] || "",
          ensurePositiveNumberString,
          "Use a non-negative integer string."
        );
        finalEnv[feeKey] = await askWithValidator(
          rl,
          feeKey,
          finalEnv[feeKey] || existing[feeKey] || "",
          ensurePositiveNumberString,
          "Use a non-negative integer string."
        );
      }
    } else {
      for (const symbol of CAP_ASSET_SYMBOLS) {
        delete finalEnv[`MAX_AMOUNT_${symbol}`];
        delete finalEnv[`MAX_FEE_${symbol}`];
      }
    }

    if (route === "hub" || route === "auto") {
      sharedHubName = await ask(rl, "Agent HUB_NAME", sharedHubName);
      sharedHubUrl = await ask(rl, "Agent HUB_URL", sharedHubUrl);
      finalEnv.HUB_NAME = sharedHubName;
      finalEnv.HUB_URL = sharedHubUrl;
      finalEnv.HUB_ENDPOINT = sharedHubUrl;
    }
  }

  if (enablePayee) {
    const payeeKey = await askPrivateKey(rl, "PAYEE_PRIVATE_KEY", existing.PAYEE_PRIVATE_KEY);
    finalEnv.PAYEE_PRIVATE_KEY = payeeKey;

    const payeeNetworks = await askNetworks(
      rl,
      "Payee networks",
      defaultNetworksFromExisting(existing, primaryNetwork)
    );
    selectedPrimaryNetwork = selectedPrimaryNetwork || payeeNetworks[0];

    const acceptHub = await askYesNo(rl, "Payee accepts hub-routed payments", true);
    let acceptDirect = await askYesNo(rl, "Payee accepts direct payments", true);
    if (!acceptHub && !acceptDirect) {
      console.log("At least one payee mode is required. Enabling direct mode.");
      acceptDirect = true;
    }

    let payeeHubName = sharedHubName;
    let payeeHubUrl = sharedHubUrl;
    if (acceptHub) {
      payeeHubName = await ask(rl, "Payee HUB_NAME", payeeHubName);
      payeeHubUrl = await ask(rl, "Payee HUB_URL", payeeHubUrl);
      sharedHubName = payeeHubName;
      sharedHubUrl = payeeHubUrl;
      finalEnv.HUB_NAME = payeeHubName;
      finalEnv.HUB_URL = payeeHubUrl;
      finalEnv.HUB_ENDPOINT = payeeHubUrl;
    }

    const payeeTokens = await resolvePayeeTokensForNetworks(rl, payeeNetworks, existing.DEFAULT_ASSET);
    const pricedTokens = await askTokenPrices(rl, payeeTokens, existing.PRICE);

    const primaryToken = pricedTokens[0];
    finalEnv.DEFAULT_ASSET = primaryToken.address;
    finalEnv.PRICE = primaryToken.priceRaw;
    finalEnv.NETWORK = payeeNetworks[0].envValue;

    const offersDefaultRel = existing.OFFERS_FILE || "./offers.local.json";
    const offersInput = await ask(rl, "OFFERS_FILE", offersDefaultRel);
    const offersAbs = path.isAbsolute(offersInput) ? offersInput : path.resolve(ROOT, offersInput);
    const offersRel = toPosixRelative(offersAbs);
    finalEnv.OFFERS_FILE = offersRel;

    const createOffers = await askYesNo(rl, `Create/update offers config at ${offersRel}`, true);
    if (createOffers) {
      const offersCfg = makePayeeOffersConfig({
        networks: payeeNetworks,
        acceptHub,
        acceptDirect,
        hubName: payeeHubName,
        hubUrl: payeeHubUrl,
        tokens: pricedTokens
      });
      fs.mkdirSync(path.dirname(offersAbs), { recursive: true });
      fs.writeFileSync(offersAbs, `${JSON.stringify(offersCfg, null, 2)}\n`, "utf8");
      console.log(`Wrote ${offersRel}`);
    }
  }

  if (enableHub) {
    finalEnv.HUB_PRIVATE_KEY = await askPrivateKey(rl, "HUB_PRIVATE_KEY", existing.HUB_PRIVATE_KEY);
    finalEnv.HUB_NAME = await ask(rl, "Hub name", finalEnv.HUB_NAME || sharedHubName);
    finalEnv.HUB_URL = await ask(rl, "Hub URL", finalEnv.HUB_URL || sharedHubUrl);
    finalEnv.HUB_ENDPOINT = finalEnv.HUB_URL;
    finalEnv.NETWORK = finalEnv.NETWORK || primaryNetwork.envValue;
  }

  const inferredPrimary = selectedPrimaryNetwork || primaryNetwork;
  const inferredPreset = CHAIN_TO_PRESET.get(inferredPrimary.chainId);
  const inferredRpc = existing.RPC_URL || (inferredPreset ? inferredPreset.rpcUrl : "");
  const useCustomRpc = await askYesNo(rl, "Set custom RPC_URL", false);
  if (useCustomRpc || !inferredRpc) {
    finalEnv.RPC_URL = await ask(rl, "RPC_URL", inferredRpc);
  } else {
    finalEnv.RPC_URL = inferredRpc;
  }

  const defaultContract = existing.CONTRACT_ADDRESS || C2_CONTRACT_ADDRESS;
  const useCustomContract = await askYesNo(rl, "Set custom CONTRACT_ADDRESS", false);
  if (useCustomContract) {
    finalEnv.CONTRACT_ADDRESS = await askWithValidator(
      rl,
      "CONTRACT_ADDRESS",
      defaultContract,
      ensureAddress,
      "Use a valid 0x-prefixed 20-byte address."
    );
  } else {
    finalEnv.CONTRACT_ADDRESS = defaultContract;
  }

  finalEnv.NETWORK = finalEnv.NETWORK || inferredPrimary.envValue;
  finalEnv.AGENT_STATE_DIR = finalEnv.AGENT_STATE_DIR || "./node/scp-agent/state";
  finalEnv.STORE_PATH = finalEnv.STORE_PATH || "./node/scp-hub/data/store.json";
  finalEnv.HUB_WORKERS = finalEnv.HUB_WORKERS || "0";
  finalEnv.PAYEE_AUTH_MAX_SKEW_SEC = finalEnv.PAYEE_AUTH_MAX_SKEW_SEC || "300";

  fs.writeFileSync(ENV_PATH, formatEnv(finalEnv, existing), "utf8");
  console.log("Wrote .env");

  console.log("\nNext steps:");
  if (enableAgent) console.log("  npm run scp:agent:pay -- <url> <hub|direct>");
  if (enablePayee) console.log("  npm run scp:payee");
  if (enableHub) console.log("  npm run scp:hub");

  rl.close();
}

run().catch((err) => {
  console.error(`Wizard failed: ${err.message}`);
  process.exit(1);
});
