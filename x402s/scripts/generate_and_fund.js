const { ethers } = require("ethers");
async function main() {
  const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
  const funderPk = "e55248855119d2e3213dc3622fc28fe4c58f3c85f4908c3b704169392230b261";
  const funder = new ethers.Wallet(funderPk, provider);
  
  const newWallet = ethers.Wallet.createRandom();
  console.log("==========================================");
  console.log("NEW ADDRESS:   ", newWallet.address);
  console.log("PRIVATE KEY:   ", newWallet.privateKey);
  console.log("==========================================\n");

  console.log("Fund amount: 0.05 Sepolia ETH...");
  const tx = await funder.sendTransaction({
    to: newWallet.address,
    value: ethers.utils.parseEther("0.05")
  });
  console.log("TX Hash:", tx.hash);
  await tx.wait();
  
  const b = await provider.getBalance(newWallet.address);
  console.log("New balance:", ethers.utils.formatEther(b));
}
main();
