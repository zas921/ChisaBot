import { GITHUB_REPO } from "./github";

/** Application-level boundary; the GitHub token must also be scoped on GitHub. */
export type GitAuthorization = { access: "disabled" | "read" | "write"; repositories: string[] };
export const NO_GIT_AUTHORIZATION: GitAuthorization = { access: "disabled", repositories: [] };

export function permitsGit(policy: GitAuthorization, repo: string, operation: "read" | "write") {
  return GITHUB_REPO.test(repo) && policy.access !== "disabled"
    && (operation === "read" || policy.access === "write")
    && policy.repositories.includes(repo.toLowerCase());
}
