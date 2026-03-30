const { ethers } = require("ethers");
const fs = require("fs");

const wallet = ethers.Wallet.createRandom();
console.log("New Wallet Address:", wallet.address);
console.log("New Wallet Private Key:", wallet.privateKey);

fs.writeFileSync("new_wallet.json", JSON.stringify({
  address: wallet.address,
  privateKey: wallet.privateKey
}, null, 2));
console.log("Saved to new_wallet.json");
