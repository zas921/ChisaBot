import { queryOptions } from "@tanstack/react-query";
import type { GithubActionView, GithubConnectionView } from "../../../shared/github";
import { client } from "@/lib/client";
import type { GitAuthorization } from "../../../shared/git-authorization";

export const gitAuthorizationQueryOptions = () => queryOptions({
  queryKey: ["github", "git-authorization"],
  queryFn: ({ signal }): Promise<GitAuthorization> => client("/api/github/git-authorization", "authorization", { signal, fallback: "无法读取 Git 授权" }),
});
export const saveGitAuthorization = (body: GitAuthorization): Promise<GitAuthorization> =>
  client("/api/github/git-authorization", "authorization", { method: "PUT", body, fallback: "保存 Git 授权失败" });

/** GitHub 账号连接（DESIGN.md §53，docs/github.md）。令牌只往服务器送，从不读回来。 */
export const githubKeys = {
  all: ["github"] as const,
  action: (key: string) => ["github", "action", key] as const,
};

export function githubQueryOptions() {
  return queryOptions({
    queryKey: githubKeys.all,
    queryFn: ({ signal }): Promise<GithubConnectionView | null> => client("/api/github", "connection", { fallback: "无法读取 GitHub 连接", signal }),
    refetchOnWindowFocus: "always",
  });
}

export function connectGithub(token: string): Promise<GithubConnectionView> {
  return client("/api/github/connect", "connection", { method: "POST", body: { token }, fallback: "连接失败，请重试" });
}

export function checkGithub(): Promise<GithubConnectionView> {
  return client("/api/github/check", "connection", { method: "POST", fallback: "检查失败，请重试" });
}

export async function disconnectGithub() {
  await client("/api/github", { method: "DELETE", fallback: "断开失败，请重试" });
}

/** 确认卡片：有 id（工具已返回）按 id 读；否则按 kind + repo 找最新一条，工具还在等时每 1.5 秒查一次。 */
export function githubActionQueryOptions(input: { id?: string; kind: string; repo: string; poll: boolean }) {
  const key = input.id ?? `${input.kind}:${input.repo}`;
  return queryOptions({
    queryKey: githubKeys.action(key),
    queryFn: ({ signal }): Promise<GithubActionView | null> =>
      input.id
        ? client(`/api/github/actions/${encodeURIComponent(input.id)}`, "action", { fallback: "无法读取操作", signal })
        : client(`/api/github/actions/latest?kind=${encodeURIComponent(input.kind)}&repo=${encodeURIComponent(input.repo)}`, "action", { fallback: "无法读取操作", signal }),
    refetchInterval: input.poll ? 1500 : false,
    enabled: Boolean(input.id || (input.kind && input.repo)),
  });
}

export function decideGithubAction(id: string, approve: boolean): Promise<GithubActionView> {
  return client(`/api/github/actions/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`, "action", { method: "POST", fallback: "操作失败，请重试" });
}
