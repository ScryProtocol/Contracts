const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

async function main() {
  const code = await provider.getCode("0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b");
  console.log("Has c7301a74?", code.includes("c7301a74"));
  
  // Let's also check the old openChannel selector
  // openChannel(address,address,uint256,uint64,uint64,bytes32,uint8)
  const oldSelector = ethers.utils.id("openChannel(address,address,uint256,uint64,uint64,bytes32,uint8)").slice(2, 10);
  console.log("Old selector:", oldSelector);
  console.log("Has old selector?", code.includes(oldSelector));
}
main();
