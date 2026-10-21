"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { createProxyAgent } = require("../../src/agent/proxy");

const sockets = new Set();
function track(s) {
  sockets.add(s);
  s.on("error", () => {});
  s.on("close", () => sockets.delete(s));
  return s;
}
const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s.address().port)));

async function main() {
  const target = https.createServer({
    cert: fs.readFileSync(path.join(__dirname, "proxy-tls-cert.pem")),
    key: fs.readFileSync(path.join(__dirname, "proxy-tls-key.pem")),
  }, (_req, res) => res.end("OK"));
  target.on("connection", track);
  const targetPort = await listen(target);
  // Always route to the fixture, including negative target names; no external DNS or network.
  const connect = (client, reply) => {
    const upstream = track(net.connect(targetPort, "127.0.0.1", () => {
      client.write(reply);
      client.pipe(upstream).pipe(client);
    }));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  };
  const httpProxy = http.createServer();
  httpProxy.on("connection", track);
  httpProxy.on("connect", (_req, client) => connect(client, "HTTP/1.1 200 Connection Established\r\n\r\n"));
  const socksProxy = net.createServer((client) => {
    track(client);
    client.once("data", () => {
      client.write(Buffer.from([5, 0]));
      let input = Buffer.alloc(0);
      const read = (chunk) => {
        input = Buffer.concat([input, chunk]);
        if (input.length < 5 || input.length < 7 + input[4]) return;
        client.off("data", read);
        connect(client, Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      };
      client.on("data", read);
    });
  });
  const results = {};
  try {
    for (const [route, proxy] of [["http", httpProxy], ["socks5", socksProxy]]) {
      const port = await listen(proxy);
      const agent = createProxyAgent([{ type: route, host: "127.0.0.1", port }]);
      try {
        for (const hostname of ["127.0.0.1", "proxy-target.test", "127.0.0.2"]) {
          results[`${route}:${hostname}`] = await new Promise((resolve) => {
            const req = https.get({ hostname, port: targetPort, agent }, (res) => {
              res.resume();
              res.on("end", () => resolve(`HTTP ${res.statusCode}`));
            });
            const timer = setTimeout(() => req.destroy(new Error("fixture request timed out")), 3000);
            req.once("close", () => clearTimeout(timer));
            req.on("error", (e) => resolve(e.message));
          });
        }
      } finally { agent.destroy(); }
    }
    process.stdout.write(JSON.stringify(results));
  } finally {
    for (const s of sockets) s.destroy();
    for (const s of [target, httpProxy, socksProxy]) s.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
