const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

async function main() {
  const code = await provider.getCode("0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b");
  const sel = ethers.utils.id("openChannel(address,address,uint256,uint64,uint64,bytes32,uint8)").slice(2, 10);
  console.log("openChannel(address,address,uint256,uint64,uint64,bytes32,uint8) selector:", sel);
  console.log("Has v1 openChannel?", code.includes(sel));
}
main();
