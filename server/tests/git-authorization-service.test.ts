import { expect, test } from "bun:test";
import { createGithub } from "../src/github/service";

test("credential release requires owner, repository and write authorization; disconnect revokes grants", async () => {
  const policies = new Map<string, unknown>();
  let connected = true, reveals = 0;
  const secret = "github_pat_dummy_for_test_only_000000000000";
  const database = { $client: { unsafe: async (q: string, p: unknown[] = []) => {
    if (q.startsWith("SELECT policy")) return policies.has(String(p[0])) ? [{ policy: policies.get(String(p[0])) }] : [];
    if (q.startsWith("SELECT * FROM chisabot_github_connections")) return connected && p[0] === "owner" ? [{ login: "octo", name: "Octo", status: "ok" }] : [];
    if (q.startsWith("INSERT INTO chisabot_github_git_access")) policies.set(String(p[0]), JSON.parse(String(p[1])));
    if (q.startsWith("DELETE FROM chisabot_github_git_access")) policies.delete(String(p[0]));
    return [];
  } } };
  const vault = { internal: {
    reveal: async (owner: string) => { reveals++; return owner === "owner" && connected ? { value: secret } : null; },
    remove: async () => { connected = false; },
  } };
  const github = createGithub(database as never, { vault: vault as never, fetch: (async (url: URL, init: RequestInit) => {
    expect(url.origin).toBe("https://api.github.com");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${secret}`);
    return new Response(JSON.stringify({ full_name: "octo/demo", default_branch: "main", private: true }), { status: 200 });
  }) as typeof fetch });
  await expect(github.gitCredential("owner", "octo/demo")).rejects.toThrow("云端 Git 授权");
  expect(reveals).toBe(0);
  const policy = await github.configureGitAuthorization("owner", { access: "read", repositories: ["octo/demo"] });
  expect(JSON.stringify(policy)).not.toContain(secret);
  expect((await github.gitCredential("owner", "octo/demo")).login).toBe("octo");
  const beforeDenied = reveals;
  await expect(github.gitCredential("owner", "octo/demo", "write")).rejects.toThrow();
  await expect(github.gitCredential("other", "octo/demo")).rejects.toThrow();
  await expect(github.gitCredential("owner", "octo/another")).rejects.toThrow();
  expect(reveals).toBe(beforeDenied);
  await github.configureGitAuthorization("owner", { access: "write", repositories: ["octo/demo"] });
  expect((await github.gitCredential("owner", "octo/demo", "write")).token).toBe(secret);
  await github.disconnect("owner");
  expect(await github.gitAuthorization("owner")).toEqual({ access: "disabled", repositories: [] });
  await expect(github.gitCredential("owner", "octo/demo")).rejects.toThrow();
});
