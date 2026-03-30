/* eslint-disable no-console */
const target = require("../scp-demo/weather-api/server");

if (require.main === module) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 4080);
  const server = target.createWeatherServer();
  server.listen(port, host, () => {
    console.log("[deprecated] weather-api moved to node/scp-demo/weather-api/server.js");
  });
}

module.exports = target;
