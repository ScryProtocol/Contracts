const hre = require("hardhat");

async function main() {
  const txHash = "0x9e1bb92a91142283e335505f296b61975076caadc5ed780942550665f788ccc0";
  const tx = await hre.ethers.provider.getTransaction(txHash);
  console.log("Transaction:", tx);
  const receipt = await hre.ethers.provider.getTransactionReceipt(txHash);
  console.log("Receipt:", receipt);
  
  if (tx && tx.to) {
    const code = await hre.ethers.provider.getCode(tx.to);
    console.log("Contract code at", tx.to, ":", code.length > 2 ? "Exists" : "Empty");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
