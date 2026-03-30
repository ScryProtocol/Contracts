const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
  // Generate a new random wallet
  const wallet = ethers.Wallet.createRandom();
  console.log("New Wallet Address:", wallet.address);
  console.log("New Wallet Private Key:", wallet.privateKey);

  // Get the first signer (usually the deployer/funder account in Hardhat)
  const [funder] = await ethers.getSigners();
  console.log("Funding from:", funder.address);

  const balance = await funder.getBalance();
  console.log("Funder balance:", ethers.utils.formatEther(balance), "ETH");

  // Amount to fund (e.g., 0.1 ETH)
  const fundAmount = ethers.utils.parseEther("0.1");

  if (balance.lt(fundAmount)) {
    console.error("Insufficient funds in the funder account.");
    return;
  }

  console.log(`Sending ${ethers.utils.formatEther(fundAmount)} ETH to ${wallet.address}...`);

  const tx = await funder.sendTransaction({
    to: wallet.address,
    value: fundAmount
  });

  console.log("Transaction hash:", tx.hash);
  await tx.wait();
  console.log("Transaction confirmed!");

  const newBalance = await ethers.provider.getBalance(wallet.address);
  console.log("New wallet balance:", ethers.utils.formatEther(newBalance), "ETH");
  
  // Save to a file for easy access
  fs.writeFileSync("new_wallet.json", JSON.stringify({
    address: wallet.address,
    privateKey: wallet.privateKey
  }, null, 2));
  console.log("Saved to new_wallet.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
