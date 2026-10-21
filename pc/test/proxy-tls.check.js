"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const fixture = path.join(__dirname, "fixtures");
// Public test key/certificate only; no production credentials. Trust is confined to the child.
function probe(trusted) {
  const env = { ...process.env };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (trusted) env.NODE_EXTRA_CA_CERTS = path.join(fixture, "proxy-tls-cert.pem");
  const result = spawnSync(process.execPath, [path.join(fixture, "proxy-tls-probe.cjs")], { env, encoding: "utf8", timeout: 20_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("HTTP CONNECT and SOCKS5 verify IP SANs and DNS names against the actual target", () => {
  const results = probe(true);
  for (const route of ["http", "socks5"]) {
    assert.equal(results[`${route}:127.0.0.1`], "HTTP 200", `${route} must accept a matching IP SAN`);
    assert.equal(results[`${route}:proxy-target.test`], "HTTP 200", `${route} must still accept a matching DNS SAN`);
    assert.match(results[`${route}:127.0.0.2`], /altnames|certificate.*match/i, `${route} must reject an identity mismatch`);
  }
});

test("HTTP CONNECT and SOCKS5 still reject an untrusted certificate", () => {
  const results = probe(false);
  for (const route of ["http", "socks5"]) {
    assert.match(results[`${route}:127.0.0.1`], /self.signed|certificate/i);
    assert.match(results[`${route}:proxy-target.test`], /self.signed|certificate/i);
  }
});
