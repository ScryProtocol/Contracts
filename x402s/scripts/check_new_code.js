const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

async function main() {
  const code = await provider.getCode("0xaE933B1E211BfbE5D4fd830BEAc6825092C2244C");
  console.log("Code length:", code.length);
}
main();
