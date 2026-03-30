const { ethers } = require("hardhat");

async function main() {
  const factoryAddr = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
  const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("x402s:X402StateChannel:v1"));
  const Hub = await ethers.getContractFactory("X402StateChannel");
  const initCodeHash = ethers.utils.keccak256(Hub.bytecode);
  const predicted = ethers.utils.getCreate2Address(factoryAddr, salt, initCodeHash);
  console.log("Predicted address:", predicted);
}
main();
