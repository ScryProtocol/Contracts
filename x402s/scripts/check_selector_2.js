const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");

async function main() {
  const code = await provider.getCode("0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b");
  const sel = ethers.utils.id("getChannelsByParticipant(address)").slice(2, 10);
  console.log("getChannelsByParticipant selector:", sel);
  console.log("Has getChannelsByParticipant?", code.includes(sel));
}
main();
