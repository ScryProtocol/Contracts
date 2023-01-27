const { GoogleSpreadsheet } = require('google-spreadsheet');
const fetch = require("node-fetch");
const ethers = require('ethers');
require('dotenv').config()
const ABI = require('./abi/oof.json')
const { Contract, BigNumber } = require("ethers");
var bigInt = require("big-integer");
const { cloudresourcemanager } = require('googleapis/build/src/apis/cloudresourcemanager');

// config go to file later
const rpc = 'https://sepolia.infura.io/v3/6822e4e6edc847829086404ffe6d5b2b'
const pk = process.env.PK
const oofAddress = '0x63622676c54813C952421A3bA24ba6679AC44A4b'
const sheetapi = process.env.SHEETAPI
const sheetid = process.env.SHEETID
const sheettitle = process.env.SHEETTITLE
const GASLIM = process.env.GASLIMIT

// 100 gwei
const GAS_PRICE_MAX = BigNumber.from("10000000000");

const provider = new ethers.providers.JsonRpcProvider(rpc);
const walletWithProvider = new ethers.Wallet(pk, provider);

const oofContract = !!ABI && !!walletWithProvider
    ? new Contract(oofAddress, ABI, walletWithProvider)
    : undefined;

// store the feed inventory
let feedInventory = [];

// storage for last update timestamp
let lastUpdate = {};

// start building inventory
async function startNode() {
    // Initialize the sheet
    const doc = new GoogleSpreadsheet(sheetid);
    await doc.useApiKey(sheetapi);

    await doc.loadInfo(); // loads document properties and worksheets
    const sheet = doc.sheetsByTitle[sheettitle];

    const rows = await sheet.getRows(); // can pass in { limit, offset }

    let i;
    for (i = 0; i < rows.length; i++) {
        let feedname = rows[i]["_rawData"][0]
        let feedid = rows[i]["_rawData"][1]
        let endpoint = rows[i]["_rawData"][2]
        let freq = rows[i]["_rawData"][3]
        let decimals = rows[i]["_rawData"][4]
        let parser = rows[i]["_rawData"][5]
        let parsingargs = []

        if (feedname === "Oracle Address") continue;
        if (feedname === "Feed Name") continue;

        try {
            parsingargs = parser.split(",");
        } catch { }

        let tempInv = {
            "feedName": feedname,
            "feedId": feedid,
            "endpoint": endpoint,
            "frequency": freq,
            "decimals": decimals,
            "parsingargs": parsingargs
        }

        // process into global feed array
        feedInventory.push(tempInv)
        lastUpdate[feedid] = 0;
    }

    // process first time then every hour
    await processFeeds(feedInventory)
    setInterval(processFeeds, 3600 * 1000, feedInventory);
}


async function wait(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

async function processFeeds(feedInput) {

    let feedIdArray = []
    let feedValueArray = []

    let i;
    console.log("checking feed APIs")

    for (i = 0; i < feedInput.length; i++) {

        // only update when needed
        if (lastUpdate[feedInput[i]["feedId"]] + parseInt(feedInput[i]["frequency"]) * 1000 <= Date.now() + 600 * 1000) {
            try {
                console.log("Feed ID: " + i)
                console.log(feedInput[i]["endpoint"])
                const res = await fetch(feedInput[i]["endpoint"]);
                const body = await res.json();

                let j;
                let toParse = body;
                for (j = 0; j < feedInput[i]["parsingargs"].length; j++) {
                    toParse = toParse[feedInput[i]["parsingargs"][j]]
                }
                console.log(toParse)
                if (toParse != "") {
                    if (feedInput[i]["feedName"] == "ETHHASH" || feedInput[i]["feedName"] == "ETHBLOCK" ) {
                        toParse = toParse.substring(2)
                        console.log(toParse)
                        console.log(feedInput[i]["feedName"])
                        toParse = new bigInt(toParse, 16).toLocaleString('fullwide', { useGrouping: false });
                    }
                    else {
                        toParse = parseFloat(toParse) * (10 ** feedInput[i]["decimals"])
                        console.log(Math.round(toParse).toLocaleString('fullwide', { useGrouping: false }))
                        toParse = Math.round(toParse).toLocaleString('fullwide', { useGrouping: false })
                    }

                    console.log("Submitting " + toParse)

                    // push values
                    feedIdArray.push(feedInput[i]["feedId"])
                    feedValueArray.push(toParse)

                    // set new update timestamp
                    lastUpdate[feedInput[i]["feedId"]] = Date.now()
                }
                else { console.log("Alert: NaN returned") }
            } catch (e) {
                console.log(e)
            }
        }


    }

    // get nonce
    let nonce = await walletWithProvider.getTransactionCount();
    let gasPrice = await provider.getGasPrice()

    if (gasPrice.gt(GAS_PRICE_MAX)) {
        gasPrice = GAS_PRICE_MAX
    }

    let tx_obk = {
        nonce: nonce,
        gasLimit: GASLIM,
        gasPrice: gasPrice
    }

    if (sheettitle === "Polygon") {
        tx_obk = {
            nonce: nonce,
            gasLimit: GASLIM,
            gasPrice: gasPrice
        }
    }

    //start web 3 call
    console.log("submitting with gas price: " + ethers.utils.formatUnits(gasPrice, "gwei") + " gwei")
    console.log('submitting feeds...')
    let tx;
    try {
        // submit transaction first time
        tx = await oofContract.submitFeed(feedIdArray, feedValueArray, tx_obk)
        console.log("submitted feed ids: " + feedIdArray + "with values: " + feedValueArray + " at " + Date.now())
        console.log("Transaction hash: " + tx.hash)

        // check if still pending after 5 minutes
        while (true) {
            await wait(5 * 60 * 1000);
            let txi = await provider.getTransaction(tx.hash)

            console.log("Checking tx after 5 minutes at " + Date.now())

            // if the tx is not confirmed
            if (txi.confirmations === 0) {
                let newGasPrice = await provider.getGasPrice()
                console.log("Current gas price: " + ethers.utils.formatUnits(newGasPrice, "gwei") + " gwei")

                // check if new gas price smaller than old one
                if (newGasPrice.lte(gasPrice)) {
                    console.log("Old gas price higher than current increasing new one")
                    newGasPrice = gasPrice.add(ethers.utils.parseUnits("1", "gwei"))
                }

                let tx_obi = {
                    nonce: nonce,
                    gasLimit: GASLIM,
                    gasPrice: newGasPrice
                }

                if (sheettitle === "Polygon") {
                    tx_obi = {
                        nonce: nonce,
                        gasLimit: GASLIM,
                        gasPrice: newGasPrice
                    }
                }

                gasPrice = newGasPrice;

                if (gasPrice.gt(GAS_PRICE_MAX)) {
                    gasPrice = GAS_PRICE_MAX
                }

                try {
                    tx = await oofContract.submitFeed(feedIdArray, feedValueArray, tx_obi)
                    console.log("resend transaction")
                    console.log("Resending with gas price: " + ethers.utils.formatUnits(newGasPrice, "gwei") + " gwei")
                    console.log("submitted feed ids: " + feedIdArray + "with values: " + feedValueArray + " at " + Date.now())
                } catch (e) {
                    console.log("Error while resending:")
                    console.log(e)
                    break;
                }
            }
            else {
                console.log("Transaction mined!")
                break;
            }
        }

        console.log("Transaction loop for tx: " + tx.hash + " exited")

    } catch (e) {
        console.log(e)
    }
}

// starts the node script
startNode()

