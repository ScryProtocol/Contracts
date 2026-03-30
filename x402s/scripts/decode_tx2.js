const { ethers } = require("ethers");

const txData = "0xc7301a7400000000000000000000000014b214ca36249b516b59401b3b221cb87483b53c0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009184e72a00000000000000000000000000000000000000000000000000000000000000151800000000000000000000000000000000000000000000000000000000069c824643586da4e528110fb2745da359ef86e92383d5a588752ebdad94c6b57e5e4ecdf0000000000000000000000000000000000000000000000000000000000000000";

// Let's try to decode it manually
console.log("Function selector:", txData.slice(0, 10));
console.log("Arg 1 (address):", "0x" + txData.slice(10, 74).replace(/^0+/, ''));
console.log("Arg 2 (uint256):", ethers.BigNumber.from("0x" + txData.slice(74, 138)).toString());
console.log("Arg 3 (uint256):", ethers.BigNumber.from("0x" + txData.slice(138, 202)).toString());
console.log("Arg 4 (uint256):", ethers.BigNumber.from("0x" + txData.slice(202, 266)).toString());
console.log("Arg 5 (bytes32):", "0x" + txData.slice(266, 330));
console.log("Arg 6 (bytes32):", "0x" + txData.slice(330, 394));
