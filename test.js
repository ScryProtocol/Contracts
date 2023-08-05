const ethers = require('ethers');
require('dotenv').config()
let rpc = process.env.RPC
let contractAddress = process.env.OOFAddress; // replace with your contract address
const ABI = require('./abi/morph.json')
const { Contract, BigNumber } = require("ethers");
let pk = process.env.PK
let contract;
// script.js
const args = process.argv.slice(2);

const flags = {};

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('-')) {
    // If the next argument starts with '-', set the current flag's value to true.
    // Otherwise, set the current flag's value to the next argument's value.
    flags[args[i]] = args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : true;
  }
}

console.log('Parsed flags:', flags);

// Access individual flags like this:
const rpcFlag = flags['-r'];
const aFlag = flags['-a'];
const pkFlag = flags['-pk']; const pFlag = flags['-p']; const endFlag = flags['-end']; const dFlag = flags['-d']; const bFlag = flags['-b'];
let p = 'last'
let b = '10000000000000000'
let d = 0
let end = 'https://api.exchange.coinbase.com/products/ETH-USD/stats/'

if (rpcFlag != null) {
  rpc = rpcFlag
}
if (aFlag != null) {
  contractAddress = aFlag
}
if (pkFlag != null) {
  pk = pkFlag
}
if (pFlag != null) {
  p = pFlag
}
if (bFlag != null) {
  bpk = bFlag
}
if (dFlag != null) {
  d = dFlag
}
if (endFlag != null) {
  end = endFlag
}
const provider = new ethers.providers.JsonRpcProvider(rpc);

const walletWithProvider = new ethers.Wallet(pk, provider);
const oofContract = !!ABI && !!walletWithProvider
  ? new Contract(contractAddress, ABI, walletWithProvider)
  : undefined; let i;
async function sub() {
  const tx = await oofContract.requestFeeds([end], [p], [d], [b], { value: b });
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  console.log("Transaction hash: " + tx.hash);
  await tx.wait();
  console.log(`Transaction confirmed at ${Date.now()}`);
  for (let n = 0; n == 0;) {
    await sleep(10000);
    let t = await oofContract.getFeeds([0])
    console.log('Feed uint value: ', t[0].toString(), 'string value: ', t[5].toString());
    n = t[0].toString()
  }

}
console.log()
sub()