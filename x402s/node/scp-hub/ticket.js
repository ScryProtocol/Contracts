const { ethers } = require("ethers");
const { hashChannelState, recoverChannelStateSigner } = require("./state-signing");

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((k) => {
        out[k] = canonicalize(value[k]);
      });
    return out;
  }
  return value;
}

function ticketDraftDigest(ticketDraft) {
  const canonical = canonicalize(ticketDraft);
  const encoded = JSON.stringify(canonical);
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(encoded));
}

async function signTicketDraft(ticketDraft, signer) {
  const digest = ticketDraftDigest(ticketDraft);
  return signer.signMessage(ethers.utils.arrayify(digest));
}

function verifyTicket(ticket) {
  const { sig, ...ticketDraft } = ticket;
  if (!sig || typeof sig !== "string") return null;
  const digest = ticketDraftDigest(ticketDraft);
  return ethers.utils.verifyMessage(ethers.utils.arrayify(digest), sig);
}

function parsePaymentHeader(header) {
  if (!header) return null;
  try { return typeof header === "string" ? JSON.parse(header) : header; } catch (_) { return null; }
}

function nowSec() { return Date.now() / 1000 | 0; }

/**
 * Verify a hub-routed payment header (ticket + channel proof).
 *
 *   const { ok, error, signer, ticket, paymentId } = verifyPayment(
 *     req.headers["payment-signature"],
 *     { hub: "0xHubAddr", payee: "0xMyAddr", amount: "1000000" }
 *   );
 */
function verifyPayment(header, expect) {
  const payload = parsePaymentHeader(header);
  if (!payload) return { ok: false, error: "missing or invalid header" };
  if (!payload.ticket) return { ok: false, error: "no ticket" };

  const signer = verifyTicket(payload.ticket);
  if (!signer) return { ok: false, error: "bad ticket sig" };
  if (expect.hub && signer.toLowerCase() !== expect.hub.toLowerCase()) return { ok: false, error: "ticket signer mismatch", signer };
  if (expect.payee && payload.ticket.payee.toLowerCase() !== expect.payee.toLowerCase()) return { ok: false, error: "wrong payee", signer };
  if (expect.amount && payload.ticket.amount !== expect.amount) return { ok: false, error: "wrong amount", signer };
  if (payload.ticket.expiry && payload.ticket.expiry < nowSec()) return { ok: false, error: "expired", signer };

  // Channel proof verification
  const cp = payload.channelProof;
  if (cp) {
    if (!cp.channelId || cp.stateNonce === undefined || !cp.stateHash || !cp.sigA) {
      return { ok: false, error: "incomplete channel proof", signer };
    }
    if (cp.channelState) {
      if (cp.channelState.channelId !== cp.channelId || Number(cp.channelState.stateNonce) !== Number(cp.stateNonce)) {
        return { ok: false, error: "channel proof mismatch", signer };
      }
      const expectedHash = hashChannelState(cp.channelState);
      if (String(expectedHash).toLowerCase() !== String(cp.stateHash).toLowerCase()) {
        return { ok: false, error: "state hash mismatch", signer };
      }
      try {
        recoverChannelStateSigner(cp.channelState, cp.sigA);
      } catch (_e) {
        return { ok: false, error: "invalid channel proof sig", signer };
      }
    }
  }

  return { ok: true, signer, ticket: payload.ticket, paymentId: payload.paymentId, channelProof: cp };
}

/**
 * Verify a direct peer-to-peer payment header.
 * `state` tracks per-channel nonce/balance progression: Map<channelId, { nonce, balB }>.
 */
function verifyDirectPayment(header, expect, state) {
  const payload = parsePaymentHeader(header);
  if (!payload) return { ok: false, error: "missing or invalid header" };
  if (payload.scheme !== "statechannel-direct-v1") return { ok: false, error: "wrong scheme" };

  const dp = payload.direct;
  if (!dp || !dp.channelState || !dp.sigA || !dp.payer || !dp.amount || !dp.payee) {
    return { ok: false, error: "missing direct payment fields" };
  }
  if (expect.payee && dp.payee.toLowerCase() !== expect.payee.toLowerCase()) {
    return { ok: false, error: "direct payee mismatch" };
  }
  if (expect.asset && String(dp.asset || "").toLowerCase() !== String(expect.asset).toLowerCase()) {
    return { ok: false, error: "direct asset mismatch" };
  }
  if (dp.invoiceId !== payload.invoiceId || dp.paymentId !== payload.paymentId) {
    return { ok: false, error: "direct id mismatch" };
  }
  if (dp.expiry < nowSec()) return { ok: false, error: "direct payment expired" };
  if (expect.amount && dp.amount !== expect.amount) return { ok: false, error: "wrong amount" };

  const recovered = recoverChannelStateSigner(dp.channelState, dp.sigA);
  if (recovered.toLowerCase() !== dp.payer.toLowerCase()) {
    return { ok: false, error: "payer sig mismatch" };
  }

  if (state) {
    const channelId = dp.channelState.channelId;
    const prev = state.get(channelId) || { nonce: 0, balB: "0" };
    const nextNonce = Number(dp.channelState.stateNonce);
    if (nextNonce <= Number(prev.nonce)) return { ok: false, error: "stale direct nonce" };
    if (BigInt(dp.channelState.balB) - BigInt(prev.balB) < BigInt(dp.amount)) {
      return { ok: false, error: "insufficient direct delta" };
    }
    if (dp.channelState.stateExpiry && Number(dp.channelState.stateExpiry) < nowSec()) {
      return { ok: false, error: "state expired" };
    }
    state.set(channelId, { nonce: nextNonce, balB: dp.channelState.balB });
  }

  return { ok: true, paymentId: payload.paymentId, direct: dp };
}

/**
 * Full async verification — ticket + channel proof + hub confirmation.
 * Options: { hub, payee, amount, hubUrl, httpClient, invoiceStore, seenPayments, directChannels }
 */
async function verifyPaymentFull(header, options) {
  const payload = parsePaymentHeader(header);
  if (!payload) return { ok: false, error: "missing or invalid header" };

  // Direct route
  if (payload.scheme === "statechannel-direct-v1") {
    const result = verifyDirectPayment(header, options, options.directChannels);
    if (!result.ok) return result;
    if (!hasInvoice(options.invoiceStore, payload.invoiceId, result.direct)) {
      return { ok: false, error: "unknown invoice" };
    }
    const seen = options.seenPayments;
    if (seen && seen.has(result.paymentId)) {
      return { ok: true, replayed: true, paymentId: result.paymentId, direct: result.direct, response: seen.get(result.paymentId) };
    }
    return { ok: true, replayed: false, paymentId: result.paymentId, direct: result.direct, scheme: "direct" };
  }

  // Hub route — ticket + channel proof
  if (payload.scheme && payload.scheme !== "statechannel-hub-v1") {
    return { ok: false, error: "wrong scheme" };
  }
  let hub = options.hub;
  if (!hub && options.hubUrl && options.httpClient) {
    const info = await options.httpClient.request("GET", `${options.hubUrl}/.well-known/x402`);
    if (info.statusCode !== 200 || !info.body.address) return { ok: false, error: "hub metadata unavailable" };
    hub = info.body.address;
  }

  const result = verifyPayment(header, { hub, payee: options.payee, amount: options.amount });
  if (!result.ok) return result;

  if (!hasInvoice(options.invoiceStore, result.ticket.invoiceId, result.ticket)) {
    return { ok: false, error: "unknown invoice" };
  }

  const seen = options.seenPayments;
  if (seen && seen.has(result.paymentId)) {
    return { ok: true, replayed: true, paymentId: result.paymentId, ticket: result.ticket, response: seen.get(result.paymentId) };
  }

  // Hub confirmation
  if (options.hubUrl && options.httpClient) {
    const status = await options.httpClient.request("GET", `${options.hubUrl}/v1/payments/${encodeURIComponent(result.paymentId)}`);
    if (status.statusCode !== 200) return { ok: false, error: "hub payment unknown" };
    if (status.body.status !== "issued") return { ok: false, error: "hub payment not issued" };
    if (status.body.ticketId !== result.ticket.ticketId) return { ok: false, error: "ticket id mismatch at hub" };
  }

  return { ok: true, replayed: false, signer: result.signer, ticket: result.ticket, paymentId: result.paymentId, scheme: "hub" };
}

function hasInvoice(invoiceStore, invoiceId, paymentProof) {
  if (!invoiceStore) return true;
  if (typeof invoiceStore === "function") return !!invoiceStore(invoiceId, paymentProof);
  if (invoiceStore instanceof Map) {
    const inv = invoiceStore.get(invoiceId);
    if (!inv) return false;
    if (paymentProof) {
      if (inv.amount && paymentProof.amount !== inv.amount) return false;
      if (inv.asset && String(paymentProof.asset || "").toLowerCase() !== String(inv.asset).toLowerCase()) return false;
    }
    return true;
  }
  if (typeof invoiceStore.has === "function") return invoiceStore.has(invoiceId);
  if (typeof invoiceStore === "object") {
    const inv = invoiceStore[invoiceId];
    if (!inv) return false;
    if (paymentProof) {
      if (inv.amount && paymentProof.amount !== inv.amount) return false;
      if (inv.asset && String(paymentProof.asset || "").toLowerCase() !== String(inv.asset).toLowerCase()) return false;
    }
    return true;
  }
  return false;
}

/**
 * High-level helper for payee handlers.
 * Performs ticket verification + optional replay/invoice checks.
 */
function verifyPaymentSimple(header, options = {}) {
  const out = verifyPayment(header, options);
  if (!out.ok) return { ok: false, status: 402, body: { error: out.error } };

  const { ticket, paymentId } = out;
  const seen = options.seenPayments;
  if (seen && typeof seen.has === "function" && seen.has(paymentId)) {
    return {
      ok: true,
      replayed: true,
      paymentId,
      ticket,
      response: seen.get(paymentId)
    };
  }

  if (!hasInvoice(options.invoiceStore, ticket.invoiceId, ticket)) {
    return { ok: false, status: 402, body: { error: "unknown invoice" } };
  }

  return { ok: true, replayed: false, paymentId, ticket };
}

/**
 * Create a stateful verifier — manages its own replay cache, direct channel state, and HTTP client.
 *
 * Single hub:
 *   const verify = createVerifier({ payee: "0xMyAddr", hubUrl: "http://159.223.150.70/hub/sepolia" });
 *
 * Multiple hubs:
 *   const verify = createVerifier({ payee: "0xMyAddr", hubs: ["http://hub1:4021", "http://hub2:4021"] });
 *
 *   const result = await verify(header, invoiceStore);
 */
function createVerifier({
  payee,
  hubUrl,
  hub,
  hubs,
  confirmHub = true,
  seenPayments: extSeenPayments,
  directChannels: extDirectChannels
} = {}) {
  const { HttpJsonClient } = require("../scp-common/http-client");
  const httpClient = new HttpJsonClient();
  const seenPayments = extSeenPayments || new Map();
  const directChannels = extDirectChannels || new Map();

  // address → url cache for all known hubs
  const hubMap = new Map(); // lowercase address → hubUrl
  if (hub && hubUrl) hubMap.set(hub.toLowerCase(), hubUrl);

  const hubUrls = hubs || (hubUrl ? [hubUrl] : []);

  async function resolveHubs() {
    for (const url of hubUrls) {
      if ([...hubMap.values()].includes(url)) continue;
      try {
        const info = await httpClient.request("GET", `${url}/.well-known/x402`);
        if (info.statusCode === 200 && info.body.address) {
          hubMap.set(info.body.address.toLowerCase(), url);
        }
      } catch (_e) { /* hub unreachable — skip */ }
    }
  }

  const verify = async (header, invoiceStore) => {
    // For direct payments, no hub needed
    const payload = parsePaymentHeader(header);
    if (payload && payload.scheme === "statechannel-direct-v1") {
      return verifyPaymentFull(header, { payee, invoiceStore, seenPayments, directChannels });
    }

    // Resolve hub addresses on first call (or if new hubs added)
    if (hubMap.size < hubUrls.length) await resolveHubs();

    // Try ticket signer against known hubs
    const quickCheck = verifyPayment(header, { payee });
    if (quickCheck.ok && quickCheck.signer) {
      const matchedUrl = hubMap.get(quickCheck.signer.toLowerCase());
      if (matchedUrl) {
        return verifyPaymentFull(header, {
          payee, hub: quickCheck.signer, hubUrl: confirmHub ? matchedUrl : null,
          httpClient, invoiceStore, seenPayments, directChannels
        });
      }
    }

    // Fallback: single hub path (backward compat)
    const fallbackUrl = hubUrls[0];
    const fallbackAddr = hubMap.size === 1 ? [...hubMap.keys()][0] : null;
    return verifyPaymentFull(header, {
      payee, hub: fallbackAddr, hubUrl: confirmHub ? fallbackUrl : null,
      httpClient, invoiceStore, seenPayments, directChannels
    });
  };

  verify.close = () => httpClient.close();
  verify.seenPayments = seenPayments;
  verify.directChannels = directChannels;
  verify.hubMap = hubMap;
  return verify;
}

module.exports = {
  ticketDraftDigest,
  signTicketDraft,
  verifyTicket,
  verifyPayment,
  verifyDirectPayment,
  verifyPaymentFull,
  verifyPaymentSimple,
  createVerifier
};
