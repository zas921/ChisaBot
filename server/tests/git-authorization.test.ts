import { describe, expect, test } from "bun:test";
import { NO_GIT_AUTHORIZATION, permitsGit } from "../../shared/git-authorization";
import { gitAuthorizationSchema } from "../src/github/git-authorization";

describe("cloud Git authorization", () => {
  test("defaults closed; read and write remain distinct", () => {
    expect(permitsGit(NO_GIT_AUTHORIZATION, "a/game", "read")).toBe(false);
    const read = gitAuthorizationSchema.parse({ access: "read", repositories: ["Alice/Game", "alice/game"] });
    expect(read.repositories).toEqual(["alice/game"]);
    expect(permitsGit(read, "ALICE/Game", "read")).toBe(true);
    expect(permitsGit(read, "alice/game", "write")).toBe(false);
    expect(permitsGit({ ...read, access: "write" }, "alice/game", "write")).toBe(true);
    expect(permitsGit({ ...read, access: "write" }, "alice/other", "write")).toBe(false);
  });
  test("rejects wildcard, URL, command, empty grants and unknown fields", () => {
    for (const repo of ["*", "alice/*", "https://github.com/a/b", "a/b;whoami", "a/b\nsecret"]) {
      expect(gitAuthorizationSchema.safeParse({ access: "write", repositories: [repo] }).success).toBe(false);
    }
    expect(gitAuthorizationSchema.safeParse({ access: "write", repositories: [] }).success).toBe(false);
    expect(gitAuthorizationSchema.safeParse({ access: "write", repositories: ["a/b"], token: "secret" }).success).toBe(false);
  });
});
