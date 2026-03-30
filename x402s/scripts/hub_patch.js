const fs = require('fs');
let code = fs.readFileSync('/root/x402s/node/scp-hub/server.js', 'utf8');

const old = `const { sigA, sigB, latestState, ...safe } = ch;
      return sendJson(res, 200, {
        ...safe,
        hasSignedState: !!(sigA || sigB)
      });`;

const rep = `const { sigA, sigB, latestState, ...safe } = ch;
      let onChainTotal = null;
      try {
        const hubSigner = getHubSigner();
        if (hubSigner && CONTRACT_ADDRESS) {
          const contract = new ethers.Contract(CONTRACT_ADDRESS, CHANNEL_ABI, hubSigner);
          const ocd = await contract.getChannel(channelId);
          if (ocd && ocd.totalBalance) onChainTotal = ocd.totalBalance.toString();
        }
      } catch (_e) {}
      return sendJson(res, 200, {
        ...safe,
        hasSignedState: !!(sigA || sigB),
        onChainTotalBalance: onChainTotal
      });`;

if (code.includes(old)) {
  code = code.replace(old, rep);
  fs.writeFileSync('/root/x402s/node/scp-hub/server.js', code);
  console.log('OK - patched hub channel endpoint with onChainTotalBalance');
} else {
  console.log('FAIL - target string not found');
}
