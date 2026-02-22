const http = require("http");

class HttpJsonClient {
  constructor(options = {}) {
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: options.maxSockets || 256,
      keepAliveMsecs: options.keepAliveMsecs || 15000
    });
    this.defaultTimeoutMs = options.timeoutMs || 10000;
  }

  request(method, endpoint, body, headers = {}, timeoutMs = this.defaultTimeoutMs) {
    const u = new URL(endpoint);
    const payload = body ? JSON.stringify(body) : "";
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method,
          hostname: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`,
          agent: this.agent,
          headers: {
            "content-type": "application/json",
            ...headers,
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {})
          }
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => {
            try {
              resolve({
                statusCode: res.statusCode,
                headers: res.headers,
                body: data ? JSON.parse(data) : {}
              });
            } catch (err) {
              reject(err);
            }
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`http timeout after ${timeoutMs}ms`));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  close() {
    this.agent.destroy();
  }
}

module.exports = { HttpJsonClient };
