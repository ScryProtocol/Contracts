const { ethers } = require("ethers");

const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const ZONE = (process.env.HEYETH_ZONE || "hey.eth").trim().toLowerCase();
const CHECK_HANDLE = (process.env.HEYETH_CHECK_HANDLE || "pr0").trim().toLowerCase();
const RPC_URL =
  process.env.MAINNET_RPC || process.env.ENS_RPC_URL || "https://ethereum.publicnode.com";

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const registry = new ethers.Contract(
    ENS_REGISTRY,
    [
      "function owner(bytes32 node) view returns (address)",
      "function resolver(bytes32 node) view returns (address)"
    ],
    provider
  );

  const zoneNode = ethers.utils.namehash(ZONE);
  const [owner, resolver] = await Promise.all([
    registry.owner(zoneNode),
    registry.resolver(zoneNode)
  ]);

  let resolverSupportsExtended = false;
  let zoneAddr = ethers.constants.AddressZero;
  if (resolver !== ethers.constants.AddressZero) {
    const resolverContract = new ethers.Contract(
      resolver,
      [
        "function supportsInterface(bytes4 interfaceID) view returns (bool)",
        "function addr(bytes32 node) view returns (address)"
      ],
      provider
    );
    try {
      resolverSupportsExtended = await resolverContract.supportsInterface("0x9061b923");
    } catch (_err) {
      resolverSupportsExtended = false;
    }
    try {
      zoneAddr = await resolverContract.addr(zoneNode);
    } catch (_err) {
      zoneAddr = ethers.constants.AddressZero;
    }
  }

  const zoneResolution = await provider.resolveName(ZONE);
  const handleName = CHECK_HANDLE ? `${CHECK_HANDLE}.${ZONE}` : null;
  const handleResolution = handleName ? await provider.resolveName(handleName) : null;

  console.log(
    JSON.stringify(
      {
        zone: ZONE,
        rpcUrl: RPC_URL,
        node: zoneNode,
        owner,
        resolver,
        resolverSupportsExtended,
        zoneAddr,
        resolveNameZone: zoneResolution,
        checkHandle: handleName,
        resolveNameHandle: handleResolution,
        ccipReady: !!resolverSupportsExtended
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
