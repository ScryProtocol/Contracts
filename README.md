# Morpheus
Morpheus' a simple, lightweight and easy to use open source node to use with the Nostradamus contract to automate feed submission for onchain oracles and provide feeds, for collaborative and transparent queries and making feed management easy for users. The node is simple to setup and will run autonomously, pulling from APIs in the dynamically to fill requests and submitting the transactions to update the onchain feeds for any network via customizable RPC. 



## Installation
Use `npm i` to install dependancies. Then you can either deploy the contract directly using hardhat, using the address in the .env after deployment and then using initialize.js to set up the oracle, followed by morpheus.js. You can also just use morpheus.js if do not wish to deploy using your own framework, if no oracles address is set an oracle will be deployed using the preset bytecode automatically.
## Feeds Setup
Feeds can be created and setup based on the linked spreadhsheet by simply running
setup.js
which will then check and if needed create the feeds in the Oracle Feeds struct

Sample Spreadsheet template to fork
https://docs.google.com/spreadsheets/d/1syqS8Gpl7ZS9UC_Wr6giY057XebJu3bZKXhIDsN-DJ0

## Disclaimer
This program like any software might contain bugs. We are not responsible for any bugs or losses from it's use in any way if you choose to use the node or contracts.
