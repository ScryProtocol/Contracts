const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

async function main() {
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967 implementation slot
  const impl = await provider.getStorageAt("0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b", slot);
  console.log("Implementation:", impl);
}
main();
