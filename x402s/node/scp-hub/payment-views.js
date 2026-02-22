function toBigInt(value) {
  try {
    return BigInt(value || "0");
  } catch (_e) {
    return 0n;
  }
}

function toAgentReceipt(payment) {
  return {
    paymentId: payment.paymentId,
    channelId: payment.channelId,
    invoiceId: payment.invoiceId,
    ticketId: payment.ticketId,
    payee: payment.payee,
    asset: payment.asset,
    amount: payment.amount,
    fee: payment.fee,
    totalDebit: payment.totalDebit,
    stateNonce: payment.stateNonce,
    createdAt: payment.createdAt
  };
}

function issuedPayments(payments) {
  return (payments || []).filter((p) => p && p.status === "issued");
}

function buildAgentSummary(channelId, latestNonce, payments) {
  const rows = [];
  let totalSpent = 0n;
  let totalFees = 0n;

  for (const p of issuedPayments(payments)) {
    const amount = toBigInt(p.amount);
    const fee = toBigInt(p.fee);
    totalSpent += amount;
    totalFees += fee;
    rows.push({
      paymentId: p.paymentId,
      amount: amount.toString(),
      fee: fee.toString(),
      payee: p.payee,
      ticketId: p.ticketId
    });
  }

  return {
    channelId,
    latestNonce,
    payments: rows.length,
    totalSpent: totalSpent.toString(),
    totalFees: totalFees.toString(),
    totalDebit: (totalSpent + totalFees).toString(),
    items: rows
  };
}

function buildAgentReceipts(payments, { since = 0, limit = 100, channelId = null, payee = "" } = {}) {
  const payeeFilter = String(payee || "").toLowerCase();
  const filtered = [];

  for (const p of issuedPayments(payments)) {
    if (channelId && p.channelId !== channelId) continue;
    if (payeeFilter && String(p.payee || "").toLowerCase() !== payeeFilter) continue;
    if (Number(p.createdAt || 0) <= since) continue;
    filtered.push(toAgentReceipt(p));
  }

  filtered.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const items = filtered.slice(0, limit);
  const nextCursor = items.length ? Number(items[items.length - 1].createdAt || since) : since;

  return {
    since,
    count: items.length,
    nextCursor,
    items
  };
}

module.exports = {
  buildAgentSummary,
  buildAgentReceipts
};
