const { ethers } = require("ethers");
const rpc = "https://rpc.sepolia.org";
const provider = new ethers.providers.JsonRpcProvider(rpc);
const contractAddress = "0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b";
const channelAbi = [
  "function getChannel(bytes32 channelId) view returns (tuple(address participantA, address participantB, uint256 totalBalance, uint256 withdrawalA, uint256 withdrawalB, address asset, uint256 lastStateNonce, uint256 timestamp, uint256 timeout, uint8 status))"
];
async function check() {
  const contract = new ethers.Contract(contractAddress, channelAbi, provider);
  const chan = await contract.getChannel("0xd5913b06d1b5c48c0d62c7d3cd6b83f59d820eb43527c478cb57281fc55555c0");
  console.log("Channel totalBalance:", ethers.utils.formatEther(chan.totalBalance));
  console.log("Participant A:", chan.participantA);
  console.log("Participant B:", chan.participantB);
  console.log("Status:", chan.status);
}
check();
