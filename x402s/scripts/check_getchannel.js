const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const abi = ["function getChannel(bytes32) external view returns (tuple(address,address,address,uint64,uint64,uint256,bool,uint64,uint64))"];
const contract = new ethers.Contract("0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b", abi, provider);

async function main() {
  try {
    const ch = await contract.getChannel("0x840d6025073caae62d70b66450bebecc404153cadc0fdc2a9a25b36e489437f9");
    console.log("Channel:", ch);
  } catch (err) {
    console.log("Error:", err.message);
  }
}
main();
