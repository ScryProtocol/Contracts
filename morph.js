const ethers = require('ethers');
require('dotenv').config()
const rpc = process.env.RPC
const fetch = require('node-fetch');
const keccak256 = require('keccak256')
const contractAddress = process.env.OOFAddress; // replace with your contract address
const ABI = [{ "inputs": [], "stateMutability": "nonpayable", "type": "constructor" }, { "anonymous": false, "inputs": [{ "indexed": true, "internalType": "uint256", "name": "betId", "type": "uint256" }, { "indexed": true, "internalType": "address", "name": "player", "type": "address" }, { "indexed": false, "internalType": "uint256", "name": "amount", "type": "uint256" }, { "indexed": false, "internalType": "uint256", "name": "playerRoll", "type": "uint256" }, { "indexed": false, "internalType": "string", "name": "salt", "type": "string" }], "name": "BetPlaced", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": true, "internalType": "uint256", "name": "betId", "type": "uint256" }, { "indexed": false, "internalType": "uint256", "name": "playRoll", "type": "uint256" }, { "indexed": false, "internalType": "bool", "name": "won", "type": "bool" }], "name": "BetSettled", "type": "event" }, { "anonymous": false, "inputs": [{ "indexed": true, "internalType": "address", "name": "previousOwner", "type": "address" }, { "indexed": true, "internalType": "address", "name": "newOwner", "type": "address" }], "name": "OwnershipTransferred", "type": "event" }, { "inputs": [], "name": "a", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "betAmount", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "name": "bets", "outputs": [{ "internalType": "address", "name": "player", "type": "address" }, { "internalType": "uint256", "name": "amount", "type": "uint256" }, { "internalType": "string", "name": "salt", "type": "string" }, { "internalType": "uint256", "name": "playerRoll", "type": "uint256" }, { "internalType": "uint256", "name": "playRoll", "type": "uint256" }, { "internalType": "bool", "name": "settled", "type": "bool" }, { "internalType": "bool", "name": "won", "type": "bool" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "hash", "outputs": [{ "internalType": "bytes32", "name": "", "type": "bytes32" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "maxRoll", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "minRoll", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "nextBetId", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "owner", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "lev", "type": "uint256" }, { "internalType": "string", "name": "salt", "type": "string" }], "name": "placeBet", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "payable", "type": "function" }, { "inputs": [{ "internalType": "bytes32", "name": "roll", "type": "bytes32" }, { "internalType": "string", "name": "salt", "type": "string" }], "name": "randomRoll", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [], "name": "renounceOwnership", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "newBetAmount", "type": "uint256" }], "name": "setBetAmount", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "bytes32", "name": "playRoll", "type": "bytes32" }], "name": "submitRoll", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [], "name": "total", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }, { "inputs": [{ "internalType": "address", "name": "newOwner", "type": "address" }], "name": "transferOwnership", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "betId", "type": "uint256" }], "name": "withdraw", "outputs": [], "stateMutability": "nonpayable", "type": "function" }, { "inputs": [{ "internalType": "uint256", "name": "amount", "type": "uint256" }], "name": "withdrawHouse", "outputs": [], "stateMutability": "nonpayable", "type": "function" }]
const { Contract, BigNumber } = require("ethers");
var bigInt = require("big-integer");// store the feed inventory
let feedInventory = [];
// storage for last update timestamp
let lastUpdate = {};
const pk = process.env.PK
const provider = new ethers.providers.JsonRpcProvider(rpc);
const contract = new ethers.Contract(contractAddress, ABI, provider);
console.log('New'); const walletWithProvider = new ethers.Wallet(pk, provider); const oofContract = !!ABI && !!walletWithProvider
  ? new Contract(contractAddress, ABI, walletWithProvider)
  : undefined; let i;
async function vrfHash(value, feedID) {
  let hash = ethers.utils.keccak256(pk.toString);
  console.log('seed ', hash);
  for (let i = 0; i < 100000 - feedID; i++) {
    hash = ethers.utils.keccak256(hash);
  }
  console.log('VRF seed ', hash);

  submit(feedID, hash,0,0);
}
contract.on('BetPlaced', (id, endpointp, dc, c, sa) => {
  console.log('New feed requested:');
  console.log(`i: ${id}`);
  console.log(`Feed ID: ${sa}`);

  vrfHash(sa, id)// code to execute if endpoint is 'vrf' or 'VRF'

}); let txa = []
async function submit(feedId, value, fl,gasPrc) {
  let tx
  let gasPrice
  async function checkTransactionStatus() {
    const receipt = await provider.getTransactionReceipt(tx.hash);

    if (receipt === null) {
      console.log(`Transaction not mined yet, checking again in 15 seconds...`);
      setTimeout(checkTransactionStatus, POLL_INTERVAL);
    } else {
      console.log("Transaction mined, continuing...");
      await tx.wait();
      txa.shift();
      console.log("Transaction confirmed");

      if (txa.length > 0) {
        const nextVal = txa[0];
        txa.shift();
        submit(nextVal.feedId, nextVal.value, 1);
      }
    }
  }
  if (txa.length == 0 || fl == 1) {
    // If not, add the new feedId and value to the queue
    txa.unshift({ feedId: feedId, value: value });

    console.log("submitting feeds...");
    let gasPrice = await provider.getGasPrice()
    if (ethers.utils.formatEther(gasPrice) <= ethers.utils.formatEther(gasPrc)) {
      gasPrice=Number(ethers.utils.formatEther(gasPrc)) + .0000002
      gasPrice=ethers.utils.parseEther(gasPrice)
      
    } if(ethers.utils.formatEther(gasPrice) >= .0000002) {
      gasPrice= '200000000000'
    }
    let tx_obk = {
      gasPrice: gasPrice
    }
    tx = await oofContract.submitRoll(value, tx_obk);
    console.log(
      `submitted with ${gasPrice}`
    );
    console.log(
      `submitted with value ${value} at ${Date.now()}`
    );
    console.log("Transaction hash: " + tx.hash);
    setTimeout(checkTransactionStatus, 10000);
  } else {
    // If not, add the new feedId and value to the queue
    if (txa.some((item) => item.feedId === feedId && item.value === value)) {
      console.log(`Feed id ${feedId} with value ${value} already in queue`);
    } else {
      txa.push({ feedId: feedId, value: value });
    }
    console.log(`Added feed id ${feedId} with value ${value} to queue`);
  }
}
//vrfHash(0, 5)