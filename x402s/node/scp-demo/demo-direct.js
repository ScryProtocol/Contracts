/* eslint-disable no-console */
const { createServer: createHubServer } = require("../scp-hub/server");
const { createPayeeServer } = require("./payee-server");
const { ScpAgentClient } = require("../scp-agent/agent-client");

const HUB_HOST = "127.0.0.1";
const HUB_PORT = Number(process.env.HUB_PORT || 4021);
const PAYEE_HOST = "127.0.0.1";
const PAYEE_PORT = Number(process.env.PAYEE_PORT || 4042);

async function run() {
  const hub = createHubServer();
  const payee = createPayeeServer({
    host: PAYEE_HOST,
    port: PAYEE_PORT,
    hubUrl: `http://${HUB_HOST}:${HUB_PORT}`
  });
  await new Promise((r) => hub.listen(HUB_PORT, HUB_HOST, r));
  await new Promise((r) => payee.listen(PAYEE_PORT, PAYEE_HOST, r));

  try {
    const agent = new ScpAgentClient({
      networkAllowlist: ["eip155:8453"],
      maxAmountDefault: "10000000"
    });
    const resourceUrl = `http://${PAYEE_HOST}:${PAYEE_PORT}/v1/data`;

    const direct = await agent.payResource(resourceUrl, { route: "direct" });
    console.log("direct ok");
    console.log(JSON.stringify(direct.response, null, 2));

    const hubPath = await agent.payResource(resourceUrl, { route: "hub" });
    console.log("hub ok");
    console.log(JSON.stringify(hubPath.response, null, 2));
    agent.close();
  } finally {
    await new Promise((r) => payee.close(r));
    await new Promise((r) => hub.close(r));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
