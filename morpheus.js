const ethers = require('ethers');
require('dotenv').config()
let rpc = process.env.RPC
const fetch = require('node-fetch');
const keccak256 = require('keccak256')
let contractAddress = process.env.OOFAddress; // replace with your contract address
const ABI = require('./abi/morph.json')
const { Contract, BigNumber } = require("ethers");
let feedInventory = [];
// storage for last update timestamp
let lastUpdate = {};
let pk = process.env.PK
let minfee = process.env.MINFEE
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
const pkFlag = flags['-pk'];
if (rpcFlag != null) {
  rpc = rpcFlag
}
if (aFlag != null) {
  contractAddress = aFlag
}
if (pkFlag != null) {
  pk = pkFlag
}
const provider = new ethers.providers.JsonRpcProvider(rpc);

const bc = '0x';
const walletWithProvider = new ethers.Wallet(pk, provider);
//const signers = ['0x00f0000000f11a5380da5a184f0c563b5995fee2'];
const threshold = 1
const { Configuration, OpenAIApi } = require("openai");
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);
async function init() {

  console.log("Deploying your Morpheus contract");
  // Get the ABI (Application Binary Interface) of the contract
  // Replace with the actual ABI of your contract
  const wallet = new ethers.Wallet(pk, provider);
  const signer = wallet.connect(provider);
  const contractFactory = new ethers.ContractFactory(ABI, bc, signer);
  const signers = [wallet.address];
  const deployedContract = await contractFactory.deploy();
  await deployedContract.deployed();

  console.log("Contract address:", deployedContract.address);
  // Create a contract object
  const contract = new ethers.Contract(deployedContract.address, ABI, walletWithProvider);
  try {
    let tx = await contract.initialize(signers, threshold, '0x0000000000000000000000000000000000000000', 0, '0x3c7d411cd262d3Fe4c0432C7412341aFc33efd11');
    const { events, cumulativeGasUsed, gasUsed, transactionHash } = await tx.wait();
    console.log(`Cumulative: ${cumulativeGasUsed.toNumber()}`);
    console.log(`Gas: ${gasUsed.toNumber()}`)
    console.log(`hash: ${transactionHash.toString()}`)
    console.log("oracle ready")
  } catch (e) {
    console.log(e)
  } return deployedContract.address
}
const fs = require('fs');

async function main() {
  if (contractAddress == '') {
    contractAddress = await init();
    // Read the contents of the .env file
    const envContents = fs.readFileSync('./.env', 'utf-8');

    // Replace the OOFAddress value with the new one
    const newEnvContents = envContents.replace(/^OOFAddress=.*$/m, `OOFAddress=${contractAddress}`);

    // Write the updated contents back to the .env file
    fs.writeFileSync('.env', newEnvContents);
    contract = new ethers.Contract(contractAddress, ABI, provider)
    node()
  } else {
    contract = new ethers.Contract(contractAddress, ABI, provider)
    node()
  }
}

async function node() {
  console.log('Watching for requests');
  console.log('address ', contractAddress);
  const oofContract = !!ABI && !!walletWithProvider
    ? new Contract(contractAddress, ABI, walletWithProvider)
    : undefined; let i;
  async function vrfHash(value, feedID, fl) {
    let hash = ethers.utils.keccak256(pk.toString);
    console.log('seed ', hash);
    let hash2
    if (fl == 1) {
      feedID -= 1;
    }
    for (let i = 0; i < 100000 - feedID; i++) {
      hash = ethers.utils.keccak256(hash);
    }
    hash2 = keccak256(hash + value + feedID).toString('hex')
    console.log('VRF seed ', hash);
    let hashBN = ethers.BigNumber.from(hash);
    let uint256 = hashBN
    hash = uint256.toString();
    console.log('seed uint ', hash);
    hashBN = ethers.BigNumber.from('0x' + hash2);
    uint256 = hashBN
    hash2 = uint256.toString()
    console.log('val ', hash2, feedID);
    if (fl == 1) {
      submit(feedID + 1, hash);
    } else {
      submit(feedID, hash2);
    }
  }
  contract.on('feedRequested', (endpoint, endpointp, dc, c, feedId,) => {
    console.log('New feed requested:');
    console.log(`Endpoint: ${endpoint}`);
    console.log(`Endpointp: ${endpointp}`);
    console.log(`Decimal: ${c}`);
    console.log(`Feed ID: ${feedId}`);
    if (endpoint == 'vrf' || endpoint == 'VRF') {
      if (endpointp == 'proof') {
        vrfHash(endpointp, feedId, 1)// code to execute if endpoint is 'vrf' or 'VRF'
      } else {
        vrfHash(endpointp, feedId, 0)// code to execute if endpoint is 'vrf' or 'VRF'
      }
    } else if (endpoint == 'GPT') {
      response3(endpointp, feedId)
    } else if (endpoint == 'XCHAIN') {
      if (endpointp.includes('XBALANCE')) {
        XBALANCE(endpointp, feedId)
      }
      Xchain(endpointp, feedId)
    }

    else {
      let parsingargs = []

      try {
        parsingargs = endpointp.split(",");
      } catch { }

      let tempInv = {
        "feedId": feedId,
        "endpoint": endpoint,
        "dc": dc,
        "c": c,
        "parsingargs": parsingargs
      }

      // process into global feed array
      feedInventory.push(tempInv)
      processFeeds(endpoint, endpointp, parsingargs, feedId, c)
    }
  });
  async function processFeeds(endpoint, endpointp, parsingargs, feedId, c) {
    let i; let feedIdArray = []
    let feedValueArray = []
    console.log("checking feed APIs")
    //for (i = 0; i < feedInventory.length; i++) {
    let res
    let body
    try {
      res = await fetch(endpoint);
      body = await res.json();
      console.log(body)
      let j;
      let toParse = body;
      for (j = 0; j < parsingargs.length; j++) {
        toParse = toParse[parsingargs[j]]
      }
      console.log(toParse)
      if (toParse != "") {
        toParse = parseFloat(toParse) * (10 ** c)
        console.log(Math.round(toParse).toLocaleString('fullwide', { useGrouping: false }))
        toParse = Math.round(toParse).toLocaleString('fullwide', { useGrouping: false })
      }
      console.log("Submitting " + toParse)

      // push values
      feedIdArray.push(feedId)
      feedValueArray.push(toParse)

      // set new update timestamp
      lastUpdate[feedId] = Date.now()
      console.log("Time ", lastUpdate[feedId])

      const provider = new ethers.providers.JsonRpcProvider(rpc);
      const oofAddress = process.env.OOFAddress
      const walletWithProvider = new ethers.Wallet(pk, provider); const oofContract = !!ABI && !!walletWithProvider
        ? new Contract(oofAddress, ABI, walletWithProvider)
        : undefined;
      let nonce = await walletWithProvider.getTransactionCount();
      let gasPrice = await provider.getGasPrice()
      let tx_obk = {

        gasPrice: gasPrice
      }
      async function wait(ms) {
        return new Promise(resolve => {
          setTimeout(resolve, ms);
        });
      } //if (ethers.utils.formatEther(gF) > 0) {
      submit(feedId, toParse, 0)

    }
    catch (error) { console.log('Could not process feed request API ', endpoint, ' path ', endpointp, ' args ', parsingargs, ' feed request ID ', feedId, ' c ', c, error) }
  }

  contract.on('feedSupported', (feedd) => {

    console.log('New feed Support:')
    let feedId = []; feedId[0] = feedd;
    const oofAddress = process.env.OOFAddress

    const walletWithProvider = new ethers.Wallet(pk, provider);
    const oofContract = !!ABI && !!walletWithProvider
      ? new Contract(oofAddress, ABI, walletWithProvider)
      : undefined;

    let tempInv = {
      "feedId": feedId,
      //    "endpoint": endpoint,
      //    "dc": dc,
      //    "c": c,
      //    "parsingargs": parsingargs
    }

    // process into global feed array
    feedInventory.push(tempInv)
    processFds(feedId)
  });
  async function processFds(feedId) {
    const provider = new ethers.providers.JsonRpcProvider(rpc);
    const oofAddress = process.env.OOFAddress
    let feedIdArray = []
    let feedValueArray = []
    const d = await oofContract.getFeeds(feedId)
    let c
    let endpoint
    let endpointp
    // for (i = 0; i < d.length; i++) {
    c = d[2][0]
    endpoint = d[3][0]
    endpointp = d[4][0]
    //}
    console.log(`Endpoint: ${endpoint}`);
    console.log(`Endpointp: ${endpointp}`);
    console.log(`Decimal: ${c}`);
    console.log(`Feed ID: ${feedId}`);
    if (endpoint === 'vrf' || endpoint === 'VRF') {
      if (endpointp == 'proof') {
        vrfHash(endpointp, Number(feedId), 1)// code to execute if endpoint is 'vrf' or 'VRF'
      } else {
        vrfHash(endpointp, Number(feedId), 0)// code to execute if endpoint is 'vrf' or 'VRF'
      }
    } else if (endpoint == 'XCHAIN') {
      if (endpointp.includes('XBALANCE')) {
        XBALANCE(endpointp, feedId)
      }
      Xchain(endpointp, feedId)
    } else {
      let parsingargs = []
      try {
        parsingargs = endpointp.split(",");
      } catch { }
      console.log("checking feed APIs")
      try {
        //for (i = 0; i < feedInventory.length; i++) {
        const res = await fetch(endpoint);
        const body = await res.json();

        console.log(body)
        let j;
        let toParse = body;
        console.log(toParse)
        for (j = 0; j < parsingargs.length; j++) {

          toParse = toParse[parsingargs[j]]
        }
        console.log(toParse)
        if (toParse != "") {
          toParse = parseFloat(toParse) * (10 ** c)
          console.log(Math.round(toParse).toLocaleString('fullwide', { useGrouping: false }))
          toParse = Math.round(toParse).toLocaleString('fullwide', { useGrouping: false })
        }
        console.log("Submitting " + toParse)

        // push values
        feedId = Number(feedId)
        feedIdArray.push(feedId)
        feedValueArray.push(toParse)

        // set new update timestamp
        lastUpdate[feedId] = Date.now()
        console.log("Subm")
        let gasPrice = await provider.getGasPrice()
        let tx_obk = {

          gasPrice: gasPrice
        }
        submit(feedId, toParse, 0)
        // }
        // else {
        // console.log('not profitable')
        // }
      }
      catch (error) { console.log(error, 'Could not process feed request API ', endpoint, ' path ', endpointp, ' args ', parsingargs, ' feed request ID ', Number(feedId), ' c ', c) }
    }
  }
  let txa = []
  async function response3(input, feedID) {
    try {

      let resp = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: input }],
      });
      console.log(resp.data.choices[0].message.content)
      submit(feedID, resp.data.choices[0].message.content)
    } catch (error) {
      console.log('error')
    }
  }
  async function Xchain(input, feedID) {
    // const functionSignature = 'balanceOf(address)';
    // const types = ['address'];
    // const values = ['0x9d31e30003f253563ff108bc60b16fdf2c93abb5'];
    // const encodedData = ethers.utils.defaultAbiCoder.encode(types, values);
    // const functionHash = ethers.utils.id(functionSignature).slice(0, 10);
    // console.log(`Function call: ${functionHash}`);
    // console.log(`Encoded data: ${encodedData}`, input);
    try {
      // Parse the RPC string
      const params = new URLSearchParams(input.split('?').slice(1).join('&'));
      const rpc = params.get('RPC');
      const addrs = params.get('ADDRS');
      let dat = params.get('DATA');
      const flag = params.get('FLAG');
      console.log('rpc', rpc, 't', addrs, dat);
      // Connect to the provider
      let provider;
      provider = new ethers.providers.JsonRpcProvider(rpc);
      if (flag == 1) {
        const functionSig = 'balanceOf(address)';
        const fnHash = ethers.utils.id(functionSig);  // keccak256 hash of function signature
        const functionSelector = fnHash.slice(0, 10);  // first four bytes of hash         
        const types = ['address'];
        const values = [dat];
        const encodedParams = ethers.utils.defaultAbiCoder.encode(types, values);
        // Concatenate function selector and parameters
        const encodedData = functionSelector + encodedParams.slice(2);  // remove '0x' from params
        dat = encodedData
      }

      // Prepare the transaction
      const tx = {
        to: addrs,
        data: dat,
      };
      // Send the transaction and get the response
      let resp = await provider.call(tx);
      if (flag == 1) {
        resp = BigInt(resp).toString();
      }
      console.log(resp)
      submit(feedID, resp)
    }
    catch (error) {
      console.log(error)
    }
  } async function XBALANCE(input, feedID) {
    try {
      // Parse the RPC string
      const params = new URLSearchParams(input.split('?').slice(1).join('&'));
      const rpc = params.get('RPC');
      const addrs = params.get('ADDRS');

      // Connect to the provider
      let provider;
      provider = new ethers.providers.JsonRpcProvider(rpc);
      let resp = await provider.getBalance(addrs);
      resp = BigInt(resp).toString();
      console.log(resp)
      submit(feedID, resp)
    }
    catch (error) {
      console.log(error)
    }
  } function hexToUtf8(hex) {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
      const v = parseInt(hex.substr(i, 2), 16);
      if (v) str += String.fromCharCode(v);
    }
    return (str);
  }

  async function submit(feedId, value, fl) {
    try {
      let valu = BigNumber.from(value)
      val = ''
      if (ethers.utils.isHexString(value)) {
        val = hexToUtf8(val)
      }
    } catch {
      val = value
      value = 88888888
      if (ethers.utils.isHexString(val)) {
        val = hexToUtf8(val)
      }
    }
    if (txa.length == 0 || fl == 1) {
      // If not, add the new feedId and value to the queue
      txa.unshift({ feedId: feedId, value: value });
      const gasPrice = await provider.getGasPrice();
      let tx_obk = { gasPrice };
      let gasLimit = await oofContract.estimateGas.submitFeed(
        [feedId],
        [value],
        [val],
        tx_obk
      )
      gasLimit = gasLimit.add(100000);
      tx_obk = { gasPrice: gasPrice, gasLimit: gasLimit };
      const gasFee = gasLimit.mul(gasPrice);
      let sup = await oofContract.feedSupport(feedId)
      const ethProfit = sup - gasFee;

      console.log('Gas fee:', ethers.utils.formatEther(gasFee.toString()), 'ETH ', ethers.utils.formatUnits(gasPrice, "gwei") + " gwei");
      console.log('Bounty ', ethers.utils.formatEther(sup))
      console.log('ETH Profit', ethers.utils.formatEther(ethProfit.toString()));


      if (ethProfit > 0 && ethProfit >= minfee) {
        console.log(
          "submitting with gas price: " +
          ethers.utils.formatUnits(gasPrice, "gwei") +
          " gwei"
        );
        console.log("submitting feeds...");
        try {
          const tx = await oofContract.submitFeed([feedId], [value], [val], tx_obk);
          console.log(
            `submitted feed id ${feedId} with value ${value} at ${Date.now()}`
          );
          console.log("Transaction hash: " + tx.hash);
          await tx.wait();
          console.log(`Transaction confirmed at ${Date.now()}`);
        } catch (error) { console.log(error) }
        // Remove the processed value from the queue
        txa.shift();
        // Check if there are any values left in the queue
        if (txa.length > 0) {

          // Submit the next value in the queue
          const nextVal = txa[0]; txa.shift();


          submit(nextVal.feedId, nextVal.value, 1);

        }
      } else {
        console.log("not profitable");

        // Remove the processed value from the queue
        txa.shift();
        // Check if there are any values left in the queue
        if (txa.length > 0) {
          // Submit the next value in the queue
          const nextVal = txa[0]; txa.shift();
          await submit(nextVal.feedId, nextVal.value, 1);
        }
      }
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
}
main()