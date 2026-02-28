const http = require("http");
const https = require("https");

class HttpJsonClient {
  constructor(options = {}) {
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: options.maxSockets || 256,
      keepAliveMsecs: options.keepAliveMsecs || 15000
    });
    this.secureAgent = new https.Agent({
      keepAlive: true,
      maxSockets: options.maxSockets || 256,
      keepAliveMsecs: options.keepAliveMsecs || 15000
    });
    this.defaultTimeoutMs = options.timeoutMs || 10000;
    this.maxRedirects = options.maxRedirects || 5;
  }

  request(method, endpoint, body, headers = {}, timeoutMs = this.defaultTimeoutMs, redirectCount = 0) {
    const u = new URL(endpoint);
    const isHttps = u.protocol === "https:";
    if (!isHttps && u.protocol !== "http:") {
      return Promise.reject(new Error(`unsupported protocol: ${u.protocol}`));
    }
    const transport = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : "";
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          method,
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          agent: isHttps ? this.secureAgent : this.agent,
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
            const statusCode = Number(res.statusCode || 0);
            const location = res.headers.location ? String(res.headers.location) : "";
            if (
              location &&
              [301, 302, 303, 307, 308].includes(statusCode) &&
              redirectCount < this.maxRedirects
            ) {
              const redirectedUrl = new URL(location, u).toString();
              const shouldSwitchToGet =
                statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method === "POST");
              const redirectedMethod = shouldSwitchToGet ? "GET" : method;
              const redirectedBody = redirectedMethod === "GET" || redirectedMethod === "HEAD" ? null : body;
              resolve(
                this.request(
                  redirectedMethod,
                  redirectedUrl,
                  redirectedBody,
                  headers,
                  timeoutMs,
                  redirectCount + 1
                )
              );
              return;
            }
            try {
              const ctype = String(res.headers["content-type"] || "").toLowerCase();
              const isJson =
                ctype.includes("application/json") ||
                ctype.includes("+json") ||
                data.trim().startsWith("{") ||
                data.trim().startsWith("[");
              resolve({
                statusCode,
                headers: res.headers,
                body: data
                  ? isJson
                    ? JSON.parse(data)
                    : { raw: data }
                  : {}
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
    this.secureAgent.destroy();
  }
}

module.exports = { HttpJsonClient };
