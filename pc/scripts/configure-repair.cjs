#!/usr/bin/env node
"use strict";
// Local setup only: no remote API can configure executable commands or read this file.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { checkProfile } = require("../src/agent/repair-validation");
const args = process.argv.slice(2);
const get = (key) => { const i = args.indexOf(`--${key}`); return i < 0 ? undefined : args[i + 1]; };
try {
  const id = get("id");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id || "")) throw new Error("Usage: node configure-repair.cjs --id ID --profile LOCAL_JSON [--config FILE] [--replace]");
  const source = get("profile");
  if (!source) throw new Error("Provide a local profile JSON file with --profile.");
  const profile = checkProfile(JSON.parse(fs.readFileSync(path.resolve(source), "utf8")));
  const configFile = path.resolve(get("config") || process.env.CHISABOT_REPAIR_PROFILES_FILE || path.join(os.homedir(), ".chisabot-node", "repair-profiles.json"));
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, "utf8")) : { profiles: {} };
  if (Object.hasOwn(config.profiles, id) && !args.includes("--replace")) throw new Error("Profile already exists; use --replace after reviewing the existing local configuration.");
  config.profiles[id] = profile;
  fs.mkdirSync(profile.workspaceRoot, { recursive: true });
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Saved profile ${id}. Add workspaceRoot (and originalProjectRoot if configured) to the node's allowed folders, then use the same profile ID in Settings > Cloud workspace.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
