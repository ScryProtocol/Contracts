function toBigInt(value) {
  try {
    return BigInt(value || "0");
  } catch (_e) {
    return 0n;
  }
}

function refundedAmount(payment) {
  if (!payment || typeof payment !== "object") return 0n;
  if (payment.refundedAmount !== undefined) return toBigInt(payment.refundedAmount);
  if (payment.status === "refunded") {
    if (payment.refundAmount !== undefined) return toBigInt(payment.refundAmount);
    return toBigInt(payment.amount);
  }
  return 0n;
}

function refundedTotalDebit(payment) {
  if (!payment || typeof payment !== "object") return 0n;
  if (payment.refundedTotalDebit !== undefined) return toBigInt(payment.refundedTotalDebit);
  if (payment.status === "refunded" && payment.refundTotalDebit !== undefined) {
    return toBigInt(payment.refundTotalDebit);
  }
  return 0n;
}

function netPaymentAmounts(payment) {
  const amount = toBigInt(payment.amount);
  const fee = toBigInt(payment.fee);
  const refundedAmt = refundedAmount(payment);
  const refundedDebit = refundedTotalDebit(payment);
  const refundedFee = refundedDebit > refundedAmt ? refundedDebit - refundedAmt : 0n;
  const netAmount = amount > refundedAmt ? amount - refundedAmt : 0n;
  const netFee = fee > refundedFee ? fee - refundedFee : 0n;
  return { netAmount, netFee, refundedAmt };
}

function toAgentReceipt(payment) {
  const { netAmount, netFee, refundedAmt } = netPaymentAmounts(payment);
  return {
    paymentId: payment.paymentId,
    channelId: payment.channelId,
    invoiceId: payment.invoiceId,
    ticketId: payment.ticketId,
    payee: payment.payee,
    asset: payment.asset,
    amount: payment.amount,
    fee: payment.fee,
    status: payment.status,
    refundedAmount: refundedAmt.toString(),
    netAmount: netAmount.toString(),
    netFee: netFee.toString(),
    totalDebit: payment.totalDebit,
    stateNonce: payment.stateNonce,
    createdAt: payment.createdAt
  };
}

function issuedPayments(payments) {
  return (payments || []).filter((p) => p && (p.status === "issued" || p.status === "partially_refunded"));
}

function buildAgentSummary(channelId, latestNonce, payments) {
  const rows = [];
  let totalSpent = 0n;
  let totalFees = 0n;

  for (const p of issuedPayments(payments)) {
    const { netAmount, netFee } = netPaymentAmounts(p);
    const amount = netAmount;
    const fee = netFee;
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
