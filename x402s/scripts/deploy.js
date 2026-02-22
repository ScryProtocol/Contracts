const { ethers } = require("hardhat");

// Arachnid deterministic deployment proxy (CREATE2 deployer)
const DEFAULT_CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const DEFAULT_SALT_LABEL = "x402s:X402StateChannel:v1";

function resolveSalt(input) {
  const raw = String(input || DEFAULT_SALT_LABEL).trim();
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) {
    return raw;
  }
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(raw));
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const bal = await deployer.getBalance();

  const factoryAddr = ethers.utils.getAddress(
    process.env.CREATE2_FACTORY || DEFAULT_CREATE2_FACTORY
  );
  const salt = resolveSalt(process.env.CREATE2_SALT);

  console.log("Network:", network.name, `(chainId=${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.utils.formatEther(bal), "ETH");
  console.log("CREATE2 factory:", factoryAddr);
  console.log("CREATE2 salt:", salt);

  if (bal.isZero()) {
    console.error("No ETH — fund this wallet first");
    process.exit(1);
  }

  const Hub = await ethers.getContractFactory("X402StateChannel");
  const initCode = Hub.bytecode;
  const initCodeHash = ethers.utils.keccak256(initCode);
  const predicted = ethers.utils.getCreate2Address(factoryAddr, salt, initCodeHash);

  console.log("Predicted address:", predicted);

  const existing = await ethers.provider.getCode(predicted);
  if (existing && existing !== "0x") {
    console.log("Already deployed at predicted address (code exists). Nothing to do.");
    return;
  }

  const factoryCode = await ethers.provider.getCode(factoryAddr);
  if (!factoryCode || factoryCode === "0x") {
    throw new Error(
      `CREATE2 factory not found at ${factoryAddr} on chain ${network.chainId}. ` +
      "Set CREATE2_FACTORY to a deployed factory address on this chain."
    );
  }

  console.log("Deploying X402StateChannel via CREATE2...");
  const deployData = ethers.utils.hexConcat([salt, initCode]);
  const tx = await deployer.sendTransaction({
    to: factoryAddr,
    data: deployData,
    value: 0
  });
  console.log("tx:", tx.hash);
  const rc = await tx.wait(1);
  console.log("mined in block:", rc.blockNumber);
  if (rc.status !== 1) {
    throw new Error("CREATE2 deployment transaction reverted");
  }

  // Some RPCs can briefly lag code availability after tx inclusion.
  let deployedCode = "0x";
  for (let i = 0; i < 10; i++) {
    deployedCode = await ethers.provider.getCode(predicted);
    if (deployedCode && deployedCode !== "0x") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!deployedCode || deployedCode === "0x") {
    throw new Error("CREATE2 deployment transaction mined but target has no code");
  }

  const hub = Hub.attach(predicted);
  const domainSeparator = await hub.DOMAIN_SEPARATOR();
  console.log("X402StateChannel deployed to:", predicted);
  console.log("DOMAIN_SEPARATOR:", domainSeparator);

  const remaining = await deployer.getBalance();
  console.log("Remaining balance:", ethers.utils.formatEther(remaining), "ETH");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
