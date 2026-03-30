/* eslint-disable no-console */
const { ethers } = require("ethers");
const { createPayeeServer } = require("../payee-server");
const { resolveAsset, resolveHubEndpointForNetwork } = require("../../scp-common/networks");

const BASE_CHAIN_ID = 8453;
const BASE_NETWORK = `eip155:${BASE_CHAIN_ID}`;
const BASE_ETH_ASSET = resolveAsset(BASE_CHAIN_ID, "eth").address;
const BASE_USDC_ASSET = resolveAsset(BASE_CHAIN_ID, "usdc").address;

const DEFAULT_HOST = process.env.PAYEE_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PAYEE_PORT || 4091);
const DEFAULT_HUB_URL = process.env.HUB_URL || resolveHubEndpointForNetwork(BASE_NETWORK);
const DEFAULT_HUB_NAME = process.env.HUB_NAME || "pay.eth";
const DEFAULT_RESOURCE_PATH = process.env.BASE_API_PATH || "/v1/base";
const DEFAULT_PRICE_ETH = String(process.env.BASE_API_PRICE_ETH || "1000000000000").trim();
const DEFAULT_PRICE_USDC = String(process.env.BASE_API_PRICE_USDC || "10000").trim();
const DEFAULT_USDC_ASSET = String(process.env.BASE_API_USDC_ASSET || BASE_USDC_ASSET).trim();
const DEFAULT_ETH_ASSET = String(process.env.BASE_API_ETH_ASSET || BASE_ETH_ASSET).trim();

function buildBaseApiRoutes(options = {}) {
  const routePath = options.resourcePath || DEFAULT_RESOURCE_PATH;
  const hubUrl = options.hubUrl || DEFAULT_HUB_URL;
  const hubName = options.hubName || DEFAULT_HUB_NAME;
  const ethAsset = options.ethAsset || DEFAULT_ETH_ASSET;
  const usdcAsset = options.usdcAsset || DEFAULT_USDC_ASSET;
  const ethPrice = String(options.ethPrice || DEFAULT_PRICE_ETH).trim();
  const usdcPrice = String(options.usdcPrice || DEFAULT_PRICE_USDC).trim();

  return {
    [routePath]: {
      accepts: [
        {
          network: BASE_NETWORK,
          asset: ethers.utils.getAddress(ethAsset),
          hub: hubUrl,
          hubName,
          price: ethPrice
        },
        {
          network: BASE_NETWORK,
          asset: ethers.utils.getAddress(usdcAsset),
          hub: hubUrl,
          hubName,
          price: usdcPrice
        }
      ]
    }
  };
}

function createBaseApiServer(options = {}) {
  const resourcePath = options.resourcePath || DEFAULT_RESOURCE_PATH;
  const hubUrl = options.hubUrl || DEFAULT_HUB_URL;
  const hubName = options.hubName || DEFAULT_HUB_NAME;
  const routes = options.routes || buildBaseApiRoutes({
    resourcePath,
    hubUrl,
    hubName,
    ethAsset: options.ethAsset,
    usdcAsset: options.usdcAsset,
    ethPrice: options.ethPrice,
    usdcPrice: options.usdcPrice
  });

  return createPayeeServer({
    host: options.host || DEFAULT_HOST,
    port: Number(options.port || DEFAULT_PORT),
    network: options.network || BASE_NETWORK,
    hubUrl,
    hubName,
    resourcePath,
    routes,
    ...options
  });
}

if (require.main === module) {
  const server = createBaseApiServer();
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log(
      `Base API listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}${DEFAULT_RESOURCE_PATH}`
    );
    console.log(`offers: base ETH=${DEFAULT_ETH_ASSET} USDC=${DEFAULT_USDC_ASSET}`);
  });
}

module.exports = {
  BASE_NETWORK,
  BASE_RESOURCE_PATH: DEFAULT_RESOURCE_PATH,
  BASE_ETH_ASSET,
  BASE_USDC_ASSET,
  buildBaseApiRoutes,
  createBaseApiServer
};
