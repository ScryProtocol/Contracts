/* eslint-disable no-console */
const target = require("../scp-demo/music-api/server");

if (require.main === module) {
  const host = process.env.MUSIC_HOST || process.env.HOST || "127.0.0.1";
  const port = Number(process.env.MUSIC_PORT || process.env.PORT || 4095);
  const server = target.createMusicServer();
  server.listen(port, host, () => {
    console.log("[deprecated] music-api moved to node/scp-demo/music-api/server.js");
  });
}

module.exports = target;
