/* eslint-disable no-console */

const lines = [
  "x402s simple commands",
  "",
  "Setup",
  "  npx scp init",
  "  npx scp help",
  "  npx scp hub [network|hubUrl]",
  "",
  "Pay",
  "  npx scp pay <url> [hub|direct]",
  "  npx scp pay <channelId> <amount>",
  "  npx scp payments",
  "",
  "Channels",
  "  npx scp channel <channelId>",
  "  npx scp channel resync <channelId>",
  "  npx scp resync <channelId>",
  "  npx scp open <0xAddr> <network> <asset> <amount>",
  "  npx scp fund <channelId> <amount>",
  "  npx scp close <channelId>",
  "  npx scp channels",
  "  npx scp status",
  "",
  "More",
  "  npx scp dash",
  "  npm run scp:light -- <url>",
  "",
  "Local fallback",
  "  npm run scp -- pay <url>",
  "",
  "Legacy aliases still work:",
  "  scp:wizard, scp:agent:pay, scp:agent:payments,",
  "  scp:channel:open, scp:channel:fund, scp:channel:close, scp:channel:list"
];

console.log(lines.join("\n"));
