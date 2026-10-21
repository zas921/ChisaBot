"use strict";
// Run the real shell script in a disposable tree. Bun and start.sh are fakes: never deploy.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const shell = process.env.CHISABOT_TEST_SH || "sh";

function run(t, { layout = "root", fail = "", built = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chisabot-friend-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text.replace(/\r\n/g, "\n"), { mode: 0o755 });
  };
  write("deploy/friend-up.sh", fs.readFileSync(path.join(__dirname, "friend-up.sh"), "utf8"));
  write("deploy/.env", "KEY_ENCRYPTION_KEY=fixture-only\nTRUSTED_ORIGINS=http://localhost:3001,http://127.0.0.1:3001\n");
  write("deploy/compose.yaml", 'ports:\n  - "127.0.0.1:3001:3001"\n');
  write("deploy/start.sh", '#!/bin/sh\nprintf "start\\n" >> "$FIXTURE_LOG"\n');
  write("app/.fixture", "");
  write(`${layout === "app" ? "app/" : ""}node_modules/vite/bin/vite.js`, "// fixture");
  if (built) write("app/dist/index.html", "existing build");
  write("bin/bun", `#!/bin/sh
set -eu
case "$1" in
  install) step=install ;;
  scripts/generate-app-config.ts) step=generate ;;
  --bun) step=build ;;
  *) exit 90 ;;
esac
printf '%s\\n' "$step" >> "$FIXTURE_LOG"
[ "$step" != "$FIXTURE_FAIL" ] || exit 42
case "$step" in
  generate)
    [ -d deploy ] && [ "$TENANT_PACKAGE_DIR" = ../examples/zh-CN ] || exit 91
    mkdir -p app/src/lib/generated
    printf 'export const appConfig = {};\\n' > app/src/lib/generated/application-config.ts ;;
  build)
    [ -f "$2" ] && [ "$3" = build ] && [ "$TENANT_PACKAGE_DIR" = ../examples/zh-CN ] || exit 92
    [ -f src/lib/generated/application-config.ts ] || { echo 'missing generated application config' >&2; exit 93; }
    mkdir -p dist; printf 'built\\n' > dist/index.html ;;
esac
`);
  write("bin/openssl", "#!/bin/sh\nexit 94\n"); // Presence only; an existing key must not be regenerated.
  const log = path.join(root, "steps.log");
  // Set PATH inside the shell so MSYS translates Windows PATH before we prepend our fixtures.
  const result = spawnSync(shell, ["-c", 'export PATH="$PWD/bin:$PATH"; sh deploy/friend-up.sh'], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, FIXTURE_LOG: log.replace(/\\/g, "/"), FIXTURE_FAIL: fail, TENANT_PACKAGE_DIR: "/invalid-inherited-tenant" },
  });
  assert.ifError(result.error);
  const steps = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...result, steps };
}

for (const layout of ["root", "app"]) {
  test(`fresh clone generates config before Vite (${layout} dependency layout)`, (t) => {
    const r = run(t, { layout });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.steps, ["install", "generate", "build", "start"]);
  });
}
for (const fail of ["install", "generate", "build"]) {
  test(`${fail} failure prevents startup and subsequent build steps`, (t) => {
    const r = run(t, { fail });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.steps, ["install", "generate", "build"].slice(0, ["install", "generate", "build"].indexOf(fail) + 1));
    if (fail === "generate") assert.match(r.stderr, /应用配置生成失败/);
  });
}
test("existing frontend output still skips dependency installation and building", (t) => {
  const r = run(t, { built: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.steps, ["start"]);
});
