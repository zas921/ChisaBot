import { IconBrandGithub, IconDots, IconExternalLink, IconKey, IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { GITHUB_NEW_TOKEN_URL, type GithubConnectionView } from "../../../../shared/github";
import { PageSection, PageSkeleton } from "@/components/layout/page-shell";
import { useAsyncAction } from "@/components/ui/async-action";
import { Button, T } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard, ListRow } from "@/components/ui/skyglass";
import { toast } from "@/components/ui/toast";
import { checkGithub, connectGithub, disconnectGithub, githubKeys, githubQueryOptions } from "@/lib/github";
import { agoText } from "@/lib/im";
import { gitAuthorizationQueryOptions, saveGitAuthorization } from "@/lib/github";
import type { GitAuthorization } from "../../../../shared/git-authorization";

const KIND_TEXT: Record<GithubConnectionView["tokenKind"], string> = {
  "fine-grained": "Fine-grained 令牌",
  classic: "Classic 令牌",
  oauth: "OAuth 令牌",
  other: "令牌",
};

/**
 * 设置 → 账号连接 → GitHub（DESIGN.md §53）。
 * 连接 = 贴一个 GitHub 令牌：服务器先用它读一次 /user，成功才加密存进保险箱（保留名 github）。值从不回显。
 */
export function GithubConnectionSection() {
  const status = useQuery(githubQueryOptions());
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const connection = status.data ?? null;
  const check = useAsyncAction(
    async () => {
      const next = await checkGithub();
      queryClient.setQueryData(githubKeys.all, next);
      if (next.status === "invalid") throw new Error("令牌已失效，请更换");
    },
    { errorToast: (error) => error.message },
  );
  async function disconnect() {
    const ok = await confirmDialog({
      title: "断开 GitHub？",
      description: "令牌会从服务器上删除，机器人不能再读写你的 GitHub。GitHub 那边的令牌不会自动作废，不再用的话请到 GitHub 设置里删除。",
      confirmLabel: "断开",
      destructive: true,
    });
    if (!ok) return;
    try {
      await disconnectGithub();
      queryClient.setQueryData(githubKeys.all, null);
      await queryClient.invalidateQueries({ queryKey: ["vault"] });
      toast.success("已断开 GitHub");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "断开失败");
    }
  }

  return (
    <PageSection description="配置 GitHub 账号和云端 Git 仓库授权。令牌加密保存在服务器，不读取本机 Git 配置。" title="GitHub">
      <GithubTokenDialog onOpenChange={setOpen} open={open} replacing={Boolean(connection)} />
      {status.isPending ? (
        <PageSkeleton rows={1} />
      ) : status.isError ? (
        <ErrorCard
          action={
            <Button className="mt-2" onClick={() => void status.refetch()} size="sm" variant="outline">
              {"重试"}
            </Button>
          }
          description={status.error.message}
          title="GitHub 连接暂时无法读取"
        />
      ) : connection ? (
        <Card className="mem-card" data-testid="github-connection">
          <div className="im-row">
            <div className="im-row-main is-static">
              <ListRow
                icon={
                  connection.avatarUrl ? (
                    <img alt="" className="gh-avatar" height={40} referrerPolicy="no-referrer" src={connection.avatarUrl} width={40} />
                  ) : (
                    <span className="gh-mark">
                      <IconBrandGithub className="size-5" />
                    </span>
                  )
                }
                sub={
                  <>
                    <span className="device-row-meta">
                      <span className={connection.status === "ok" ? "gh-state is-ok" : "gh-state is-bad"}>{connection.status === "ok" ? "已连接" : "令牌已失效"}</span>
                      <span className="device-cap-chip"><T>{KIND_TEXT[connection.tokenKind]}</T></span>
                      {connection.hint ? <span className="device-cap-chip"><T>{`末四位 ${connection.hint}`}</T></span> : null}
                    </span>
                    <span className="mem-by">{`${agoText(connection.checkedAt)}检查过 · 写操作每次都先问你`}</span>
                  </>
                }
                title={
                  <>
                    {connection.name || connection.login}
                    <span className="gh-login">{`@${connection.login}`}</span>
                  </>
                }
              />
            </div>
            {connection.status === "invalid" ? (
              <Button onClick={() => setOpen(true)} size="sm">
                {"更换令牌"}
              </Button>
            ) : (
              <Button className="gh-check" feedback={{ pending: "检查中…", success: "正常", error: "检查失败" }} onClick={() => void check.run()} size="sm" state={check.state} variant="outline">
                {"检查"}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<button aria-label="GitHub 连接的更多操作" className="device-row-more" title="更多操作" type="button" />}>
                <IconDots className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="glass-pop w-[200px] p-1.5">
                <DropdownMenuItem className="glass-mi" onClick={() => void check.run()}>
                  <IconRefresh className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"检查令牌"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem className="glass-mi" onClick={() => setOpen(true)}>
                  <IconKey className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"更换令牌…"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem className="glass-mi" onClick={() => window.open(connection.htmlUrl, "_blank", "noopener,noreferrer")}>
                  <IconExternalLink className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"在 GitHub 打开"}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator className="glass-sep" />
                <DropdownMenuItem className="glass-mi is-danger" onClick={() => void disconnect()}>
                  <IconPlugConnectedX className="size-[18px] shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1">{"断开连接…"}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Card>
      ) : (
        <Card className="mem-card" data-testid="github-connection">
          <div className="im-row">
            <div className="im-row-main is-static">
              <ListRow
                icon={
                  <span className="gh-mark">
                    <IconBrandGithub className="size-5" />
                  </span>
                }
                sub="未连接 · 用一个 GitHub 访问令牌连接，加密保存，机器人看不到"
                title="GitHub"
              />
            </div>
            <Button onClick={() => setOpen(true)} size="sm">
              {"连接"}
            </Button>
          </div>
        </Card>
      )}
      {connection ? <GitAuthorizationSettings /> : null}
    </PageSection>
  );
}

function GithubTokenDialog({ open, replacing, onOpenChange }: { open: boolean; replacing: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!open) return;
    setToken("");
    save.reset();
  }, [open]);
  const save = useAsyncAction(
    async () => {
      const next = await connectGithub(token.trim());
      setToken("");
      queryClient.setQueryData(githubKeys.all, next);
      await queryClient.invalidateQueries({ queryKey: ["vault"] });
      window.setTimeout(() => onOpenChange(false), 700);
    },
    { errorToast: (error) => error.message },
  );
  const valid = token.trim().length >= 20 && !/\s/.test(token.trim());
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="im-dialog max-w-lg">
        <DialogHeader>
          <DialogTitle>{replacing ? "更换 GitHub 令牌" : "连接 GitHub"}</DialogTitle>
          <DialogDescription>{"令牌加密保存且不回显。启用云端 Git 后，受信任节点会临时使用令牌连接 GitHub；令牌不作为聊天内容发送给模型。"}</DialogDescription>
        </DialogHeader>
        <form
          autoComplete="off"
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && save.state !== "pending") void save.run();
          }}
        >
          <DialogBody className="im-form mt-2">
            <ol className="gh-steps">
              <li>
                <span className="gh-step-n">{"1"}</span>
                <div className="min-w-0 flex-1">
                  <div className="gh-step-t">{"在 GitHub 创建令牌"}</div>
                  <div className="gh-step-s">{"已预填名称、90 天有效期和 Contents · Issues · Pull requests 读写权限。在「Repository access」里选要给机器人的仓库，然后点 Generate token。"}</div>
                  <a className="gh-step-link" href={GITHUB_NEW_TOKEN_URL} rel="noopener noreferrer" target="_blank">
                    <IconBrandGithub className="size-4" />
                    {"打开 GitHub 创建令牌"}
                    <IconExternalLink className="size-3.5 opacity-70" />
                  </a>
                </div>
              </li>
              <li>
                <span className="gh-step-n">{"2"}</span>
                <label className="im-field min-w-0 flex-1" htmlFor="github-token">
                  <span className="gh-step-t">{"粘贴令牌"}</span>
                  <Input
                    autoComplete="new-password"
                    className="font-mono"
                    data-1p-ignore
                    id="github-token"
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="github_pat_…"
                    spellCheck={false}
                    type="password"
                    value={token}
                  />
                  <span className="im-field-h">{"也可以用 Classic 令牌（勾 repo），但 Fine-grained 只开放选中的仓库，更安全。"}</span>
                </label>
              </li>
            </ol>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              {"取消"}
            </Button>
            <Button disabled={!valid} feedback={{ pending: "验证中…", success: "已连接", error: "连接失败" }} state={save.state} type="submit">
              {replacing ? "更换" : "连接"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GitAuthorizationSettings() {
  const query = useQuery(gitAuthorizationQueryOptions());
  const cache = useQueryClient();
  const [access, setAccess] = useState<GitAuthorization["access"]>("disabled");
  const [repos, setRepos] = useState("");
  useEffect(() => {
    if (query.data) {
      setAccess(query.data.access);
      setRepos(query.data.repositories.join("\n"));
    }
  }, [query.data]);
  const save = useAsyncAction(async () => {
    const authorization = await saveGitAuthorization({ access, repositories: repos.split(/[\n,]+/).map((r) => r.trim()).filter(Boolean) });
    cache.setQueryData(gitAuthorizationQueryOptions().queryKey, authorization);
  }, { errorToast: (error) => error.message });
  if (query.isPending) return <PageSkeleton rows={1} />;
  if (query.isError) return <ErrorCard title="无法读取云端 Git 授权" description={query.error.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} />;
  return <Card className="mem-card p-4">
    <form className="im-form" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <h3>云端 Git 授权</h3>
      <label className="im-field" htmlFor="cloud-git-access"><span>访问权限</span>
        <select id="cloud-git-access" value={access} onChange={(e) => setAccess(e.target.value as GitAuthorization["access"])}>
          <option value="disabled">关闭</option><option value="read">只读（克隆）</option><option value="write">读写（克隆和推送修复分支）</option>
        </select>
      </label>
      <label className="im-field" htmlFor="cloud-git-repos"><span>允许的 GitHub 仓库，每行一个 owner/name</span>
        <textarea id="cloud-git-repos" className="font-mono" rows={4} value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="your-account/your-project" />
      </label>
      <p className="im-field-h">请同时在 GitHub 的 Fine-grained 令牌中仅选择这些仓库。克隆需要 Contents 读取，推送需要 Contents 读写，创建 PR 还需要 Pull requests 读写。这里的授权不修改 GitHub 令牌权限，也不会上传本机 SSH 密钥、Git 配置或凭据。</p>
      <p className="im-field-h">关闭授权会阻止后续克隆与推送；已下发的操作和已克隆的代码不会被自动撤回。本地验收单独使用本机 Git 凭据。</p>
      <Button type="submit" state={save.state} feedback={{ pending: "保存中…", success: "已保存", error: "保存失败" }}>保存 Git 授权</Button>
    </form>
  </Card>;
}
