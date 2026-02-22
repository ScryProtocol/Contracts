const { ethers } = require("ethers");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function hashAuthBody(body) {
  const canonical = JSON.stringify(canonicalize(body || {}));
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonical));
}

function buildPayeeAuthMessage({ method, path, payee, timestamp, body }) {
  const normMethod = String(method || "").toUpperCase();
  const normPath = String(path || "");
  const normPayee = String(payee || "").toLowerCase();
  const ts = String(timestamp || "");
  const bodyHash = hashAuthBody(body);
  return `x402-scp-payee-auth-v1\n${normMethod}\n${normPath}\n${normPayee}\n${ts}\n${bodyHash}`;
}

async function signPayeeAuth(params, signer) {
  const msg = buildPayeeAuthMessage(params);
  return signer.signMessage(msg);
}

function recoverPayeeAuthSigner({ signature, ...rest }) {
  const msg = buildPayeeAuthMessage(rest);
  return ethers.utils.verifyMessage(msg, signature);
}

module.exports = {
  buildPayeeAuthMessage,
  signPayeeAuth,
  recoverPayeeAuthSigner,
  hashAuthBody
};
