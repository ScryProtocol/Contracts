const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers } = require("ethers");

const { startLocalChain, localAccount } = require("./helpers/local-chain");

const MOCK_ERC20_ARTIFACT = require(path.resolve(
  __dirname,
  "../artifacts/contracts/mocks/MockERC20.sol/MockERC20.json"
));

describe("SCP Base API", function () {
  this.timeout(30000);

  const HUB_HOST = "127.0.0.1";
  const HUB_PORT = 4391;
  const API_HOST = "127.0.0.1";
  const API_PORT = 4390;
  const HUB_URL = `http://${HUB_HOST}:${HUB_PORT}`;
  const API_PATH = "/v1/base";
  const API_URL = `http://${API_HOST}:${API_PORT}${API_PATH}`;
  const OFFER_NETWORK = "eip155:8453";
  const STORE_PATH = path.resolve(__dirname, "../node/scp-hub/data/store.base-api-test.json");
  const STATE_ROOT = path.resolve(__dirname, "../node/scp-agent/state/base-api-test");

  const HUB_KEY = "0x59c6995e998f97a5a0044976f5d81f39bcb8c4f7f2d1b6c2c9f6f2c7d4b6f001";
  const PAYEE_KEY = "0x8b3a350cf5c34c9194ca3a545d8048f270f09f626b0f7238f71d0f8f8f005555";
  const TEST_AGENT_KEY = "0x7d577fdd4a1ec2aa00e7cdbf95db7fdbd7a6fd531f4be75f4fca31f6d8b3af88";

  let createHubServer;
  let createBaseApiServer;
  let ScpAgentClient;
  let hubServer;
  let apiServer;
  let chain;
  let contract;
  let usdc;
  let payeeWallet;
  let hubWallet;
  let payerWallet;
  let payeeAddress;

  function reqJson(endpoint) {
    const u = new URL(endpoint);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: "GET",
          hostname: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode,
              body: data ? JSON.parse(data) : {},
              headers: res.headers
            });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  function makeStateDir(label) {
    const dir = path.join(STATE_ROOT, `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function makeAgent(label) {
    const stateDir = makeStateDir(label);
    const agent = new ScpAgentClient({
      privateKey: TEST_AGENT_KEY,
      stateDir,
      networkAllowlist: [OFFER_NETWORK],
      maxFeeDefault: "10000000000",
      maxAmountDefault: "1000000000000000"
    });
    return { agent, stateDir };
  }

  async function openHubChannel(agent, asset, amount) {
    return agent.openChannel(hubWallet.address, {
      rpcUrl: chain.rpcUrl,
      contractAddress: contract.address,
      network: OFFER_NETWORK,
      asset,
      amount,
      hubFlags: 2,
      hubEndpoint: HUB_URL,
      salt: ethers.utils.hexlify(crypto.randomBytes(32))
    });
  }

  before(async function () {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    fs.rmSync(STORE_PATH, { force: true });
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
    fs.mkdirSync(STATE_ROOT, { recursive: true });

    chain = await startLocalChain({
      chainId: 8453,
      accounts: [
        localAccount("hub", HUB_KEY, "100"),
        localAccount("payee", PAYEE_KEY, "100"),
        localAccount("payer", TEST_AGENT_KEY, "100")
      ]
    });
    contract = await chain.deploy(chain.wallets.hub);
    hubWallet = chain.wallets.hub;
    payeeWallet = chain.wallets.payee;
    payerWallet = chain.wallets.payer;
    payeeAddress = payeeWallet.address;

    const tokenFactory = new ethers.ContractFactory(
      MOCK_ERC20_ARTIFACT.abi,
      MOCK_ERC20_ARTIFACT.bytecode,
      payeeWallet
    );
    usdc = await tokenFactory.deploy("Mock USD Coin", "USDC", 6);
    await usdc.deployTransaction.wait(1);
    await (await usdc.mint(payerWallet.address, "50000000")).wait(1);

    process.env.HOST = HUB_HOST;
    process.env.PORT = String(HUB_PORT);
    process.env.STORE_PATH = STORE_PATH;
    process.env.NETWORK = `eip155:${chain.chainId}`;
    process.env.RPC_URL = chain.rpcUrl;
    process.env.CONTRACT_ADDRESS = contract.address;
    process.env.DEFAULT_ASSET = usdc.address;
    process.env.HUB_PRIVATE_KEY = HUB_KEY;
    process.env.HUB_ADMIN_TOKEN = "base-api-test-admin";
    process.env.PAYEE_PRIVATE_KEY = PAYEE_KEY;
    process.env.PAYEE_HOST = API_HOST;
    process.env.PAYEE_PORT = String(API_PORT);
    process.env.HUB_URL = HUB_URL;
    process.env.HUB_NAME = "pay.eth";
    process.env.BASE_API_PATH = API_PATH;
    process.env.BASE_API_USDC_ASSET = usdc.address;
    process.env.BASE_API_ETH_ASSET = ethers.constants.AddressZero;
    process.env.BASE_API_PRICE_ETH = "1000000000000";
    process.env.BASE_API_PRICE_USDC = "10000";
    process.env.PAYEE_ENABLE_DIRECT = "0";

    delete require.cache[require.resolve("../node/scp-hub/server")];
    delete require.cache[require.resolve("../node/scp-demo/base-api/server")];
    delete require.cache[require.resolve("../node/scp-agent/agent-client")];

    ({ createServer: createHubServer } = require("../node/scp-hub/server"));
    ({ createBaseApiServer } = require("../node/scp-demo/base-api/server"));
    ({ ScpAgentClient } = require("../node/scp-agent/agent-client"));

    hubServer = createHubServer();
    apiServer = createBaseApiServer();

    await new Promise((resolve) => hubServer.listen(HUB_PORT, HUB_HOST, resolve));
    await new Promise((resolve) => apiServer.listen(API_PORT, API_HOST, resolve));
  });

  after(async function () {
    if (apiServer) await new Promise((resolve) => apiServer.close(resolve));
    if (hubServer) await new Promise((resolve) => hubServer.close(resolve));
    if (chain) await chain.close();
    fs.rmSync(STORE_PATH, { force: true });
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
  });

  it("advertises Base ETH and USDC hub offers", async function () {
    const res = await reqJson(API_URL);
    expect(res.statusCode).to.eq(402);
    expect(res.body.accepts).to.be.an("array");

    const hubOffers = res.body.accepts.filter((offer) => offer.scheme === "statechannel-hub-v1");
    expect(hubOffers.length).to.eq(2);
    expect(hubOffers.every((offer) => offer.network === OFFER_NETWORK)).to.eq(true);

    const ethOffer = hubOffers.find((offer) => offer.asset === ethers.constants.AddressZero);
    const usdcOffer = hubOffers.find(
      (offer) => offer.asset.toLowerCase() === usdc.address.toLowerCase()
    );
    expect(ethOffer, "missing ETH offer").to.exist;
    expect(usdcOffer, "missing USDC offer").to.exist;
    expect(ethOffer.maxAmountRequired).to.eq("1000000000000");
    expect(usdcOffer.maxAmountRequired).to.eq("10000");
  });

  it("accepts a Base ETH SCP payment", async function () {
    const { agent, stateDir } = await makeAgent("eth");
    try {
      await openHubChannel(agent, ethers.constants.AddressZero, "100000000000000");
      const result = await agent.payResource(API_URL, {
        asset: ethers.constants.AddressZero
      });
      expect(result.route).to.eq("hub");
      expect(result.offer.asset).to.eq(ethers.constants.AddressZero);
      expect(result.response.ok).to.eq(true);
      expect(result.response.receipt).to.have.property("paymentId");
    } finally {
      agent.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts a Base USDC SCP payment", async function () {
    const { agent, stateDir } = await makeAgent("usdc");
    try {
      await openHubChannel(agent, usdc.address, "1000000");
      const result = await agent.payResource(API_URL, {
        asset: usdc.address
      });
      expect(result.route).to.eq("hub");
      expect(result.offer.asset.toLowerCase()).to.eq(usdc.address.toLowerCase());
      expect(result.response.ok).to.eq(true);
      expect(result.response.receipt).to.have.property("paymentId");
    } finally {
      agent.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
