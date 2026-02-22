/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");

// Load .env from x402s root (won't overwrite existing env vars)
const envPath = path.resolve(__dirname, "../../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const { ethers } = require("ethers");
const { verifyTicket } = require("../scp-hub/ticket");
const { HttpJsonClient } = require("../scp-common/http-client");
const { recoverChannelStateSigner } = require("../scp-hub/state-signing");
const { resolveNetwork, resolveAsset } = require("../scp-common/networks");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4080);
const DEFAULT_PRICES = { ETH: "0.005", USDC: "0.50", USDT: "0.50" };
const VALID_MODES = new Set(["hub", "direct"]);

function csvOrArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v === undefined || v === null) return [];
  return String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function listOrCsv(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeModes(v, context) {
  const modes = csvOrArray(v).map((m) => m.toLowerCase());
  const use = modes.length ? [...new Set(modes)] : ["hub"];
  for (const m of use) {
    if (!VALID_MODES.has(m)) {
      throw new Error(`invalid mode "${m}" in ${context}; use hub, direct, or hub,direct`);
    }
  }
  return use;
}

function normalizeAssetObject(chainId, item, index, context) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`${context}.asset[${index}] must be a symbol string or object`);
  }
  const address = String(item.address || "").trim();
  if (!ethers.utils.isAddress(address)) {
    throw new Error(`${context}.asset[${index}].address must be a valid token address`);
  }
  const decimals = Number(item.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`${context}.asset[${index}].decimals must be an integer between 0 and 255`);
  }
  const symbol = String(item.symbol || `TOKEN${index + 1}`).trim().toUpperCase();
  if (!symbol) {
    throw new Error(`${context}.asset[${index}].symbol must not be empty`);
  }
  return {
    chainId,
    address,
    decimals,
    symbol,
    price: item.price ? String(item.price).trim() : ""
  };
}

function buildAssets(chainId, assetEntries, prices, context) {
  if (!assetEntries.length) {
    throw new Error(`no assets configured in ${context}`);
  }
  if (prices.length > 1 && prices.length !== assetEntries.length) {
    throw new Error(
      `asset/price count mismatch in ${context}: got ${assetEntries.length} assets and ${prices.length} prices`
    );
  }
  const assets = [];
  for (let i = 0; i < assetEntries.length; i++) {
    const item = assetEntries[i];
    let a;
    if (typeof item === "string") {
      a = resolveAsset(chainId, item.toLowerCase());
    } else {
      a = normalizeAssetObject(chainId, item, i, context);
    }
    const fallbackPrice = DEFAULT_PRICES[a.symbol] || "1";
    assets.push({
      asset: a.address,
      symbol: a.symbol,
      decimals: a.decimals,
      price: prices[i] || prices[0] || a.price || fallbackPrice
    });
  }
  return assets;
}

function resolveNet(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("network is required");
  if (raw.startsWith("eip155:")) {
    const chainId = Number(raw.split(":")[1]);
    if (!Number.isFinite(chainId) || chainId <= 0) throw new Error(`invalid CAIP2 network: ${raw}`);
    return { chainId, name: raw, caip2: `eip155:${chainId}` };
  }
  const net = resolveNetwork(raw.toLowerCase());
  return { chainId: net.chainId, name: net.name, caip2: `eip155:${net.chainId}` };
}

function normalizePathAssetPrices(raw, context) {
  if (!raw) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${context} must be an object like {"/path":{"usdc":"0.5","eth":"0.005"}}`);
  }
  const out = {};
  for (const [pathname, entry] of Object.entries(raw)) {
    if (!pathname || pathname[0] !== "/") {
      throw new Error(`${context} has invalid path "${pathname}"; expected a leading "/"`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${context}.${pathname} must be an object mapping asset->price`);
    }
    const perAsset = {};
    for (const [assetName, priceValue] of Object.entries(entry)) {
      const sym = String(assetName || "").trim().toUpperCase();
      const price = String(priceValue || "").trim();
      if (!sym || !price) continue;
      perAsset[sym] = price;
    }
    if (!Object.keys(perAsset).length) {
      throw new Error(`${context}.${pathname} has no asset prices`);
    }
    out[pathname] = perAsset;
  }
  return out;
}

// Parse offer config from OFFERS_FILE only.
// OFFERS_FILE must be JSON object with shape:
// {
//   "offers": [ ... ],
//   "pathPrices": {
//     "/weather": { "usdc": "0.50", "eth": "0.005" }
//   }
// }
function parseOffers() {
  const parseStructured = (parsed, sourceName) => {
    if (!Array.isArray(parsed)) {
      throw new Error(`${sourceName} must be an array of offer blocks`);
    }
    const nets = [];
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i] || {};
      const label = `${sourceName}[${i}]`;
      const net = resolveNet(row.network);
      const modes = normalizeModes(row.mode || row.modes, label);
      const assetNames = listOrCsv(row.asset || row.assets);
      const prices = csvOrArray(row.maxAmountRequired || row.prices);
      const assets = buildAssets(net.chainId, assetNames, prices, label);
      const hubName = row.hubName;
      const hubEndpoint = row.hubEndpoint || row.hub;
      if (modes.includes("hub") && (!hubName || !hubEndpoint)) {
        throw new Error(`${label} requires hubName and hubEndpoint when mode includes "hub"`);
      }
      nets.push({
        ...net,
        assets,
        modes,
        hubName: hubName || null,
        hubEndpoint: hubEndpoint || null
      });
    }
    return nets;
  };

  const filePath = process.env.OFFERS_FILE;
  if (!filePath) {
    throw new Error("OFFERS_FILE is required");
  }
  const resolvedFilePath = path.isAbsolute(filePath) ? filePath : path.resolve(__dirname, "../../", filePath);

  let raw;
  try {
    raw = fs.readFileSync(resolvedFilePath, "utf8");
  } catch (e) {
    throw new Error(`OFFERS_FILE could not be read (${resolvedFilePath}): ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`OFFERS_FILE is not valid JSON (${resolvedFilePath}): ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OFFERS_FILE must be an object with { offers, pathPrices? }");
  }
  const offers = parseStructured(parsed.offers, "OFFERS_FILE.offers");
  if (!offers.length) throw new Error("OFFERS_FILE.offers must include at least one offer block");
  const pathAssetPrices = normalizePathAssetPrices(parsed.pathPrices, "OFFERS_FILE.pathPrices");
  return { nets: offers, pathAssetPrices };
}
const OFFER_CONFIG = parseOffers();
const NETS = OFFER_CONFIG.nets;
const PATH_ASSET_PRICES = OFFER_CONFIG.pathAssetPrices;

const PAYEE_KEY = process.env.PAYEE_PRIVATE_KEY;
if (!PAYEE_KEY) {
  console.error("FATAL: PAYEE_PRIVATE_KEY env var is required. Never use hardcoded keys.");
  process.exit(1);
}
const payeeWallet = new ethers.Wallet(PAYEE_KEY);
const PAYEE_ADDRESS = payeeWallet.address;

// --- Pricing ---

// Resolve price for a path + asset → smallest-unit string
function priceFor(pathname, asset) {
  const perPath = PATH_ASSET_PRICES[pathname] || null;
  const human = (perPath && perPath[asset.symbol]) || asset.price || DEFAULT_PRICES[asset.symbol] || "1";
  return { raw: ethers.utils.parseUnits(human, asset.decimals).toString(), human };
}

// WMO weather codes → descriptions
const WMO_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
  77: "Snow grains",
  80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail"
};

function now() { return Math.floor(Date.now() / 1000); }
function randomId(p) { return `${p}_${crypto.randomBytes(10).toString("hex")}`; }

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

// --- Open-Meteo fetch (free, no API key) ---

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("parse: " + data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`;
  const data = await httpsGet(url);
  if (!data.results || !data.results.length) return null;
  const r = data.results[0];
  return { name: r.name, country: r.country, lat: r.latitude, lon: r.longitude, timezone: r.timezone };
}

async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure` +
    `&temperature_unit=celsius&wind_speed_unit=kmh`;
  return httpsGet(url);
}

// --- Payment validation ---

function parsePaymentHeader(req) {
  const raw = req.headers["payment-signature"];
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_e) { return null; }
}

async function validatePayment(pp, ctx) {
  if (!pp) return { ok: false, error: "no payment" };

  if (pp.scheme === "statechannel-hub-v1") {
    const ticket = pp.ticket;
    if (!ticket) return { ok: false, error: "missing ticket" };
    const signer = verifyTicket(ticket);
    if (!signer) return { ok: false, error: "bad ticket sig" };

    const inv = ctx.invoices.get(pp.invoiceId);
    if (!inv) return { ok: false, error: "unknown invoice" };
    const hubEndpoint = inv.hubEndpoint;
    if (!hubEndpoint) return { ok: false, error: "missing hub endpoint" };

    let hubAddr = ctx.hubAddressCache.get(hubEndpoint);
    if (!hubAddr) {
      const meta = await ctx.http.request("GET", `${hubEndpoint}/.well-known/x402`);
      if (meta.statusCode !== 200) return { ok: false, error: "hub unreachable" };
      hubAddr = meta.body.address;
      ctx.hubAddressCache.set(hubEndpoint, hubAddr);
    }
    if (signer.toLowerCase() !== hubAddr.toLowerCase()) return { ok: false, error: "signer mismatch" };
    if (ticket.payee.toLowerCase() !== PAYEE_ADDRESS.toLowerCase()) return { ok: false, error: "wrong payee" };
    if (ticket.expiry < now()) return { ok: false, error: "expired" };
    if (inv.amount !== ticket.amount) return { ok: false, error: "amount mismatch" };
    if (inv.asset && String(inv.asset).toLowerCase() !== String(ticket.asset).toLowerCase()) {
      return { ok: false, error: "asset mismatch" };
    }

    const status = await ctx.http.request("GET", `${hubEndpoint}/v1/payments/${encodeURIComponent(pp.paymentId)}`);
    if (status.statusCode !== 200 || status.body.status !== "issued") return { ok: false, error: "hub not issued" };

    return { ok: true };
  }

  if (pp.scheme === "statechannel-direct-v1") {
    const dp = pp.direct;
    if (!dp || !dp.channelState || !dp.sigA) return { ok: false, error: "missing direct fields" };
    if (dp.payee.toLowerCase() !== PAYEE_ADDRESS.toLowerCase()) return { ok: false, error: "wrong payee" };
    if (dp.expiry < now()) return { ok: false, error: "expired" };
    if (dp.invoiceId !== pp.invoiceId || dp.paymentId !== pp.paymentId) return { ok: false, error: "direct id mismatch" };

    const inv = ctx.invoices.get(pp.invoiceId);
    if (!inv) return { ok: false, error: "unknown invoice" };
    if (inv.amount !== dp.amount) return { ok: false, error: "amount mismatch" };
    if (inv.asset && String(inv.asset).toLowerCase() !== String(dp.asset || "").toLowerCase()) {
      return { ok: false, error: "asset mismatch" };
    }

    const signer = recoverChannelStateSigner(dp.channelState, dp.sigA);
    if (signer.toLowerCase() !== dp.payer.toLowerCase()) return { ok: false, error: "bad payer sig" };

    const chId = dp.channelState.channelId;
    const prev = ctx.directChannels.get(chId) || { nonce: 0, balB: "0" };
    if (Number(dp.channelState.stateNonce) <= prev.nonce) return { ok: false, error: "stale nonce" };
    if (BigInt(dp.channelState.balB) - BigInt(prev.balB) < BigInt(dp.amount)) return { ok: false, error: "insufficient delta" };
    if (dp.channelState.stateExpiry && Number(dp.channelState.stateExpiry) < now()) return { ok: false, error: "state expired" };

    ctx.directChannels.set(chId, { nonce: Number(dp.channelState.stateNonce), balB: dp.channelState.balB });
    return { ok: true };
  }

  return { ok: false, error: "unknown scheme" };
}

// --- 402 challenge (reusable for any path) ---

function send402(res, pathname, resource, ctx, extra) {
  const offers = [];
  const pricing = [];
  for (const net of NETS) {
    for (const asset of net.assets) {
      const { raw, human } = priceFor(pathname, asset);
      const invoiceId = randomId("inv");
      ctx.invoices.set(invoiceId, {
        createdAt: now(),
        amount: raw,
        asset: asset.asset,
        network: net.caip2,
        hubName: net.hubName || null,
        hubEndpoint: net.hubEndpoint
      });
      pricing.push({ network: net.name, asset: asset.symbol, price: raw, human, decimals: asset.decimals });
      if (net.modes.includes("hub")) {
        offers.push({
          scheme: "statechannel-hub-v1",
          network: net.caip2, asset: asset.asset, maxAmountRequired: raw,
          payTo: net.hubName, resource,
          extensions: { "statechannel-hub-v1": {
            hubName: net.hubName,
            hubEndpoint: net.hubEndpoint,
            mode: "proxy_hold",
            feeModel: { base: "10", bps: 30 }, quoteExpiry: now() + 120,
            invoiceId, payeeAddress: PAYEE_ADDRESS
          }}
        });
      }
      if (net.modes.includes("direct")) {
        offers.push({
          scheme: "statechannel-direct-v1",
          network: net.caip2, asset: asset.asset, maxAmountRequired: raw,
          payTo: PAYEE_ADDRESS, resource,
          extensions: { "statechannel-direct-v1": {
            mode: "direct", quoteExpiry: now() + 120,
            invoiceId, payeeAddress: PAYEE_ADDRESS
          }}
        });
      }
    }
  }
  return sendJson(res, 402, { message: `Payment required for ${pathname}`, pricing, accepts: offers, ...extra });
}

// --- Request handler ---

async function handle(req, res, ctx) {
  const u = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && u.pathname === "/health") {
    return sendJson(res, 200, { ok: true, payee: PAYEE_ADDRESS });
  }

  // Weather endpoint
  if (req.method === "GET" && u.pathname === "/weather") {
    const city = u.searchParams.get("city");
    if (!city) return sendJson(res, 400, { error: "city parameter required" });

    const pp = parsePaymentHeader(req);
    if (!pp) {
      const resource = `http://${HOST}:${PORT}/weather?city=${encodeURIComponent(city)}`;
      return send402(res, "/weather", resource, ctx, { city });
    }

    const result = await validatePayment(pp, ctx);
    if (!result.ok) return sendJson(res, 402, { error: result.error, retryable: false });

    const geo = await geocode(city);
    if (!geo) return sendJson(res, 404, { error: "city not found", city });

    const weather = await fetchWeather(geo.lat, geo.lon);
    const cur = weather.current;

    return sendJson(res, 200, {
      ok: true,
      location: { city: geo.name, country: geo.country, lat: geo.lat, lon: geo.lon, timezone: geo.timezone },
      current: {
        temperature: cur.temperature_2m, feelsLike: cur.apparent_temperature,
        humidity: cur.relative_humidity_2m, precipitation: cur.precipitation,
        condition: WMO_CODES[cur.weather_code] || `code ${cur.weather_code}`,
        weatherCode: cur.weather_code,
        wind: { speed: cur.wind_speed_10m, gusts: cur.wind_gusts_10m, direction: cur.wind_direction_10m },
        pressure: cur.surface_pressure
      },
      units: weather.current_units,
      receipt: { paymentId: pp.paymentId, receiptId: randomId("rcpt"), acceptedAt: now() }
    });
  }

  // Generic paid endpoint — any path in OFFERS_FILE.pathPrices gets a 402 paywall
  if (req.method === "GET" && PATH_ASSET_PRICES[u.pathname]) {
    const pp = parsePaymentHeader(req);
    if (!pp) {
      const resource = `http://${HOST}:${PORT}${u.pathname}`;
      return send402(res, u.pathname, resource, ctx);
    }
    const result = await validatePayment(pp, ctx);
    if (!result.ok) return sendJson(res, 402, { error: result.error, retryable: false });
    return sendJson(res, 200, {
      ok: true, path: u.pathname,
      receipt: { paymentId: pp.paymentId, receiptId: randomId("rcpt"), acceptedAt: now() }
    });
  }

  return sendJson(res, 404, { error: "not found. use GET /weather?city=London" });
}

function createWeatherServer(options = {}) {
  const ctx = {
    invoices: new Map(),
    directChannels: new Map(),
    hubAddressCache: new Map(),
    http: new HttpJsonClient({ timeoutMs: 8000, maxSockets: 64 })
  };
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      sendJson(res, 500, { error: err.message || "internal error" });
    });
  });
  server.on("close", () => ctx.http.close());
  return server;
}

if (require.main === module) {
  const server = createWeatherServer();
  server.listen(PORT, HOST, () => {
    console.log(`Weather API on ${HOST}:${PORT} (payee: ${PAYEE_ADDRESS})`);
    for (const net of NETS) {
      console.log(
        `  ${net.name} (${net.caip2}) [${net.modes.join("+")}] hub=${net.hubName || "n/a"} @ ${net.hubEndpoint || "n/a"}`
      );
      for (const a of net.assets) {
        const p = priceFor("/weather", a);
        console.log(`    ${a.symbol}: ${p.human}`);
      }
    }
    const pricedPaths = Object.keys(PATH_ASSET_PRICES);
    if (pricedPaths.length) {
      console.log(`  paid paths: ${pricedPaths.join(", ")}`);
    }
  });
}

module.exports = { createWeatherServer, PAYEE_ADDRESS };
