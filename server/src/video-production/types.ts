export type VideoShot = { sourceId: string; start: number; end: number };
export type VideoSegment = {
  text: string; visual: "source" | "card" | "quote"; caption?: string;
  sourceId?: string; start?: number; end?: number; shots?: VideoShot[];
  layout?: "heading" | "stat" | "list" | "compare"; items?: string[];
};
export type VideoScript = { title: string; summary: string; tags: string[]; segments: VideoSegment[] };
export type VideoSource = { id: string; url: string; title: string; duration?: number; transcript?: { start: number; end: number; text: string }[]; scenes?: number[]; thumbnail?: string };
export type VideoArtifact = { name: string; kind: string; bytes?: number; aspectRatio?: string; sha256?: string; warnings?: string[]; stats?: Record<string, number> };
export type VideoJob = {
  id: string; ownerId: string; botId: string; threadId: string; title: string; brief?: string;
  state: string; revision: number; scriptHash?: string | null; artifactHash?: string | null;
  scriptWarnings?: { segment: number; cardCharacters: number; minimumDurationSeconds: number; estimatedNarrationSeconds: number; message: string }[];
  script?: VideoScript | null; sources?: VideoSource[]; artifacts?: VideoArtifact[];
  error?: string | null; createdAt: string | number; updatedAt: string | number; scriptApproved?: boolean; videoApproved?: boolean;
  reviewPolicy?: { mode: "human" | "delegate_export"; reviewerBotId?: string | null; reviewerBotName?: string; reviewerThreadId?: string | null; allowPublish: false; publishAllowed?: false; authorizedBy?: string };
  reviewAttempt?: number;
  reviewPaused?: boolean;
  reviews?: { stage: "script" | "video"; revision: number; hash: string; reviewerBotId: string; reviewAttempt?: number; decision: string; summary?: string; notes?: string; at?: string | number; createdAt?: string | number }[];
  exportReceipt?: { revision: number; artifactHash: string; botId: string; artifactNames: string[]; requestId: string; at: string | number };
  autopilot?: { status: string; attempts?: number; nextAttemptAt?: number; lastError?: string; kind?: string; eventSeq?: number };
  [key: string]: unknown;
};
export type VideoEvent = { seq: number; jobId: string; ownerId: string; botId: string; threadId: string; kind: string; message: string;
  revision?: number; scriptHash?: string | null; artifactHash?: string | null; reviewAttempt?: number;
  deliveryAttempt?: number; nextAttemptAt?: number; lastError?: string };
