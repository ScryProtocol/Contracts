/* eslint-disable no-console */
const target = require("../scp-demo/meow-api/server");

if (require.main === module) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 4090);
  const server = target.createMeowServer();
  server.listen(port, host, () => {
    console.log("[deprecated] meow-api moved to node/scp-demo/meow-api/server.js");
  });
}

module.exports = target;
