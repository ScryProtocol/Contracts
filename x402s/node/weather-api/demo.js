/* eslint-disable no-console */
const crypto = require("crypto");
const { ethers } = require("ethers");
const { signChannelState } = require("../scp-hub/state-signing");
const { HttpJsonClient } = require("../scp-common/http-client");

const ZERO32 = "0x" + "0".repeat(64);
const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
const AGENT_KEY = "0x6c875bfb4f247fcbcd37fd56f564fca0cfaf6458cd5e8878e9ef32ed5004f999";

function now() { return Math.floor(Date.now() / 1000); }
function randomId(p) { return `${p}_${crypto.randomBytes(10).toString("hex")}`; }

async function main() {
  const cities = process.argv.slice(2);
  if (!cities.length) cities.push("London", "Tokyo", "New York", "Sydney", "Cairo");

  // Start hub
  process.env.HUB_PRIVATE_KEY = HUB_KEY;
  process.env.STORE_PATH = ":memory:";
  const { createServer: createHub } = require("../scp-hub/server");
  const hub = createHub();
  const hubPort = await new Promise(r => hub.listen(0, "127.0.0.1", () => r(hub.address().port)));
  const hubUrl = `http://127.0.0.1:${hubPort}`;

  // Start weather API
  process.env.HUB_URL = hubUrl;
  process.env.WEATHER_PRICE = "1000000";
  const { createWeatherServer } = require("./server");
  const weather = createWeatherServer();
  const wxPort = await new Promise(r => weather.listen(0, "127.0.0.1", () => r(weather.address().port)));
  const wxUrl = `http://127.0.0.1:${wxPort}`;

  const agent = new ethers.Wallet(AGENT_KEY);
  const http = new HttpJsonClient({ timeoutMs: 10000 });

  // Channel state (off-chain virtual balance)
  const channelId = "0x" + crypto.createHash("sha256").update(`weather:${agent.address}`).digest("hex");
  let nonce = 0;
  let balA = 100_000_000_000n;
  let balB = 0n;

  console.log("Agent:", agent.address);
  console.log("Hub:  ", hubUrl);
  console.log("API:  ", wxUrl);
  console.log("Cities:", cities.join(", "));
  console.log();

  for (const city of cities) {
    console.log(`--- ${city} ---`);

    // 1. Request weather → get 402
    const offer = await http.request("GET", `${wxUrl}/weather?city=${encodeURIComponent(city)}`);
    if (offer.statusCode !== 402) {
      console.log("  unexpected:", offer.statusCode);
      continue;
    }
    const ext = offer.body.accepts[0].extensions["statechannel-hub-v1"];
    const invoiceId = ext.invoiceId;
    const paymentId = randomId("pay");
    const amount = offer.body.price;

    // 2. Quote
    const contextHash = ethers.utils.id(`weather:${city}:${paymentId}`);
    const quote = await http.request("POST", `${hubUrl}/v1/tickets/quote`, {
      invoiceId,
      paymentId,
      channelId,
      payee: ext.payeeAddress,
      asset: offer.body.accepts[0].asset,
      amount,
      maxFee: "100000",
      quoteExpiry: now() + 120,
      contextHash
    });
    if (quote.statusCode !== 200) { console.log("  quote fail:", quote.body); continue; }

    // 3. Update channel state
    const totalDebit = BigInt(quote.body.totalDebit);
    nonce += 1;
    balA -= totalDebit;
    balB += totalDebit;
    const state = {
      channelId,
      stateNonce: nonce,
      balA: balA.toString(),
      balB: balB.toString(),
      locksRoot: ZERO32,
      stateExpiry: now() + 3600,
      contextHash
    };
    const sigA = await signChannelState(state, agent);

    // 4. Issue ticket
    const issued = await http.request("POST", `${hubUrl}/v1/tickets/issue`, {
      quote: quote.body,
      channelState: state,
      sigA
    });
    if (issued.statusCode !== 200) { console.log("  issue fail:", issued.body); continue; }
    const ticket = { ...issued.body };
    delete ticket.channelAck;

    // 5. Pay for weather
    const paymentPayload = {
      scheme: "statechannel-hub-v1",
      paymentId,
      invoiceId,
      ticket,
      channelProof: { channelId, stateNonce: nonce, sigA }
    };
    const wx = await http.request("GET", `${wxUrl}/weather?city=${encodeURIComponent(city)}`, null, {
      "PAYMENT-SIGNATURE": JSON.stringify(paymentPayload)
    });

    if (wx.statusCode === 200 && wx.body.ok) {
      const c = wx.body.current;
      const loc = wx.body.location;
      console.log(`  ${loc.city}, ${loc.country} (${loc.lat}, ${loc.lon})`);
      console.log(`  ${c.temperature}°C (feels ${c.feelsLike}°C) — ${c.condition}`);
      console.log(`  Humidity: ${c.humidity}% | Wind: ${c.wind.speed} km/h | Pressure: ${c.pressure} hPa`);
      console.log(`  Paid: ${ethers.utils.formatUnits(amount, 6)} (fee: ${ethers.utils.formatUnits(quote.body.fee, 6)})`);
    } else {
      console.log("  payment rejected:", wx.body);
    }
    console.log();
  }

  // Summary
  console.log("=== Summary ===");
  console.log(`${cities.length} weather lookups`);
  console.log(`Channel nonce: ${nonce}`);
  console.log(`Agent balance: ${balA} → Hub balance: ${balB}`);

  http.close();
  weather.close();
  hub.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
