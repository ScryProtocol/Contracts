/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const stateDir = process.env.AGENT_STATE_DIR || path.resolve(__dirname, "./state");
const stateFile = path.join(stateDir, "agent-state.json");
const mode = process.argv[2] || "list";

function fmtTs(ts) {
  if (!ts) return "-";
  try {
    return new Date(ts * 1000).toISOString();
  } catch (_e) {
    return String(ts);
  }
}

function main() {
  if (!fs.existsSync(stateFile)) {
    console.log(`No agent state found at ${stateFile}`);
    process.exit(0);
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const payments = state.payments || {};
  const ids = Object.keys(payments);
  if (ids.length === 0) {
    console.log("No payments yet.");
    process.exit(0);
  }

  const rows = ids
    .map((id) => ({ paymentId: id, ...payments[id] }))
    .sort((a, b) => Number(b.paidAt || 0) - Number(a.paidAt || 0));

  if (mode === "api" || mode === "--api" || mode === "summary" || mode === "--summary") {
    const byApi = {};
    for (const p of rows) {
      if (!p.resourceUrl || !p.amount) continue;
      let key = p.resourceUrl;
      try {
        const u = new URL(p.resourceUrl);
        key = `${u.origin}${u.pathname}`;
      } catch (_e) {
        // keep raw key
      }
      if (!byApi[key]) {
        byApi[key] = { api: key, payments: 0, earned: 0n, lastPaidAt: 0 };
      }
      byApi[key].payments += 1;
      byApi[key].earned += BigInt(p.amount);
      byApi[key].lastPaidAt = Math.max(byApi[key].lastPaidAt, Number(p.paidAt || 0));
    }

    const summary = Object.values(byApi).sort((a, b) => {
      if (a.earned === b.earned) return b.payments - a.payments;
      return a.earned > b.earned ? -1 : 1;
    });

    if (summary.length === 0) {
      console.log("No API earnings data yet (no payments with resourceUrl + amount).");
      process.exit(0);
    }

    console.log(`APIs: ${summary.length}`);
    for (const s of summary) {
      console.log("-----");
      console.log(`  api:       ${s.api}`);
      console.log(`  payments:  ${s.payments}`);
      console.log(`  earned:    ${s.earned.toString()}`);
      console.log(`  lastPaid:  ${fmtTs(s.lastPaidAt)}`);
    }
    process.exit(0);
  }

  console.log(`Payments: ${rows.length}`);
  for (const p of rows) {
    console.log("-----");
    console.log(`  paymentId: ${p.paymentId}`);
    console.log(`  paidAt:    ${fmtTs(p.paidAt)}`);
    console.log(`  route:     ${p.route || "-"}`);
    if (p.amount) console.log(`  amount:    ${p.amount}`);
    if (p.payee) console.log(`  payee:     ${p.payee}`);
    if (p.resourceUrl) console.log(`  resource:  ${p.resourceUrl}`);
    if (p.ticketId) console.log(`  ticketId:  ${p.ticketId}`);
    if (p.receipt) console.log(`  receiptId: ${p.receipt.receiptId || p.receipt.merchantReceiptId || "-"}`);
  }
}

main();
