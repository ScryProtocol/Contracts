const hre = require("hardhat");

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";

async function main() {
  const zone = String(process.env.HEYETH_ZONE || "hey.eth").trim().toLowerCase();
  const nextResolver = hre.ethers.utils.getAddress(
    process.env.HEYETH_RESOLVER_ADDRESS || process.env.RESOLVER_ADDRESS || ""
  );
  const ownerKey = process.env.HEYETH_OWNER_KEY || process.env.OWNER_KEY || "";

  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  const node = hre.ethers.utils.namehash(zone);
  const registry = new hre.ethers.Contract(
    ENS_REGISTRY,
    [
      "function owner(bytes32 node) view returns (address)",
      "function resolver(bytes32 node) view returns (address)",
      "function setResolver(bytes32 node, address resolver)"
    ],
    provider
  );

  const [owner, currentResolver] = await Promise.all([
    registry.owner(node),
    registry.resolver(node)
  ]);

  const iface = new hre.ethers.utils.Interface([
    "function setResolver(bytes32 node, address resolver)"
  ]);
  const calldata = iface.encodeFunctionData("setResolver", [node, nextResolver]);
  const result = {
    zone,
    chainId: network.chainId,
    registry: ENS_REGISTRY,
    node,
    currentOwner: owner,
    currentResolver,
    nextResolver,
    calldata
  };

  if (!ownerKey) {
    result.ready = false;
    result.changed = false;
    result.note = "Owner key not configured. Sign the calldata from currentOwner to finish cutover.";
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const ownerWallet = new hre.ethers.Wallet(ownerKey, provider);
  result.ownerSigner = ownerWallet.address;
  if (ownerWallet.address.toLowerCase() !== owner.toLowerCase()) {
    result.ready = false;
    result.changed = false;
    result.note = "Configured owner key does not match the current ENS owner.";
    console.log(JSON.stringify(result, null, 2));
    process.exit(1);
    return;
  }

  if (currentResolver.toLowerCase() === nextResolver.toLowerCase()) {
    result.ready = true;
    result.changed = false;
    result.note = "Resolver is already set.";
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const tx = await registry.connect(ownerWallet).setResolver(node, nextResolver);
  const receipt = await tx.wait();
  result.ready = true;
  result.changed = true;
  result.txHash = tx.hash;
  result.blockNumber = receipt.blockNumber;
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
