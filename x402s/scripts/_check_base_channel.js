const { ethers } = require("ethers");

// Connect to the Ethereum mainnet (ENS is on mainnet)
const provider = new ethers.providers.JsonRpcProvider("https://ethereum-rpc.publicnode.com");

async function resolveENS(name) {
    const address = await provider.resolveName(name);
    if (address) {
        console.log(`The address for ${name} is: ${address}`);
    } else {
        console.log(`${name} does not resolve to an address.`);
    }
}

resolveENS("pr0.hey.eth");
