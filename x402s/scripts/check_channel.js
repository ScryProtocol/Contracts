const { ethers } = require("ethers");
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-sepolia-rpc.publicnode.com");
const abi = ["function getChannel(bytes32) external view returns (tuple(address,address,address,uint64,uint64,uint256,bool,uint64,uint64,uint8))"];
const contract = new ethers.Contract("0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b", abi, provider);

const channelId = ethers.utils.keccak256(
  ethers.utils.defaultAbiCoder.encode(
    ["uint256", "address", "address", "address", "address", "bytes32"],
    [
      11155111,
      "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b",
      "0xBb6b15d2059D26C3C3371C3CbA564303558914dD",
      "0x14B214CA36249b516B59401B3b221CB87483b53C",
      "0x0000000000000000000000000000000000000000",
      "0x837b7e5622f708dca768b4d7fef8632a49823576c60e572d206ac7d946e693ca"
    ]
  )
);

async function main() {
  console.log("Channel ID:", channelId);
  const ch = await contract.getChannel(channelId);
  console.log("Channel:", ch);
}
main();
