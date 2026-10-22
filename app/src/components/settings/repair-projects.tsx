import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, ErrorCard } from "@/components/ui/skyglass";
import { useAsyncAction } from "@/components/ui/async-action";
import { client } from "@/lib/client";
import { ccWorkspacesQueryOptions } from "@/lib/cloud-cc";
import { deviceListQueryOptions } from "@/lib/devices";

type Project = { id: string; name: string; workspaceId: string; deviceId: string; profileId: string; repository: string; allowPush: true; updateOriginal?: boolean };
const key = ["repairs", "projects"];
export function RepairProjects() {
  const cache = useQueryClient();
  const projects = useQuery({ queryKey: key, queryFn: (): Promise<Project[]> => client("/api/repairs/projects", "projects", { fallback: "无法读取修复项目" }) });
  const workspaces = useQuery(ccWorkspacesQueryOptions());
  const devices = useQuery(deviceListQueryOptions());
  const [form, setForm] = useState({ id: "", name: "", workspaceId: "", deviceId: "", profileId: "", updateOriginal: false });
  const [approved, setApproved] = useState(false);
  const save = useAsyncAction(async () => {
    await client("/api/repairs/projects", { method: "PUT", body: { ...form, allowPush: approved }, fallback: "保存失败，请检查工作区和设备" });
    await cache.invalidateQueries({ queryKey: key });
  }, { errorToast: (e) => e.message });
  const remove = useAsyncAction(async (id: string) => {
    await client(`/api/repairs/projects/${encodeURIComponent(id)}`, { method: "DELETE", fallback: "移除失败" });
    await cache.invalidateQueries({ queryKey: key });
  }, { errorToast: (e) => e.message });
  return <PageSection title="项目修复与本地验收" description="GitHub 工程在云端修复，本地按固定配置验收。支持 Unity 和自定义命令，不同步本机文件夹。">
    {projects.isError ? <ErrorCard title="无法读取修复项目" description={projects.error.message} /> : null}
    {(projects.data ?? []).map((p) => <Card className="p-4" key={p.id}>
      <p>{p.name} · {p.repository} · {p.id}</p>
      <p className="im-field-h">{p.updateOriginal ? "直接更新原工程，然后在原工程验收" : "独立副本验收，保留原工程"}</p>
      <Button variant="outline" onClick={() => { setForm({ id: p.id, name: p.name, workspaceId: p.workspaceId, deviceId: p.deviceId, profileId: p.profileId, updateOriginal: !!p.updateOriginal }); setApproved(true); }}>编辑</Button>
      <Button variant="ghost" onClick={() => void remove.run(p.id)}>移除绑定</Button>
    </Card>)}
    <Card className="p-4"><form className="im-form" onSubmit={(e) => { e.preventDefault(); if (approved) void save.run(); }}>
      {([ ["id", "项目编号（英文字母、数字、下划线）"], ["name", "项目名称"], ["profileId", "本机验收配置编号"] ] as const).map(([field, label]) =>
        <label key={field} className="im-field" htmlFor={`repair-${field}`}><span>{label}</span><Input id={`repair-${field}`} required value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} /></label>)}
      <label className="im-field" htmlFor="repair-workspace"><span>GitHub 云端工作区</span><select id="repair-workspace" required value={form.workspaceId} onChange={(e) => setForm({ ...form, workspaceId: e.target.value })}>
        <option value="">选择工作区</option>{(workspaces.data ?? []).filter((w) => w.source === "github" && w.syncState === "cloud_only").map((w) => <option key={w.id} value={w.id}>{w.name} · {w.repoFullName}</option>)}
      </select></label>
      <label className="im-field" htmlFor="repair-device"><span>本地验收设备</span><select id="repair-device" required value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
        <option value="">选择设备</option>{(devices.data?.devices ?? []).filter((d) => d.features?.includes("repair_validate")).map((d) => <option key={d.id} value={d.id}>{d.name}{d.online ? "" : "（离线）"}</option>)}
      </select></label>
      <p className="im-field-h">先在本地节点配置 repair-profiles.json，并将验收目录加入设备允许的文件夹。这里不接收本地命令、路径或密钥。无可选设备时请更新 PC 客户端。</p>
      <label><input type="checkbox" role="switch" checked={form.updateOriginal} onChange={(e) => setForm({ ...form, updateOriginal: e.target.checked })} />直接更新原工程</label>
      <p className="im-field-h">{form.updateOriginal ? "修复提交会先更新到本机配置的原工程，再就地验收。遇到未提交改动或分支分叉会停止；验收失败或取消会保留已更新内容和回退参考。Unity 批处理验收前请关闭该工程的编辑器。" : "默认使用独立副本验收，不改动原工程。开启后需在本机配置原工程路径，并加入设备允许的文件夹。"}</p>
      <label><input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} />允许本项目的修复任务推送独立分支、创建草稿 PR 并请求本地验收；不自动合并 GitHub PR。</label>
      <p className="im-field-h">生成的项目代码可能在本地验收期间执行，请只运行可信工程。Git 仓库权限还需在「账号连接 → GitHub」配置。</p>
      <Button type="submit" disabled={!approved} state={save.state} feedback={{ pending: "保存中…", success: "已保存", error: "保存失败" }}>保存项目绑定</Button>
    </form></Card>
  </PageSection>;
}
