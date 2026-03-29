const hre = require("hardhat");

function splitAddresses(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => hre.ethers.utils.getAddress(value));
}

function parseGweiEnv(name) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return undefined;
  return hre.ethers.utils.parseUnits(raw, "gwei");
}

async function main() {
  const gatewayUrl = String(
    process.env.HEYETH_GATEWAY_URL || "https://statechannel.org/heyeth/ccip"
  ).trim();
  const signers = splitAddresses(process.env.HEYETH_SIGNER_ADDRESSES);
  const maxFeePerGas = parseGweiEnv("HEYETH_MAX_FEE_GWEI");
  const maxPriorityFeePerGas = parseGweiEnv("HEYETH_MAX_PRIORITY_FEE_GWEI");
  const gasLimit = String(process.env.HEYETH_GAS_LIMIT || "").trim();

  if (!signers.length) {
    const privateKey =
      process.env.HEYETH_GATEWAY_SIGNER_PRIVATE_KEY || process.env.GATEWAY_SIGNER_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error(
        "Provide HEYETH_SIGNER_ADDRESSES or HEYETH_GATEWAY_SIGNER_PRIVATE_KEY/GATEWAY_SIGNER_PRIVATE_KEY"
      );
    }
    signers.push(new hre.ethers.Wallet(privateKey).address);
  }

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const factory = await hre.ethers.getContractFactory("OffchainResolver");
  const overrides = {};
  if (maxFeePerGas) overrides.maxFeePerGas = maxFeePerGas;
  if (maxPriorityFeePerGas) overrides.maxPriorityFeePerGas = maxPriorityFeePerGas;
  if (gasLimit) overrides.gasLimit = hre.ethers.BigNumber.from(gasLimit);
  const resolver = await factory.deploy(gatewayUrl, signers, overrides);
  await resolver.deployed();

  const tx = resolver.deployTransaction;

  console.log(
    JSON.stringify(
      {
        zone: process.env.HEYETH_ZONE || "hey.eth",
        chainId: network.chainId,
        deployer: deployer.address,
        gatewayUrl,
        signers,
        resolver: resolver.address,
        txHash: tx.hash,
        gasLimit: tx.gasLimit ? tx.gasLimit.toString() : null,
        maxFeePerGasGwei: tx.maxFeePerGas
          ? hre.ethers.utils.formatUnits(tx.maxFeePerGas, "gwei")
          : null,
        maxPriorityFeePerGasGwei: tx.maxPriorityFeePerGas
          ? hre.ethers.utils.formatUnits(tx.maxPriorityFeePerGas, "gwei")
          : null
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
