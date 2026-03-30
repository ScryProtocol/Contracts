const { ethers } = require("ethers");

const txData = "0xc7301a7400000000000000000000000014b214ca36249b516b59401b3b221cb87483b53c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009184e72a00000000000000000000000000000000000000000000000000000000000000151800000000000000000000000000000000000000000000000000000000069c824643586da4e528110fb2745da359ef86e92383d5a588752ebdad94c6b57e5e4ecdf0000000000000000000000000000000000000000000000000000000000000000";

const abi = [
  "function openChannel(address payee, address token, uint256 amount, uint256 expiration, bytes signature)"
];
const iface = new ethers.utils.Interface(abi);

try {
  const decoded = iface.decodeFunctionData("openChannel", txData);
  console.log("Decoded data:");
  console.log("Payee:", decoded.payee);
  console.log("Token:", decoded.token);
  console.log("Amount:", decoded.amount.toString());
  console.log("Expiration:", decoded.expiration.toString());
  console.log("Signature:", decoded.signature);
} catch (e) {
  console.error("Failed to decode:", e.message);
}
