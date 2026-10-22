import { z } from "zod";
import { GITHUB_REPO } from "../../../shared/github";

export const gitAuthorizationSchema = z.object({
  access: z.enum(["disabled", "read", "write"]),
  repositories: z.array(z.string().trim().regex(GITHUB_REPO).transform((s) => s.toLowerCase()))
    .max(100).transform((repos) => [...new Set(repos)]),
}).strict().refine((p) => p.access === "disabled" || p.repositories.length > 0, {
  message: "请至少指定一个允许访问的 GitHub 仓库。",
});
