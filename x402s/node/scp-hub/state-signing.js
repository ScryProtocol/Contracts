const { ethers } = require("ethers");
const { resolveNetwork } = require("../scp-common/networks");

const STATE_TYPEHASH = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes(
    "ChannelState(bytes32 channelId,uint64 stateNonce,uint256 balA,uint256 balB,bytes32 locksRoot,uint64 stateExpiry,bytes32 contextHash)"
  )
);

const STATE_TYPES = [
  "bytes32", // STATE_TYPEHASH
  "bytes32", // channelId
  "uint64",  // stateNonce
  "uint256", // balA
  "uint256", // balB
  "bytes32", // locksRoot
  "uint64",  // stateExpiry
  "bytes32"  // contextHash
];

// Build EIP-712 domain separator for a given chainId + contract address
function buildDomainSeparator(chainId, verifyingContract) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("X402StateChannel")),
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("1")),
        chainId,
        verifyingContract
      ]
    )
  );
}

// Cache domain separator per chainId:contract pair
const _domainCache = {};
function getDomainSeparator(chainId, contractAddress) {
  const key = `${chainId}:${contractAddress}`;
  if (!_domainCache[key]) {
    _domainCache[key] = buildDomainSeparator(chainId, contractAddress);
  }
  return _domainCache[key];
}

function resolveChainIdFromEnv() {
  const netInput = process.env.NETWORK;
  if (typeof netInput === "string" && netInput.length > 0) {
    if (netInput.startsWith("eip155:")) {
      const parsed = Number(netInput.split(":")[1]);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } else {
      try {
        return resolveNetwork(netInput).chainId;
      } catch (_e) { /* fall through */ }
    }
  }
  const chain = Number(process.env.CHAIN_ID || 31337);
  if (Number.isInteger(chain) && chain > 0) return chain;
  return 31337;
}

function normalizeContractAddress(contractAddress) {
  try {
    return ethers.utils.getAddress(contractAddress || ethers.constants.AddressZero);
  } catch (_e) {
    return ethers.constants.AddressZero;
  }
}

// Default domain config — set via env or override at call site
let _defaultChainId = resolveChainIdFromEnv();
let _defaultContract = normalizeContractAddress(process.env.CONTRACT_ADDRESS);

function setDomainDefaults(chainId, contractAddress) {
  const parsed = Number(chainId);
  _defaultChainId = Number.isInteger(parsed) && parsed > 0 ? parsed : resolveChainIdFromEnv();
  _defaultContract = normalizeContractAddress(contractAddress);
  // Clear cache for this pair
  const key = `${_defaultChainId}:${_defaultContract}`;
  delete _domainCache[key];
}

function hashChannelState(state, opts = {}) {
  const chainId = opts.chainId || _defaultChainId;
  const contractAddress = opts.contractAddress || _defaultContract;
  const domainSeparator = getDomainSeparator(chainId, contractAddress);

  const structHash = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(STATE_TYPES, [
      STATE_TYPEHASH,
      state.channelId,
      state.stateNonce,
      state.balA,
      state.balB,
      state.locksRoot,
      state.stateExpiry,
      state.contextHash
    ])
  );

  return ethers.utils.keccak256(
    ethers.utils.solidityPack(
      ["bytes1", "bytes1", "bytes32", "bytes32"],
      ["0x19", "0x01", domainSeparator, structHash]
    )
  );
}

async function signChannelState(state, signer, opts = {}) {
  const digest = hashChannelState(state, opts);
  // Sign the raw EIP-712 digest (not eth_sign prefix — already has \x19\x01)
  const signingKey = signer._signingKey ? signer._signingKey() : null;
  if (signingKey) {
    const sig = signingKey.signDigest(digest);
    return ethers.utils.joinSignature(sig);
  }
  // Fallback for RPC/remote signers: use eth_sign which signs the raw digest
  // without adding the personal_sign prefix. signMessage() would add
  // "\x19Ethereum Signed Message:\n32" which breaks EIP-712 verification.
  if (signer.provider && signer.provider.send) {
    const address = await signer.getAddress();
    const rawSig = await signer.provider.send("eth_sign", [address, digest]);
    return rawSig;
  }
  throw new Error(
    "signChannelState: signer has no _signingKey() and no RPC provider. " +
    "Cannot produce valid EIP-712 signatures with signMessage (personal_sign prefix mismatch)."
  );
}

function recoverChannelStateSigner(state, signature, opts = {}) {
  const digest = hashChannelState(state, opts);
  return ethers.utils.recoverAddress(digest, signature);
}

module.exports = {
  hashChannelState,
  signChannelState,
  recoverChannelStateSigner,
  buildDomainSeparator,
  setDomainDefaults,
  STATE_TYPEHASH
};
