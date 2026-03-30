const { ethers } = require("ethers");

async function main() {
  const funderPk = "e55248855119d2e3213dc3622fc28fe4c58f3c85f4908c3b704169392230b261";
  const targetAddress = "0x8eDC97C55918ec0884b29933ab32B5653B362fA5";
  
  const provider = new ethers.providers.JsonRpcProvider("https://rpc.sepolia.org");
  const funder = new ethers.Wallet(funderPk, provider);
  
  console.log("Funding from:", funder.address);
  
  const balance = await funder.getBalance();
  console.log("Funder balance:", ethers.utils.formatEther(balance), "ETH");
  
  // Send 0.05 ETH
  const fundAmount = ethers.utils.parseEther("0.05"); 
  
  if (balance.lt(fundAmount)) {
    console.error("Insufficient funds in the funder account.");
    return;
  }
  
  console.log(`Sending ${ethers.utils.formatEther(fundAmount)} ETH to ${targetAddress}...`);
  
  const tx = await funder.sendTransaction({
    to: targetAddress,
    value: fundAmount
  });
  
  console.log("Transaction hash:", tx.hash);
  console.log("Waiting for confirmation...");
  await tx.wait();
  console.log("Transaction confirmed!");
  
  const newBalance = await provider.getBalance(targetAddress);
  console.log("New wallet balance:", ethers.utils.formatEther(newBalance), "ETH");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
