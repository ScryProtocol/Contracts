const fs = require('fs');
let code = fs.readFileSync('/root/x402s/node/scp-hub/server.js', 'utf8');

// Add /v1/channels/lookup?payer= endpoint before the payee/inbox endpoint
const anchor = `    if (req.method === "GET" && pathname === "/v1/payee/inbox") {`;

const newEndpoint = `    if (req.method === "GET" && pathname === "/v1/channels/lookup") {
      const { query } = url.parse(req.url, true);
      const payer = query && query.payer;
      if (!payer || !/^0x[a-fA-F0-9]{40}$/.test(payer)) {
        return sendJson(res, 400, makeError("SCP_009_POLICY_VIOLATION", "payer query must be 0x address"));
      }
      const hubSigner = getHubSigner();
      if (!hubSigner || !CONTRACT_ADDRESS) {
        return sendJson(res, 503, makeError("SCP_010_SETTLEMENT_UNAVAILABLE", "on-chain lookup unavailable"));
      }
      try {
        const contract = new ethers.Contract(CONTRACT_ADDRESS, CHANNEL_ABI, hubSigner);
        const bn = await hubSigner.provider.getBlockNumber();
        const minBlock = Math.max(0, bn - 50000);
        const filter = contract.filters.ChannelOpened(null, payer, HUB_ADDRESS);
        let found = null;
        let step = 9000;
        for (let to = bn; to >= minBlock && !found; ) {
          const from = Math.max(minBlock, to - step + 1);
          try {
            const logs = await contract.queryFilter(filter, from, to);
            if (logs.length) found = logs[logs.length - 1];
          } catch (_e) { step = Math.max(1000, Math.floor(step / 2)); }
          to = from - 1;
        }
        if (!found) {
          return sendJson(res, 200, { channels: [] });
        }
        const channelId = found.args.channelId || found.args[0];
        const ocd = await contract.getChannel(channelId);
        return sendJson(res, 200, {
          channels: [{
            channelId,
            participantA: ocd.participantA,
            participantB: ocd.participantB,
            asset: ocd.asset,
            totalBalance: ocd.totalBalance.toString(),
            latestNonce: Number(ocd.latestNonce),
            isClosing: ocd.isClosing
          }]
        });
      } catch (e) {
        return sendJson(res, 500, makeError("SCP_010_SETTLEMENT_UNAVAILABLE", "lookup failed: " + e.message));
      }
    }

    ` + anchor;

if (code.includes(anchor)) {
  code = code.replace(anchor, newEndpoint);
  fs.writeFileSync('/root/x402s/node/scp-hub/server.js', code);
  console.log('OK - added /v1/channels/lookup endpoint');
} else {
  console.log('FAIL - anchor not found');
}
