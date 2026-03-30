const fs = require('fs');
let code = fs.readFileSync('/root/x402s/node/scp-hub/server.js', 'utf8');

// Find the lookup block and the channels/:id block
const lookupStart = '    if (req.method === "GET" && pathname === "/v1/channels/lookup") {';
const channelsStart = '    if (req.method === "GET" && pathname.startsWith("/v1/channels/")) {';

const lookupIdx = code.indexOf(lookupStart);
const channelsIdx = code.indexOf(channelsStart);

if (lookupIdx < 0) {
  console.log('FAIL - lookup block not found');
  process.exit(1);
}
if (channelsIdx < 0) {
  console.log('FAIL - channels block not found');
  process.exit(1);
}

if (lookupIdx > channelsIdx) {
  // Need to move lookup BEFORE channels
  // Find the end of the lookup block - find the matching closing brace + newline
  // The lookup block ends with "}\n\n    if (req.method" for the next route
  // Let's find the next "    if (req.method" after lookupStart
  const afterLookup = code.indexOf('\n\n    if (req.method', lookupIdx + 10);
  if (afterLookup < 0) {
    console.log('FAIL - could not find end of lookup block');
    process.exit(1);
  }
  const lookupBlock = code.slice(lookupIdx, afterLookup) + '\n\n';

  // Remove the lookup block from its current position
  code = code.slice(0, lookupIdx) + code.slice(afterLookup);

  // Re-find channels position (it shifted)
  const newChannelsIdx = code.indexOf(channelsStart);

  // Insert lookup block before channels
  code = code.slice(0, newChannelsIdx) + lookupBlock + code.slice(newChannelsIdx);

  fs.writeFileSync('/root/x402s/node/scp-hub/server.js', code);
  console.log('OK - moved lookup route before channels/:id route');
} else {
  console.log('OK - lookup already before channels/:id');
}
