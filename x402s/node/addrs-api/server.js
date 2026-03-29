/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const admin = require("firebase-admin");
const { ethers } = require("ethers");

function loadDotEnv(envPath) {
  try {
    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (_err) {
    // Optional env file.
  }
}

loadDotEnv(path.resolve(process.cwd(), ".env"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3002);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://api.addrs.to";
const ZONE_NAME = String(process.env.ZONE_NAME || "hey.eth").trim().toLowerCase();
const ROOT_HANDLE = String(process.env.ROOT_HANDLE || "").trim().toLowerCase();
const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL || "https://handles-b3952.firebaseio.com";
const FIREBASE_SERVICE_ACCOUNT_JSON =
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON || path.resolve(process.cwd(), "handles_api.json");
const PAY_HUB_SEPOLIA_URL =
  process.env.PAY_HUB_SEPOLIA_URL || "https://pogchamp.tv/hub/sepolia/.well-known/x402";
const ENS_RPC_URL = process.env.ENS_RPC_URL || "https://ethereum.publicnode.com";
const GATEWAY_SIGNER_PRIVATE_KEY = process.env.GATEWAY_SIGNER_PRIVATE_KEY || "";
const CACHE_TTL_MS = Math.max(5_000, Number(process.env.CACHE_TTL_MS || 30_000));
const HUB_CACHE_TTL_MS = Math.max(5_000, Number(process.env.HUB_CACHE_TTL_MS || 30_000));
const ZONE_CACHE_TTL_MS = Math.max(5_000, Number(process.env.ZONE_CACHE_TTL_MS || 60_000));
const CCIP_TTL_SEC = Math.max(30, Number(process.env.CCIP_TTL_SEC || 300));
const ENABLE_PUBLIC_CLAIMS = process.env.ENABLE_PUBLIC_CLAIMS !== "0";
const REQUIRE_CLAIM_SIGNATURE = process.env.REQUIRE_CLAIM_SIGNATURE !== "0";
const CLAIM_CHAIN_ID = Math.max(1, Number(process.env.CLAIM_CHAIN_ID || 1));
const CLAIM_CHALLENGE_TTL_MS = Math.max(
  60_000,
  Number(process.env.CLAIM_CHALLENGE_TTL_MS || 10 * 60_000)
);

const ZONE_SUFFIX = `.${ZONE_NAME}`;
const ZERO_ADDRESS = ethers.constants.AddressZero;
const DEFAULT_EVM_COINS = ["ETH", "BAL"];
const ENS_REGISTRY_ADDRESS = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const ENS_REGISTRY_ABI = [
  "function owner(bytes32 node) view returns (address)",
  "function resolver(bytes32 node) view returns (address)"
];
const RESOLVER_ABI = [
  "function supportsInterface(bytes4 interfaceID) view returns (bool)",
  "function addr(bytes32 node) view returns (address)"
];
const OUTER_RESOLVE_IFACE = new ethers.utils.Interface([
  "function resolve(bytes name, bytes data) view returns (bytes)"
]);
const RECORD_IFACE = new ethers.utils.Interface([
  "function addr(bytes32 node) view returns (address)",
  "function addr(bytes32 node, uint256 coinType) view returns (bytes)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)"
]);

const cache = {
  handles: { ts: 0, value: null },
  claims: { ts: 0, value: null },
  coins: { ts: 0, value: null },
  hub: { ts: 0, value: null },
  zone: { ts: 0, value: null }
};
const claimChallenges = new Map();

function readServiceAccount() {
  const raw = fs.readFileSync(FIREBASE_SERVICE_ACCOUNT_JSON, "utf8");
  return JSON.parse(raw);
}

function initFirebase() {
  if (admin.apps.length) return admin.app();
  return admin.initializeApp({
    credential: admin.credential.cert(readServiceAccount()),
    databaseURL: FIREBASE_DATABASE_URL
  });
}

initFirebase();
const database = admin.database();
const app = express();
app.use(express.json({ limit: "256kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  return next();
});

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

function isFresh(entry, ttlMs) {
  return entry.value !== null && Date.now() - entry.ts < ttlMs;
}

async function loadCachedMap(key, refPath, ttlMs = CACHE_TTL_MS) {
  const entry = cache[key];
  if (isFresh(entry, ttlMs)) return entry.value;
  const snap = await database.ref(refPath).once("value");
  entry.value = snap.val() || {};
  entry.ts = Date.now();
  return entry.value;
}

function invalidateHandleCaches() {
  cache.handles.ts = 0;
  cache.claims.ts = 0;
  cache.coins.ts = 0;
}

async function getHandlesMap() {
  return loadCachedMap("handles", "/handles");
}

async function getClaimsMap() {
  return loadCachedMap("claims", "/claims");
}

async function getCoinsMap() {
  return loadCachedMap("coins", "/coins");
}

function normalizeHandleInput(input) {
  const raw = String(input || "").trim().toLowerCase().replace(/^@/, "");
  if (!raw) return "";
  if (raw.endsWith(ZONE_SUFFIX)) return raw.slice(0, -ZONE_SUFFIX.length);
  if (raw === ZONE_NAME) return ROOT_HANDLE || "";
  return raw;
}

function isEnsLabel(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function normalizeCoinKey(input) {
  return String(input || "").trim().toUpperCase();
}

function normalizeMaybeAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return ethers.utils.getAddress(raw);
  } catch (_err) {
    return "";
  }
}

function normalizeMaybeHexBytes(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^0x[0-9a-fA-F]*$/.test(raw) || raw.length % 2 !== 0) return "";
  return raw.toLowerCase();
}

function parseIsoDate(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : 0;
}

function pruneClaimChallenges(now = Date.now()) {
  for (const [key, value] of claimChallenges.entries()) {
    if (!value || !value.expiresAtMs || value.expiresAtMs <= now) {
      claimChallenges.delete(key);
    }
  }
}

function getClaimChallengeKey(handle, owner, nonce) {
  return `${handle}:${String(owner || "").toLowerCase()}:${nonce}`;
}

function inferOwner(marker, addresses, claimMeta) {
  const metaOwner = normalizeMaybeAddress(claimMeta && claimMeta.owner);
  if (metaOwner) return metaOwner;
  const markerOwner = normalizeMaybeAddress(marker);
  if (markerOwner) return markerOwner;
  for (const coin of DEFAULT_EVM_COINS) {
    const addr = normalizeMaybeAddress(addresses[coin]);
    if (addr) return addr;
  }
  return "";
}

async function getAddressesForHandle(handle) {
  const coins = await getCoinsMap();
  const out = {};
  for (const [coin, values] of Object.entries(coins)) {
    if (values && Object.prototype.hasOwnProperty.call(values, handle)) {
      out[normalizeCoinKey(coin)] = values[handle];
    }
  }
  return out;
}

async function getAllKnownHandles() {
  const [handles, claims, coins] = await Promise.all([getHandlesMap(), getClaimsMap(), getCoinsMap()]);
  const out = new Set();
  for (const key of Object.keys(handles || {})) out.add(key);
  for (const key of Object.keys(claims || {})) out.add(key);
  for (const values of Object.values(coins || {})) {
    if (!values || typeof values !== "object") continue;
    for (const key of Object.keys(values)) out.add(key);
  }
  return [...out].filter((value) => isEnsLabel(value));
}

async function resolveNodeToEnsName(node) {
  const normalizedNode = String(node || "").toLowerCase();
  if (!normalizedNode) return null;
  const zoneNode = ethers.utils.namehash(ZONE_NAME).toLowerCase();
  if (normalizedNode === zoneNode) {
    return {
      name: ZONE_NAME,
      handle: ROOT_HANDLE || "",
      isRoot: true
    };
  }

  const handles = await getAllKnownHandles();
  for (const handle of handles) {
    const name = `${handle}.${ZONE_NAME}`;
    if (ethers.utils.namehash(name).toLowerCase() === normalizedNode) {
      return {
        name,
        handle,
        isRoot: false
      };
    }
  }
  return null;
}

async function getHandleProfile(handle) {
  const [handles, claims] = await Promise.all([getHandlesMap(), getClaimsMap()]);
  const addresses = await getAddressesForHandle(handle);
  const marker = handles[handle];
  const claimMeta = claims[handle] || null;
  const owner = inferOwner(marker, addresses, claimMeta);
  return {
    handle,
    ens: `${handle}.${ZONE_NAME}`,
    claimed: marker != null || Object.keys(addresses).length > 0,
    available: marker == null && Object.keys(addresses).length === 0,
    marker: marker == null ? null : marker,
    owner: owner || null,
    addresses,
    claim: claimMeta
  };
}

function normalizeRecordsPayload(body, owner) {
  const src = {
    ...(body && typeof body.records === "object" ? body.records : {}),
    ...(body && typeof body.addresses === "object" ? body.addresses : {})
  };
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(src)) {
    const key = normalizeCoinKey(rawKey);
    const value = String(rawValue || "").trim();
    if (!key || !value) continue;
    if (DEFAULT_EVM_COINS.includes(key) || key === "ETH") {
      const addr = normalizeMaybeAddress(value);
      if (!addr) {
        throw new Error(`records.${key} must be a valid EVM address`);
      }
      out[key] = addr;
      continue;
    }
    out[key] = value;
  }
  if (owner) {
    for (const coin of DEFAULT_EVM_COINS) {
      if (!out[coin]) out[coin] = owner;
    }
  }
  return out;
}

function dnsDecodeName(value) {
  const hex = typeof value === "string" ? value : ethers.utils.hexlify(value);
  const bytes = ethers.utils.arrayify(hex);
  const labels = [];
  let index = 0;
  while (index < bytes.length) {
    const len = bytes[index];
    index += 1;
    if (len === 0) break;
    const slice = bytes.slice(index, index + len);
    labels.push(ethers.utils.toUtf8String(slice));
    index += len;
  }
  return labels.join(".").toLowerCase();
}

function extractHandleFromEnsName(name) {
  const lower = String(name || "").trim().toLowerCase().replace(/\.$/, "");
  if (lower === ZONE_NAME) return ROOT_HANDLE || "";
  if (!lower.endsWith(ZONE_SUFFIX)) return "";
  const label = lower.slice(0, -ZONE_SUFFIX.length);
  if (!label || label.includes(".")) return "";
  return label;
}

function coinTypeToKey(coinType) {
  const normalized = String(coinType);
  if (normalized === "60") return "ETH";
  if (normalized === "0") return "BTC";
  if (normalized === "145") return "BCH";
  if (normalized === "2") return "LTC";
  if (normalized === "3") return "DOGE";
  if (normalized === "714") return "BNB";
  return "";
}

function encodeGatewayResponse(resultBytes, validUntil, requestData, sender) {
  const wallet = new ethers.Wallet(GATEWAY_SIGNER_PRIVATE_KEY);
  const messageHash = ethers.utils.solidityKeccak256(
    ["bytes", "address", "uint64", "bytes32", "bytes32"],
    [
      "0x1900",
      sender,
      validUntil,
      ethers.utils.keccak256(requestData),
      ethers.utils.keccak256(resultBytes)
    ]
  );
  const sig = wallet._signingKey().signDigest(messageHash);
  const compactSignature = ethers.utils.hexConcat([sig.r, sig._vs]);
  return ethers.utils.defaultAbiCoder.encode(
    ["bytes", "uint64", "bytes"],
    [resultBytes, validUntil, compactSignature]
  );
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(7_500)
  });
  if (!response.ok) {
    throw new Error(`upstream ${response.status}`);
  }
  return response.json();
}

async function getSepoliaHubInfo() {
  if (isFresh(cache.hub, HUB_CACHE_TTL_MS)) return cache.hub.value;
  try {
    const payload = await fetchJson(PAY_HUB_SEPOLIA_URL);
    cache.hub.value = {
      ok: true,
      checkedAt: new Date().toISOString(),
      url: PAY_HUB_SEPOLIA_URL,
      chainId: payload.chainId || null,
      hubName: payload.hubName || null,
      address: payload.address || payload.hubAddress || null,
      raw: payload
    };
  } catch (err) {
    cache.hub.value = {
      ok: false,
      checkedAt: new Date().toISOString(),
      url: PAY_HUB_SEPOLIA_URL,
      error: err.message
    };
  }
  cache.hub.ts = Date.now();
  return cache.hub.value;
}

async function getZoneStatus() {
  if (isFresh(cache.zone, ZONE_CACHE_TTL_MS)) return cache.zone.value;
  const provider = new ethers.providers.JsonRpcProvider(ENS_RPC_URL);
  const registry = new ethers.Contract(ENS_REGISTRY_ADDRESS, ENS_REGISTRY_ABI, provider);
  const node = ethers.utils.namehash(ZONE_NAME);
  const status = {
    zone: ZONE_NAME,
    checkedAt: new Date().toISOString(),
    rpcUrl: ENS_RPC_URL,
    node
  };
  try {
    const [owner, resolver] = await Promise.all([
      registry.owner(node),
      registry.resolver(node)
    ]);
    status.owner = owner;
    status.resolver = resolver;
    status.resolverSupportsExtended = false;
    status.addr = null;

    if (resolver && resolver !== ZERO_ADDRESS) {
      const resolverContract = new ethers.Contract(resolver, RESOLVER_ABI, provider);
      try {
        status.resolverSupportsExtended = await resolverContract.supportsInterface("0x9061b923");
      } catch (_err) {
        status.resolverSupportsExtended = false;
      }
      try {
        status.addr = await resolverContract.addr(node);
      } catch (_err) {
        status.addr = null;
      }
    }

    status.ccipReady = !!status.resolverSupportsExtended;
    if (!status.ccipReady) {
      status.note =
        "The API can serve CCIP responses, but hey.eth must be pointed at an offchain-capable resolver on mainnet before ENS clients will use it.";
    }
  } catch (err) {
    status.error = err.message;
    status.ccipReady = false;
  }
  cache.zone.value = status;
  cache.zone.ts = Date.now();
  return status;
}

function getEffectivePrefix(req) {
  const prefix = String(req.get("x-forwarded-prefix") || "").trim();
  if (!prefix) return "";
  return prefix.startsWith("/")
    ? prefix.replace(/\/$/, "")
    : `/${prefix.replace(/\/$/, "")}`;
}

function getEffectiveBaseUrl(req) {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").trim();
  const host = String(req.get("x-forwarded-host") || req.get("host") || "").trim();
  const prefix = getEffectivePrefix(req);

  if (host) {
    return `${proto}://${host}${prefix}`;
  }

  return PUBLIC_BASE_URL;
}

function buildClaimUri(req) {
  return `${getEffectiveBaseUrl(req)}/claim`;
}

function buildClaimChallengeMessage({ domain, owner, handle, uri, nonce, issuedAt, expiresAt }) {
  return `${domain} wants you to sign in with your Ethereum account:
${owner}

Authorize ${handle}.${ZONE_NAME}

URI: ${uri}
Version: 1
Chain ID: ${CLAIM_CHAIN_ID}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expiresAt}
Resources:
- zone:${ZONE_NAME}
- handle:${handle}
- action:claim`;
}

function createClaimChallenge(req, handle, owner) {
  pruneClaimChallenges();
  const baseUrl = getEffectiveBaseUrl(req);
  let domain;
  try {
    domain = new URL(baseUrl).host;
  } catch (_err) {
    domain = String(req.get("x-forwarded-host") || req.get("host") || "statechannel.org").trim();
  }
  const nonce = crypto.randomBytes(12).toString("hex");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_CHALLENGE_TTL_MS).toISOString();
  const uri = buildClaimUri(req);
  const message = buildClaimChallengeMessage({
    domain,
    owner,
    handle,
    uri,
    nonce,
    issuedAt,
    expiresAt
  });
  const challenge = {
    handle,
    owner,
    domain,
    uri,
    nonce,
    issuedAt,
    issuedAtMs: parseIsoDate(issuedAt),
    expiresAt,
    expiresAtMs: parseIsoDate(expiresAt),
    message
  };
  claimChallenges.set(getClaimChallengeKey(handle, owner, nonce), challenge);
  return challenge;
}

function getClaimRequestValue(req, key) {
  if (req.method === "GET") return req.query ? req.query[key] : undefined;
  return req.body ? req.body[key] : undefined;
}

async function sendClaimChallenge(req, res) {
  if (!ENABLE_PUBLIC_CLAIMS) {
    return sendError(res, 403, "public claims are disabled");
  }
  const handle = normalizeHandleInput(getClaimRequestValue(req, "handle"));
  const owner = normalizeMaybeAddress(
    getClaimRequestValue(req, "owner") ||
      getClaimRequestValue(req, "address") ||
      getClaimRequestValue(req, "evmAddress")
  );
  if (!isEnsLabel(handle)) {
    return sendError(res, 400, "handle must be a valid ENS label", { handle });
  }
  if (!owner) {
    return sendError(res, 400, "owner must be a valid EVM address");
  }
  const challenge = createClaimChallenge(req, handle, owner);
  return res.json({
    ok: true,
    zone: ZONE_NAME,
    handle,
    ens: `${handle}.${ZONE_NAME}`,
    owner,
    signatureRequired: REQUIRE_CLAIM_SIGNATURE,
    challenge: {
      domain: challenge.domain,
      uri: challenge.uri,
      version: "1",
      chainId: CLAIM_CHAIN_ID,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      message: challenge.message
    }
  });
}

function getClaimSignature(body) {
  return String(
    (body && (body.signature || body.sig || (body.auth && body.auth.signature))) || ""
  ).trim();
}

function getClaimNonce(body) {
  return String((body && (body.nonce || (body.auth && body.auth.nonce))) || "").trim();
}

function verifyClaimAuth(req, handle, owner, body) {
  if (!REQUIRE_CLAIM_SIGNATURE) {
    return {
      ok: true,
      auth: {
        type: "unsigned",
        verifiedAt: new Date().toISOString()
      }
    };
  }

  const nonce = getClaimNonce(body);
  const signature = getClaimSignature(body);
  if (!nonce || !signature) {
    return {
      ok: false,
      status: 401,
      message: "claim signature required",
      extra: {
        authUrl: `${getEffectiveBaseUrl(req)}/auth/challenge`,
        required: ["nonce", "signature"]
      }
    };
  }

  pruneClaimChallenges();
  const challengeKey = getClaimChallengeKey(handle, owner, nonce);
  const challenge = claimChallenges.get(challengeKey);
  if (!challenge || challenge.expiresAtMs <= Date.now()) {
    claimChallenges.delete(challengeKey);
    return {
      ok: false,
      status: 401,
      message: "claim challenge missing or expired",
      extra: {
        authUrl: `${getEffectiveBaseUrl(req)}/auth/challenge`,
        handle,
        owner
      }
    };
  }

  let recovered = "";
  try {
    recovered = normalizeMaybeAddress(ethers.utils.verifyMessage(challenge.message, signature));
  } catch (_err) {
    return {
      ok: false,
      status: 401,
      message: "invalid claim signature"
    };
  }
  if (!recovered || recovered.toLowerCase() !== owner.toLowerCase()) {
    return {
      ok: false,
      status: 401,
      message: "claim signature does not match owner",
      extra: {
        handle,
        owner
      }
    };
  }

  claimChallenges.delete(challengeKey);
  return {
    ok: true,
    auth: {
      type: "eip191",
      nonce: challenge.nonce,
      domain: challenge.domain,
      uri: challenge.uri,
      chainId: CLAIM_CHAIN_ID,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      verifiedAt: new Date().toISOString(),
      signer: recovered
    }
  };
}

async function sendApiDocs(req, res) {
  const [payHub, zone] = await Promise.all([getSepoliaHubInfo(), getZoneStatus()]);
  const publicBaseUrl = getEffectiveBaseUrl(req);
  const publicPrefix = getEffectivePrefix(req);
  const prefersHeyethPaths = publicPrefix === "/heyeth";
  const healthPath = prefersHeyethPaths ? "/health" : "/health";
  const docsPath = prefersHeyethPaths ? "/docs" : "/docs";
  const payPath = prefersHeyethPaths ? "/pay/sepolia" : "/pay/sepolia";
  const statusPath = prefersHeyethPaths ? "/status" : "/admin/status";
  const handlePath = prefersHeyethPaths ? "/handle/:handle" : "/check/:handle";
  const handleExample = prefersHeyethPaths ? "/handle/agent007" : "/check/agent007";
  const infoPath = "/info/:handle";
  const infoExample = "/info/agent007";
  const coinPath = "/info/:handle/:coin";
  const coinExample = "/info/agent007/ETH";
  const authChallengePath = "/auth/challenge";
  const claimPath = "/claim";
  const ccipPath = "/ccip";
  return res.json({
    ok: true,
    service: "addrs-api",
    summary:
      "API-first handle claim and CCIP gateway for *.hey.eth, backed by addrs.to data and the public pay.eth Sepolia hub.",
    publicBaseUrl,
    zone: ZONE_NAME,
    publicClaims: ENABLE_PUBLIC_CLAIMS,
    claimSignatureRequired: REQUIRE_CLAIM_SIGNATURE,
    ccipConfigured: !!GATEWAY_SIGNER_PRIVATE_KEY,
    endpoints: {
      health: { method: "GET", url: `${publicBaseUrl}${healthPath}` },
      docs: { method: "GET", url: `${publicBaseUrl}${docsPath}` },
      paySepolia: { method: "GET", url: `${publicBaseUrl}${payPath}` },
      adminStatus: { method: "GET", url: `${publicBaseUrl}${statusPath}` },
      authChallenge: {
        method: "POST",
        url: `${publicBaseUrl}${authChallengePath}`,
        body: {
          handle: "agent007",
          owner: "0x1234567890123456789012345678901234567890"
        }
      },
      checkHandle: {
        method: "GET",
        url: `${publicBaseUrl}${handlePath}`,
        example: `${publicBaseUrl}${handleExample}`
      },
      checkHandleQuery: {
        method: "GET",
        url: `${publicBaseUrl}/handle?label=:handle`,
        example: `${publicBaseUrl}/handle?label=agent007`
      },
      handleInfo: {
        method: "GET",
        url: `${publicBaseUrl}${infoPath}`,
        example: `${publicBaseUrl}${infoExample}`
      },
      coinInfo: {
        method: "GET",
        url: `${publicBaseUrl}${coinPath}`,
        example: `${publicBaseUrl}${coinExample}`
      },
      updateHandle: {
        method: "PUT",
        url: `${publicBaseUrl}${handlePath}`,
        body: {
          owner: "0x1234567890123456789012345678901234567890",
          nonce: "from-/auth/challenge",
          signature: "0x...",
          addresses: {
            BTC: "bc1qexample..."
          }
        }
      },
      claim: {
        method: "POST",
        url: `${publicBaseUrl}${claimPath}`,
        body: {
          handle: "agent007",
          owner: "0x1234567890123456789012345678901234567890",
          nonce: "from-/auth/challenge",
          signature: "0x...",
          addresses: {
            ETH: "0x1234567890123456789012345678901234567890"
          }
        }
      },
      ccip: {
        method: "POST",
        url: `${publicBaseUrl}${ccipPath}`,
        body: {
          sender: "0xResolverAddress",
          data: "0x..."
        }
      }
    },
    notes: [
      "POST /auth/challenge returns a wallet-signing message. POST /claim requires the matching nonce and signature.",
      "POST /claim reserves a free ENS-safe label under hey.eth in the directory and writes ETH/BAL records by default.",
      "PUT /handle/:handle is the explicit later-edit route for a claimed handle. POST /claim still accepts same-owner updates for backward compatibility.",
      "POST /ccip serves signed CCIP-read responses for addr() and basic text() lookups.",
      zone.ccipReady
        ? "hey.eth is now pointed at an offchain-capable mainnet resolver, so ENS clients can use the CCIP gateway for supported records."
        : zone.note ||
          "Move hey.eth to an offchain-capable mainnet resolver to make standard ENS clients use the gateway."
    ],
    payHubSepolia: payHub,
    zoneStatus: zone
  });
}

app.get("/", async (req, res) => sendApiDocs(req, res));
app.get("/docs", async (req, res) => sendApiDocs(req, res));
app.get("/auth/challenge", async (req, res) => sendClaimChallenge(req, res));
app.post("/auth/challenge", async (req, res) => sendClaimChallenge(req, res));

app.get("/health", async (_req, res) => {
  const [payHub, zone] = await Promise.all([getSepoliaHubInfo(), getZoneStatus()]);
  return res.json({
    ok: true,
    service: "addrs-api",
    zone: ZONE_NAME,
    publicClaims: ENABLE_PUBLIC_CLAIMS,
    claimSignatureRequired: REQUIRE_CLAIM_SIGNATURE,
    ccipConfigured: !!GATEWAY_SIGNER_PRIVATE_KEY,
    payHubSepoliaOk: !!payHub.ok,
    ccipReadyOnchain: !!zone.ccipReady
  });
});

app.get("/pay/sepolia", async (_req, res) => {
  const payload = await getSepoliaHubInfo();
  return res.json(payload);
});

async function sendAdminStatus(req, res) {
  const [payHub, zone] = await Promise.all([getSepoliaHubInfo(), getZoneStatus()]);
  return res.json({
    service: "addrs-api",
    publicBaseUrl: getEffectiveBaseUrl(req),
    zone,
    payHubSepolia: payHub
  });
}

app.get("/admin", async (req, res) => sendAdminStatus(req, res));
app.get("/admin/status", async (req, res) => sendAdminStatus(req, res));

async function updateClaimedHandleRecords(res, handle, owner, profile, records, claimAuth) {
  const mergedAddresses = {
    ...(profile.addresses || {}),
    ...records
  };
  const claimMeta = {
    ...(profile.claim || {}),
    owner,
    auth: claimAuth.auth,
    source: "public-claim-update",
    zone: ZONE_NAME,
    updatedAt: new Date().toISOString()
  };
  const updates = {
    [`/claims/${handle}`]: claimMeta
  };
  for (const [coin, value] of Object.entries(mergedAddresses)) {
    updates[`/coins/${coin}/${handle}`] = value;
  }
  await database.ref().update(updates);
  invalidateHandleCaches();

  return res.status(200).json({
    ok: true,
    created: false,
    updated: true,
    handle,
    ens: profile.ens || `${handle}.${ZONE_NAME}`,
    owner,
    addresses: mergedAddresses,
    claim: claimMeta
  });
}

async function sendHandleCheck(res, handleInput) {
  const handle = normalizeHandleInput(handleInput);
  if (!isEnsLabel(handle)) {
    return sendError(res, 400, "handle must be a valid ENS label", { handle });
  }
  const [profile, payHub] = await Promise.all([
    getHandleProfile(handle),
    getSepoliaHubInfo()
  ]);
  return res.json({
    ...profile,
    payHubSepolia: payHub
  });
}

app.get("/handle", async (req, res) => {
  const handle = req.query && (req.query.handle || req.query.label || req.query.name);
  if (!handle) {
    return sendError(res, 400, "missing handle query param", {
      expected: ["handle", "label", "name"]
    });
  }
  return sendHandleCheck(res, handle);
});

app.get("/handle/:handle", async (req, res) => sendHandleCheck(res, req.params.handle));

app.put("/handle/:handle", async (req, res) => {
  const handle = normalizeHandleInput(req.params.handle);
  if (!isEnsLabel(handle)) {
    return sendError(res, 400, "handle must be a valid ENS label", { handle });
  }
  const owner = normalizeMaybeAddress(
    req.body && (req.body.owner || req.body.address || req.body.evmAddress)
  );
  if (!owner) {
    return sendError(res, 400, "owner must be a valid EVM address");
  }
  const claimAuth = verifyClaimAuth(req, handle, owner, req.body || {});
  if (!claimAuth.ok) {
    return sendError(res, claimAuth.status, claimAuth.message, claimAuth.extra);
  }

  let records;
  try {
    records = normalizeRecordsPayload(req.body || {}, owner);
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  const profile = await getHandleProfile(handle);
  if (!profile.claimed) {
    return sendError(res, 404, "handle not found", {
      handle,
      ens: `${handle}.${ZONE_NAME}`,
      available: true,
      hint: "use POST /claim to reserve a new handle"
    });
  }
  if (!profile.owner || profile.owner.toLowerCase() !== owner.toLowerCase()) {
    return sendError(res, 409, "handle is already claimed", {
      handle,
      ens: `${handle}.${ZONE_NAME}`,
      owner: profile.owner
    });
  }

  return updateClaimedHandleRecords(res, handle, owner, profile, records, claimAuth);
});

app.get("/check/:handle", async (req, res) => {
  return sendHandleCheck(res, req.params.handle);
});

app.get("/info/:handle", async (req, res) => {
  const handle = normalizeHandleInput(req.params.handle);
  if (!handle) return sendError(res, 400, "missing handle");
  const profile = await getHandleProfile(handle);
  if (!profile.claimed) {
    return sendError(res, 404, "handle not found", {
      handle,
      ens: `${handle}.${ZONE_NAME}`,
      available: true
    });
  }
  return res.json({
    handle,
    ens: profile.ens,
    owner: profile.owner,
    addresses: profile.addresses
  });
});

app.get("/info/:handle/:coin", async (req, res) => {
  const handle = normalizeHandleInput(req.params.handle);
  const coin = normalizeCoinKey(req.params.coin);
  if (!handle || !coin) return sendError(res, 400, "missing handle or coin");
  const profile = await getHandleProfile(handle);
  if (!profile.claimed) {
    return sendError(res, 404, "handle not found", { handle });
  }
  if (!profile.addresses[coin]) {
    return sendError(res, 404, `handle does not have an address for ${coin}`, {
      handle,
      coin
    });
  }
  return res.json({
    handle,
    ens: profile.ens,
    owner: profile.owner,
    coin,
    address: profile.addresses[coin]
  });
});

app.post("/claim", async (req, res) => {
  if (!ENABLE_PUBLIC_CLAIMS) {
    return sendError(res, 403, "public claims are disabled");
  }

  const handle = normalizeHandleInput(req.body && req.body.handle);
  const owner = normalizeMaybeAddress(
    req.body && (req.body.owner || req.body.address || req.body.evmAddress)
  );
  if (!isEnsLabel(handle)) {
    return sendError(res, 400, "handle must be a valid ENS label", { handle });
  }
  if (!owner) {
    return sendError(res, 400, "owner must be a valid EVM address");
  }
  const claimAuth = verifyClaimAuth(req, handle, owner, req.body || {});
  if (!claimAuth.ok) {
    return sendError(res, claimAuth.status, claimAuth.message, claimAuth.extra);
  }

  let records;
  try {
    records = normalizeRecordsPayload(req.body || {}, owner);
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  const handlesRef = database.ref(`/handles/${handle}`);
  const tx = await handlesRef.transaction((current) => {
    if (current === null) return owner;
    return undefined;
  });

  if (!tx.committed) {
    const profile = await getHandleProfile(handle);
    if (profile.owner && profile.owner.toLowerCase() === owner.toLowerCase()) {
      return updateClaimedHandleRecords(res, handle, owner, profile, records, claimAuth);
    }
    return sendError(res, 409, "handle is already claimed", {
      handle,
      ens: `${handle}.${ZONE_NAME}`,
      owner: profile.owner
    });
  }

  const claimId = crypto.randomBytes(10).toString("hex");
  const claimMeta = {
    owner,
    claimId,
    auth: claimAuth.auth,
    source: "public-claim",
    zone: ZONE_NAME,
    createdAt: new Date().toISOString()
  };
  const updates = {
    [`/claims/${handle}`]: claimMeta
  };
  for (const [coin, value] of Object.entries(records)) {
    updates[`/coins/${coin}/${handle}`] = value;
  }
  await database.ref().update(updates);
  invalidateHandleCaches();

  return res.status(201).json({
    ok: true,
    created: true,
    handle,
    ens: `${handle}.${ZONE_NAME}`,
    owner,
    addresses: records,
    claim: claimMeta
  });
});

app.post("/ccip", async (req, res) => {
  if (!GATEWAY_SIGNER_PRIVATE_KEY) {
    return sendError(res, 503, "CCIP gateway signer is not configured");
  }
  const { data, sender } = req.body || {};
  if (!data || !sender) {
    return sendError(res, 400, "missing data or sender");
  }

  const resolverSender = normalizeMaybeAddress(sender);
  if (!resolverSender) {
    return sendError(res, 400, "sender must be a valid resolver address");
  }

  let requestData;
  try {
    requestData = ethers.utils.hexlify(data);
  } catch (err) {
    return sendError(res, 400, "invalid CCIP request data", { detail: err.message });
  }

  const outerSelector = requestData.slice(0, 10).toLowerCase();
  const wrappedResolveSelector = OUTER_RESOLVE_IFACE.getSighash("resolve").toLowerCase();
  let name = "";
  let handle = "";
  let isRootRequest = false;
  let innerData = requestData;
  let selector = outerSelector;
  let expectedNode = "";

  if (outerSelector === wrappedResolveSelector) {
    let decoded;
    try {
      decoded = OUTER_RESOLVE_IFACE.decodeFunctionData("resolve", requestData);
    } catch (err) {
      return sendError(res, 400, "invalid CCIP request payload", { detail: err.message });
    }

    name = dnsDecodeName(decoded.name);
    handle = extractHandleFromEnsName(name);
    if (name === ZONE_NAME) {
      isRootRequest = true;
      handle = "";
    } else if (!handle) {
      return sendError(res, 404, "name is outside the configured zone", {
        name,
        zone: ZONE_NAME
      });
    }
    if (!isRootRequest && !isEnsLabel(handle)) {
      return sendError(res, 400, "unsupported ENS label", { handle, name });
    }
    innerData = decoded.data;
    selector = innerData.slice(0, 10).toLowerCase();
    expectedNode = ethers.utils.namehash(name);
  } else {
    let decodedNode;
    try {
      if (selector === RECORD_IFACE.getSighash("addr(bytes32)").toLowerCase()) {
        [decodedNode] = ethers.utils.defaultAbiCoder.decode(["bytes32"], `0x${requestData.slice(10)}`);
      } else if (selector === RECORD_IFACE.getSighash("addr(bytes32,uint256)").toLowerCase()) {
        [decodedNode] = ethers.utils.defaultAbiCoder.decode(
          ["bytes32", "uint256"],
          `0x${requestData.slice(10)}`
        );
      } else if (selector === RECORD_IFACE.getSighash("text(bytes32,string)").toLowerCase()) {
        [decodedNode] = ethers.utils.defaultAbiCoder.decode(
          ["bytes32", "string"],
          `0x${requestData.slice(10)}`
        );
      } else if (selector === RECORD_IFACE.getSighash("contenthash(bytes32)").toLowerCase()) {
        [decodedNode] = ethers.utils.defaultAbiCoder.decode(["bytes32"], `0x${requestData.slice(10)}`);
      } else {
        return sendError(res, 400, "unsupported resolver method", { selector });
      }
    } catch (err) {
      return sendError(res, 400, "invalid legacy resolver payload", { detail: err.message });
    }

    const resolved = await resolveNodeToEnsName(decodedNode);
    if (!resolved) {
      return sendError(res, 404, "node is outside the configured zone", {
        node: decodedNode,
        zone: ZONE_NAME
      });
    }
    name = resolved.name;
    handle = resolved.handle;
    isRootRequest = resolved.isRoot && !resolved.handle;
    expectedNode = decodedNode;
  }

  const profile = isRootRequest ? null : await getHandleProfile(handle);
  if (!isRootRequest && !profile.claimed) {
    return sendError(res, 404, "handle is not claimed", {
      handle,
      name,
      zone: ZONE_NAME
    });
  }
  const abi = ethers.utils.defaultAbiCoder;
  let resultBytes = "0x";

  if (selector === RECORD_IFACE.getSighash("addr(bytes32)").toLowerCase()) {
    const [node] = abi.decode(["bytes32"], `0x${innerData.slice(10)}`);
    if (String(node).toLowerCase() !== expectedNode.toLowerCase()) {
      return sendError(res, 400, "name does not match requested node", { name, handle });
    }
    const address =
      isRootRequest ? ZERO_ADDRESS : normalizeMaybeAddress(profile.addresses.ETH || profile.owner) || ZERO_ADDRESS;
    resultBytes = abi.encode(["address"], [address]);
  } else if (selector === RECORD_IFACE.getSighash("addr(bytes32,uint256)").toLowerCase()) {
    const [node, coinType] = abi.decode(["bytes32", "uint256"], `0x${innerData.slice(10)}`);
    if (String(node).toLowerCase() !== expectedNode.toLowerCase()) {
      return sendError(res, 400, "name does not match requested node", { name, handle });
    }
    const mappedCoin = coinTypeToKey(coinType.toString());
    if (mappedCoin === "ETH") {
      const address = isRootRequest
        ? ""
        : normalizeMaybeAddress(profile.addresses.ETH || profile.owner);
      resultBytes = address ? ethers.utils.hexlify(ethers.utils.arrayify(address)) : "0x";
    } else {
      resultBytes = "0x";
    }
  } else if (selector === RECORD_IFACE.getSighash("text(bytes32,string)").toLowerCase()) {
    const [node, key] = abi.decode(["bytes32", "string"], `0x${innerData.slice(10)}`);
    if (String(node).toLowerCase() !== expectedNode.toLowerCase()) {
      return sendError(res, 400, "name does not match requested node", { name, handle });
    }
    const textKey = String(key || "").trim().toLowerCase();
    let value = "";
    if (!isRootRequest) {
      if (textKey === "url") value = `${PUBLIC_BASE_URL}/info/${handle}`;
      else if (textKey === "description") value = `Agent handle ${handle}.${ZONE_NAME}`;
      else if (textKey === "com.addrs.handle") value = handle;
      else if (textKey === "com.addrs.owner") value = profile.owner || "";
      else if (textKey === "com.addrs.payhub.sepolia") value = PAY_HUB_SEPOLIA_URL;
    }
    resultBytes = abi.encode(["string"], [value]);
  } else if (selector === RECORD_IFACE.getSighash("contenthash(bytes32)").toLowerCase()) {
    const [node] = abi.decode(["bytes32"], `0x${innerData.slice(10)}`);
    if (String(node).toLowerCase() !== expectedNode.toLowerCase()) {
      return sendError(res, 400, "name does not match requested node", { name, handle });
    }
    const contenthash = isRootRequest
      ? "0x"
      : normalizeMaybeHexBytes(
          profile.addresses.CONTENTHASH || profile.addresses.CONTENT_HASH || profile.addresses.IPFS
        ) || "0x";
    resultBytes = abi.encode(["bytes"], [contenthash]);
  } else {
    return sendError(res, 400, "unsupported resolver method", { selector, name, handle });
  }

  const validUntil = Math.floor(Date.now() / 1000) + CCIP_TTL_SEC;
  const payload = encodeGatewayResponse(resultBytes, validUntil, requestData, resolverSender);
  return res.json({
    data: payload,
    name,
    handle,
    zone: ZONE_NAME
  });
});

app.use((_req, res) => sendError(res, 404, "not found"));

app.listen(PORT, HOST, () => {
  console.log(`addrs-api listening on http://${HOST}:${PORT}`);
  console.log(
    `zone=${ZONE_NAME} publicClaims=${ENABLE_PUBLIC_CLAIMS ? "on" : "off"} claimSig=${
      REQUIRE_CLAIM_SIGNATURE ? "on" : "off"
    }`
  );
  console.log(`payHubSepolia=${PAY_HUB_SEPOLIA_URL}`);
});
