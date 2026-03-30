const path = require("path");
const ganache = require("ganache-core");
const { ethers } = require("ethers");

const X402_ARTIFACT = require(path.resolve(
  __dirname,
  "../../artifacts/contracts/X402StateChannel.sol/X402StateChannel.json"
));

function localAccount(label, secretKey, balanceEth = "100") {
  return {
    label,
    secretKey,
    balance: ethers.utils.parseEther(String(balanceEth)).toHexString()
  };
}

async function startLocalChain({ port = 0, chainId = 8453, accounts = [] } = {}) {
  const server = ganache.server({
    chainId,
    network_id: chainId,
    gasLimit: 12_000_000,
    vmErrorsOnRPCResponse: true,
    accounts: accounts.map((account) => ({
      secretKey: account.secretKey,
      balance: account.balance
    }))
  });

  await new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
  });

  const rpcPort = server.address().port;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);
  const wallets = {};
  for (const account of accounts) {
    wallets[account.label] = new ethers.Wallet(account.secretKey, provider);
  }

  return {
    chainId: actualChainId,
    rpcUrl,
    provider,
    wallets,
    async deploy(deployer) {
      const factory = new ethers.ContractFactory(X402_ARTIFACT.abi, X402_ARTIFACT.bytecode, deployer);
      const contract = await factory.deploy();
      await contract.deployTransaction.wait(1);
      return contract;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}

module.exports = {
  localAccount,
  startLocalChain
};
