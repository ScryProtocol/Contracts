const { ScpAgentClient } = require("./agent-client");

class ScpApiClient {
  constructor(options = {}) {
    this.agent = new ScpAgentClient(options);
  }

  async request(url, options = {}) {
    return this.agent.callApi(url, options);
  }

  async get(url, options = {}) {
    return this.request(url, { ...options, method: "GET" });
  }

  async post(url, body, options = {}) {
    return this.request(url, { ...options, method: "POST", requestBody: body });
  }

  close() {
    this.agent.close();
  }
}

module.exports = { ScpApiClient };
