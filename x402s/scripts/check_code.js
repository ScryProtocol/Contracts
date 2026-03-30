const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

async function main() {
  const code = await provider.getCode("0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b");
  console.log("Code length:", code.length);
}
main();
