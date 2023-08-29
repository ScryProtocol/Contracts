# Morpheus
Morpheus' a simple, lightweight and easy to use open source node to use with the Nostradamus contract to automate feed submission for onchain oracles and provide feeds, for collaborative and transparent queries and making feed management easy for users. The node is simple to setup and will run autonomously, pulling from APIs in the dynamically to fill requests and submitting the transactions to update the onchain feeds for any network via customizable RPC. 

## Installation
Use `npm i` to install dependancies. Then you can either deploy the contract directly using hardhat, using the address in the .env after deployment and then using initialize.js to set up the oracle, followed by morpheus.js. You can also just use morpheus.js if do not wish to deploy using your own framework, if no oracles address is set an oracle will be deployed using the preset bytecode automatically.

## Features 
- Deploy your own autonomous oracle infrastructure to ANY EVM network in <60s.
- Support any API endpoint in realtime, allowing requests to be made fully onchain to the oracle fully permissionlessly
- Earn fees from requests for data, only filling requests if profitable
- 1 click deployment and setup. No need for any prereqs just launch out of the box ready to use. No developer experience or technical experience needed.
- Fully custom VRF and proof system with cryptographically secure 256b Hash RanCh VRFs

Nondev focused binaries

Linux
https://github.com/ScryProtocol/Contracts/raw/Scry/morpheus-linux.zip

MacOS
https://github.com/ScryProtocol/Contracts/raw/Scry/morpheus-macos.zip

Windows
https://github.com/ScryProtocol/Contracts/raw/Scry/morpheus-win.exe.zip

## Usage
Simply download the binaries or use the dev repo. Put your private key for your oracle signer in the .env and use morph.js to deploy. If using the binaries

.env
RPC=https://rpc.sepolia.org

OOFAddress=
      
PK=

Set the RPC for any EVM network where your contract is deployed (Goerli).

Set the OOFAddress to the oracle address you deployed. You can leave this empty and the script will deploy a contract for you automatically from the set PK.

Set the PK to your private key for your oracle signer.

For those using the non dev binaries use your prefered terminal such as cmd on windows. Then go to the binary location and do 
morpheus.exe
 or just run it as usual.

Oracles will automatically be deployed, setup and then run autonomously. Make sure to give a little in tokens for gas like ETH. Oracles will refill based on requests.

# Params
-a Used to set the oracle address if already deployed
-r Used to set the RPC for an EVM network
-pk Used to set the PK used for the oracle signer and deployment

Sample
```morpheus -a 0x00f0000000F11a5380Da5A184F0C563B5995fee2 -r https://sepolia.infura.io/v3/6822e4e6edc847829086404ffe6d5b2b -pk 0000000000000000000000000000000000000000000000000000000000```

GL. 
## Docs
https://docs.scry.finance/docs/morpheus/morpehus

## Disclaimer
This program like any software might contain bugs. We are not responsible for any bugs or losses from it's use in any way if you choose to use the node or contracts.
