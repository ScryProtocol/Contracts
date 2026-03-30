const { ethers } = require("ethers");

const txData = "0xc7301a7400000000000000000000000014b214ca36249b516b59401b3b221cb87483b53c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009184e72a00000000000000000000000000000000000000000000000000000000000000151800000000000000000000000000000000000000000000000000000000069c824643586da4e528110fb2745da359ef86e92383d5a588752ebdad94c6b57e5e4ecdf0000000000000000000000000000000000000000000000000000000000000000";

// Function signature for openChannel(address,uint256,uint256,uint256,bytes)
// 0xc7301a74 is openChannel(address,uint256,uint256,uint256,bytes)
console.log("Function selector:", txData.slice(0, 10));

const abi = [
  "function openChannel(address payee, uint256 amount, uint256 expiration, uint256 nonce, bytes signature)"
];
const iface = new ethers.utils.Interface(abi);

try {
  const decoded = iface.decodeFunctionData("openChannel", txData);
  console.log("Decoded data:");
  console.log("Payee:", decoded.payee);
  console.log("Amount:", decoded.amount.toString());
  console.log("Expiration:", decoded.expiration.toString());
  console.log("Nonce:", decoded.nonce.toString());
  console.log("Signature:", decoded.signature);
} catch (e) {
  console.error("Failed to decode:", e.message);
}
