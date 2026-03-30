const { ethers } = require("ethers");

async function main() {
  const funderPk = "8875568F529BBA388542EA5D0E1D524D09DA520AEDFBF2CD20553BBB687D4D09";
  const targetAddress = "0x63cde70c1aaf43ad9481f78aa1a5d3b9e5faa33a";
  
  // Use a different RPC provider in case the default one is rate limited or slow
  const provider = new ethers.providers.JsonRpcProvider("https://mainnet.base.org");
  const funder = new ethers.Wallet(funderPk, provider);
  
  console.log("Funding from:", funder.address);
  
  const balance = await funder.getBalance();
  console.log("Funder balance:", ethers.utils.formatEther(balance), "ETH");
  
  // Send 0.05 ETH
  const fundAmount = ethers.utils.parseEther("0.001"); 
  
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
