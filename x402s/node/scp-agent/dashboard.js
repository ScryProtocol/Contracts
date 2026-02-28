/* eslint-disable no-console */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { HttpJsonClient } = require("../scp-common/http-client");

const PORT = Number(process.env.DASH_PORT || 4090);
const HOST = process.env.DASH_HOST || "127.0.0.1";
const AGENT_STATE = process.env.AGENT_STATE_DIR || path.resolve(__dirname, "./state");
const REFRESH_SEC = Number(process.env.DASH_REFRESH || 5);

const httpClient = new HttpJsonClient({ timeoutMs: 3000 });

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (_e) { return null; }
}

function fmtTs(ts) {
  if (!ts) return "-";
  try { return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19); } catch (_e) { return String(ts); }
}

function fmtAmount(raw, decimals = 6) {
  if (!raw) return "-";
  const s = String(raw).padStart(decimals + 1, "0");
  return s.slice(0, -decimals) + "." + s.slice(-decimals);
}

async function fetchHubSummary(hubUrl, channelId) {
  try {
    const res = await httpClient.request("GET", `${hubUrl}/v1/agent/summary?channelId=${encodeURIComponent(channelId)}`);
    if (res.statusCode === 200) return res.body;
  } catch (_e) { /* hub unreachable */ }
  return null;
}

async function fetchHubReceipts(hubUrl, channelId) {
  try {
    const res = await httpClient.request("GET", `${hubUrl}/v1/agent/receipts?channelId=${encodeURIComponent(channelId)}&limit=50`);
    if (res.statusCode === 200) return res.body;
  } catch (_e) { /* hub unreachable */ }
  return null;
}

async function buildData() {
  const agentState = readJson(path.join(AGENT_STATE, "agent-state.json"));
  const data = { apis: [], payments: [], channels: [], hubSummaries: [], ts: Date.now() };

  // Agent payments → per-API aggregation
  if (agentState && agentState.payments) {
    const byApi = {};
    const rows = [];
    for (const [id, p] of Object.entries(agentState.payments)) {
      rows.push({ paymentId: id, ...p });
      let key = p.resourceUrl || p.payee || "unknown";
      try { const u = new URL(key); key = `${u.origin}${u.pathname}`; } catch (_e) { /* keep raw */ }
      if (!byApi[key]) byApi[key] = { api: key, count: 0, total: 0n, lastPaidAt: 0, routes: {} };
      byApi[key].count += 1;
      if (p.amount) byApi[key].total += BigInt(p.amount);
      byApi[key].lastPaidAt = Math.max(byApi[key].lastPaidAt, Number(p.paidAt || 0));
      const r = p.route || "unknown";
      byApi[key].routes[r] = (byApi[key].routes[r] || 0) + 1;
    }
    data.apis = Object.values(byApi)
      .sort((a, b) => (a.total === b.total ? b.count - a.count : a.total > b.total ? -1 : 1))
      .map((a) => ({ ...a, total: a.total.toString() }));
    data.payments = rows
      .sort((a, b) => Number(b.paidAt || 0) - Number(a.paidAt || 0))
      .slice(0, 50);
  }

  // Agent channels + live hub queries
  if (agentState && agentState.channels) {
    const hubQueries = [];
    for (const [key, ch] of Object.entries(agentState.channels)) {
      data.channels.push({ key, ...ch });
      if (ch.endpoint && ch.channelId) {
        hubQueries.push(
          fetchHubSummary(ch.endpoint, ch.channelId).then((summary) => {
            if (summary) data.hubSummaries.push({ hub: ch.endpoint, ...summary });
          })
        );
      }
    }
    await Promise.all(hubQueries);
  }

  return data;
}

function renderHtml(data) {
  const grandTotal = data.apis.reduce((s, a) => s + BigInt(a.total), 0n);

  const apiRows = data.apis.map((a) => {
    const routes = Object.entries(a.routes).map(([r, c]) => `${r}:${c}`).join(", ");
    return `<tr>
      <td class="api">${esc(a.api)}</td>
      <td class="num">${a.count}</td>
      <td class="num amt">${fmtAmount(a.total)}</td>
      <td class="dim">${routes}</td>
      <td class="dim">${fmtTs(a.lastPaidAt)}</td>
    </tr>`;
  }).join("");

  const payRows = data.payments.slice(0, 20).map((p) => `<tr>
    <td class="dim mono">${esc((p.paymentId || "").slice(0, 16))}&hellip;</td>
    <td>${fmtAmount(p.amount)}</td>
    <td class="api">${esc(shortUrl(p.resourceUrl || p.payee || "-"))}</td>
    <td class="dim">${p.route || "-"}</td>
    <td class="dim">${fmtTs(p.paidAt)}</td>
  </tr>`).join("");

  const chRows = data.channels.map((ch) => {
    const summary = data.hubSummaries.find((s) => s.channelId === ch.channelId);
    const hubSpent = summary ? fmtAmount(summary.totalSpent) : "-";
    const hubFees = summary ? fmtAmount(summary.totalFees) : "-";
    const hubPayments = summary ? summary.payments : "-";
    return `<tr>
      <td class="dim mono">${esc(ch.key)}</td>
      <td class="mono">${esc((ch.channelId || "").slice(0, 16))}&hellip;</td>
      <td class="num">${ch.nonce || 0}</td>
      <td class="num">${fmtAmount(ch.balA)}</td>
      <td class="num">${fmtAmount(ch.balB)}</td>
      <td class="num amt">${hubSpent}</td>
      <td class="num dim">${hubFees}</td>
      <td class="num">${hubPayments}</td>
    </tr>`;
  }).join("");

  const hubTotal = data.hubSummaries.reduce((s, h) => ({
    payments: s.payments + (h.payments || 0),
    spent: s.spent + BigInt(h.totalSpent || "0"),
    fees: s.fees + BigInt(h.totalFees || "0")
  }), { payments: 0, spent: 0n, fees: 0n });

  const hubInfo = data.hubSummaries.length > 0
    ? `<span class="pill">${hubTotal.payments} routed</span> <span class="pill">${fmtAmount(hubTotal.spent.toString())} spent</span> <span class="pill">${fmtAmount(hubTotal.fees.toString())} fees</span>`
    : `<span class="dim">hub unreachable</span>`;

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH_SEC}">
<title>SCP Earnings</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #c9d1d9; --dim: #8b949e; --accent: #58a6ff; --green: #3fb950; --orange: #d29922; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); padding: 20px; }
  h1 { font-size: 20px; margin-bottom: 16px; }
  h2 { font-size: 15px; color: var(--dim); margin: 20px 0 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 20px; min-width: 140px; }
  .stat .label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 24px; font-weight: 600; color: var(--green); }
  .stat .value.accent { color: var(--accent); }
  .stat .value.orange { color: var(--orange); }
  table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
  th { text-align: left; padding: 8px 12px; font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
  td { padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .amt { color: var(--green); font-weight: 600; }
  .dim { color: var(--dim); }
  .mono { font-family: "SF Mono", Menlo, monospace; font-size: 12px; }
  .api { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent); }
  .pill { display: inline-block; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 2px 10px; font-size: 12px; }
  .footer { margin-top: 20px; font-size: 11px; color: var(--dim); }
</style>
</head><body>
<h1>SCP Earnings Dashboard</h1>

<div class="stats">
  <div class="stat"><div class="label">Total Spent</div><div class="value">${fmtAmount(grandTotal.toString())}</div></div>
  <div class="stat"><div class="label">APIs</div><div class="value accent">${data.apis.length}</div></div>
  <div class="stat"><div class="label">Payments</div><div class="value accent">${data.payments.length}</div></div>
  <div class="stat"><div class="label">Channels</div><div class="value orange">${data.channels.length}</div></div>
</div>

<h2>Earnings per API</h2>
<table>
  <tr><th>API</th><th class="num">Payments</th><th class="num">Total</th><th>Routes</th><th>Last Paid</th></tr>
  ${apiRows || '<tr><td colspan="5" class="dim">No payments yet</td></tr>'}
</table>

<h2>Recent Payments</h2>
<table>
  <tr><th>Payment ID</th><th>Amount</th><th>API</th><th>Route</th><th>Time</th></tr>
  ${payRows || '<tr><td colspan="5" class="dim">No payments yet</td></tr>'}
</table>

<h2>Channels</h2>
<table>
  <tr><th>Hub</th><th>Channel ID</th><th class="num">Nonce</th><th class="num">Bal A</th><th class="num">Bal B</th><th class="num">Hub Spent</th><th class="num">Fees</th><th class="num">Txns</th></tr>
  ${chRows || '<tr><td colspan="8" class="dim">No channels</td></tr>'}
</table>

<h2>Hub</h2>
<div style="padding: 8px 0;">${hubInfo}</div>

<div class="footer">Auto-refreshes every ${REFRESH_SEC}s &middot; ${new Date().toISOString().replace("T", " ").slice(0, 19)}</div>
</body></html>`;
}

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function shortUrl(u) { try { const p = new URL(u); return p.pathname + p.search; } catch (_e) { return u; } }

async function handleApi(_req, res) {
  const data = await buildData();
  const body = JSON.stringify(data);
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

async function handleDash(_req, res) {
  const data = await buildData();
  const html = renderHtml(data);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    });
    return res.end();
  }
  const handler = req.url === "/api" ? handleApi : handleDash;
  handler(req, res).catch((err) => {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(err.message || "internal error");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SCP Dashboard → http://${HOST}:${PORT}`);
  console.log(`  JSON API    → http://${HOST}:${PORT}/api`);
  console.log(`  Agent state → ${AGENT_STATE}`);
  console.log(`  Hub data    → live queries to hub endpoints per channel`);
});
