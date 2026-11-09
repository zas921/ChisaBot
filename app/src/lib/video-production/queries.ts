import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authKeys, type AuthenticatedUser } from "@/lib/auth/keys";

export type VideoJob = {
  id: string; ownerId: string; botId: string; threadId: string; title: string;
  state: string; revision: number;
  createdAt?: string | number; updatedAt?: string | number;
  aspectRatios?: string[];
  scriptHash?: string | null; artifactHash?: string | null;
  scriptApproved?: boolean; videoApproved?: boolean; error?: string | null;
  reviewPolicy?: {
    mode: "human" | "delegate_export"; reviewerBotId?: string | null; reviewerBotName?: string;
    reviewerThreadId?: string | null; authorizedBy?: string; allowPublish?: false; publishAllowed?: false;
  };
  reviewAttempt?: number; reviewPaused?: boolean; reviewRevisionRequests?: number;
  reviews?: {
    stage: "script" | "video"; revision: number; hash: string; reviewerBotId: string; reviewAttempt?: number;
    decision: "approve" | "changes_requested" | "evidence_blocked"; notes?: string; summary?: string; at?: number | string;
  }[];
  exportReceipt?: { revision: number; artifactHash: string; botId: string; artifactNames: string[]; requestId?: string; at: number | string };
  autopilot?: { status: string; attempts?: number; nextAttemptAt?: number; lastError?: string; kind?: string; eventSeq?: number };
  scriptWarnings?: { segment: number; cardCharacters: number; minimumDurationSeconds: number; estimatedNarrationSeconds: number; message: string }[];
  script?: {
    title: string; summary: string; tags: string[];
    segments: {
      text: string; visual: "source" | "card" | "quote"; sourceId?: string; start?: number; end?: number; caption?: string;
      shots?: { sourceId: string; start: number; end: number }[];
      layout?: "heading" | "stat" | "list" | "compare"; items?: string[];
    }[];
  } | null;
  sources?: { id: string; title: string }[];
  artifacts?: { name: string; kind: string; bytes?: number; sha256?: string; aspectRatio?: string; warnings?: string[] }[];
  progress?: { label: string; percent: number; ageSeconds?: number } | null;
};

export const videoStateLabels: Record<string, string> = {
  preparing: "准备素材中", awaiting_script: "等待写稿", awaiting_script_approval: "等待你确认稿件",
  render_queued: "等待制作", rendering: "成片制作中", awaiting_video_approval: "等待你确认成片",
  approved: "成片已确认", publish_queued: "等待投稿", publishing: "投稿中", published: "已投稿",
  deleting: "正在删除并清理资源",
  publish_uncertain: "投稿结果待核对", needs_configuration: "需要补充配置", failed: "制作失败", cancelled: "已取消",
};

class VideoRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(path, {
    ...init, credentials: "include", cache: "no-store",
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (response.status === 401) throw new VideoRequestError("登录已失效，请重新登录 ChisaBot 后再审核。", 401);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new VideoRequestError(typeof body?.error === "string" ? body.error : "暂时无法读取视频项目，请稍后重试。", response.status);
  }
  if (!body) throw new Error("视频服务返回了无效内容，请稍后重试。");
  return body as T;
}

export function useVideoRequest(ownerId: string) {
  const queryClient = useQueryClient();
  return async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    try {
      return await request<T>(path, init);
    } catch (error) {
      // An old request must not sign out a different person who has since logged in.
      if (error instanceof VideoRequestError && error.status === 401 &&
        queryClient.getQueryData<AuthenticatedUser | null>(authKeys.currentUser())?.id === ownerId) {
        queryClient.setQueryData(authKeys.currentUser(), null);
      }
      throw error;
    }
  };
}

/** Chat review and the right rail share one owner-scoped request and cache. */
export function useVideoProjects(ownerId: string, botId: string) {
  const videoRequest = useVideoRequest(ownerId);
  return useQuery({
    queryKey: ["video-projects", ownerId, botId],
    queryFn: ({ signal }) => videoRequest<{ jobs: VideoJob[] }>(
      `/api/video-production/jobs?botId=${encodeURIComponent(botId)}`, { signal },
    ),
    refetchInterval: 8000,
    staleTime: 2000,
    retry: false,
  });
}
