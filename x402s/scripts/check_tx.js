const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

async function main() {
  const txHash = "0x594aa608b29ddc7b91ef96738fbfa8690dcb99955e2737fd926abaf87b1b526f";
  const tx = await provider.getTransaction(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  console.log("Status:", receipt.status);
  
  if (receipt.status === 0) {
    try {
      await provider.call(tx, tx.blockNumber);
    } catch (err) {
      console.log("Revert reason:", err.reason || err.message);
    }
  }
}
main();
