const fs = require('fs');
let code = fs.readFileSync('/root/x402s/node/scp-hub/server.js', 'utf8');

const old = `      return sendJson(res, 200, {
        ...safe,
        hasSignedState: !!(sigA || sigB),
        onChainTotalBalance: onChainTotal
      });`;

const rep = `      const safeState = latestState ? { balA: latestState.balA, balB: latestState.balB, stateNonce: latestState.stateNonce } : null;
      return sendJson(res, 200, {
        ...safe,
        hasSignedState: !!(sigA || sigB),
        onChainTotalBalance: onChainTotal,
        latestState: safeState
      });`;

if (code.includes(old)) {
  code = code.replace(old, rep);
  fs.writeFileSync('/root/x402s/node/scp-hub/server.js', code);
  console.log('OK - added latestState balances to channel response');
} else {
  console.log('FAIL - target not found');
}
