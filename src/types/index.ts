export type AiSource = 'yesimbot' | 'chatluna' | 'image-generator' | 'unknown'

export interface AiRequestRecord {
  id: string
  timestamp: Date
  date: number
  hour: number
  source: AiSource
  provider?: string
  modelId: string
  userId?: string
  platform?: string
  channelId?: string
  guildId?: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latencyMs?: number
  firstTokenLatencyMs?: number
  success: boolean
  errorCode?: string
  fallbackFrom?: string
}

export interface AiModelDailyRecord {
  date: number
  source: string
  provider?: string
  modelId: string
  requestCount: number
  successCount: number
  failCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  totalLatencyMs: number
}

export interface ImageGenerationRecord {
  id: string
  timestamp: Date
  date: number
  hour: number
  userId?: string
  platform?: string
  commandName?: string
  styleName?: string
  modelId?: string
  provider?: string
  numImages: number
  success: boolean
  freeUsed?: number
  purchasedUsed?: number
  consumptionType?: 'free' | 'purchased' | 'mixed' | 'unknown'
  errorCode?: string
  latencyMs?: number
}

/**
 * Legacy v2 on-disk shape (from 0.4.6 / 0.5.0). Preserved so existing
 * databases do not need a schema rebuild on upgrade. New code should
 * not construct this directly; use `LogOffsetRecord` (v3) instead.
 */
export interface LogOffsetV2Record {
  fileName: string
  size: number
  lastOffset: number
  updatedAt: Date
}

/**
 * Current in-memory offset record. Backed by `analytics.log_offset_v3`
 * on disk. When a file only has a v2 legacy row, the service materialises
 * this shape with `mtimeMs = 0` for the fallback.
 */
export interface LogOffsetRecord {
  fileName: string
  size: number
  lastOffset: number
  mtimeMs: number
  updatedAt: Date
}

/** Alias — v3 == the current canonical record. Kept for call-site clarity. */
export type LogOffsetV3Record = LogOffsetRecord

/**
 * Cross-process pending-recompute marker for AI daily aggregates. When a raw
 * ai_request row is upserted, the date is written here BEFORE offset commit.
 * Recompute deletes the row only after the corresponding date's daily
 * aggregate has been rebuilt from raw. A process crash between raw upsert
 * and next recompute leaves the marker on disk so the retry still runs.
 */
export interface AiDailyDirtyRecord {
  date: number
  updatedAt: Date
}

export type IngestionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed'

export interface IngestionStateRecord {
  key: string
  status: IngestionStatus
  cursorFileName: string
  processedFiles: number
  processedBytes: number
  importedAiRecords: number
  importedImageRecords: number
  startedAt: Date
  updatedAt: Date
  completedAt: Date
  /**
   * When the current consecutive failure streak started. Reset to EPOCH
   * when a successful cycle observes running/completed state. Used with
   * `nextRetryAt` and `consecutiveFailures` to implement bounded retry
   * of transient discover/process failures.
   */
  failedAt: Date
  /**
   * Wall-clock at which a `failed` state may be reverted to `running`
   * and retried. Persisted so a restart survives the backoff — a fresh
   * process must not busy-loop against a broken directory. Value is
   * `EPOCH` when there is no scheduled retry (idle / running /
   * completed / paused states).
   */
  nextRetryAt: Date
  /**
   * Number of consecutive failures in the current streak, used to grow
   * the retry interval. Reset to 0 on the first successful cycle after
   * a recovery.
   */
  consecutiveFailures: number
  lastError: string
}

export interface ParsedLogLine {
  type: 'ai-request' | 'image-generation'
  record: AiRequestRecord | ImageGenerationRecord
}

export interface YesimbotRequestStart {
  id: string
  modelId: string
  stream: boolean
  timestamp: number
}

export interface YesimbotRequestFinish {
  id: string
  modelId: string
  durationMs: number
  firstTokenLatencyMs?: number
  promptTokens: number
  completionTokens: number
  success: boolean
  errorCode?: string
}

/** Well-known log source names used in Koishi log lines */
export const KNOWN_SOURCES: Record<string, string[]> = {
  'yesimbot': [
    'yesimbot',
    '[聊天模型]',
    '[心跳处理器]',
    '[请求执行器]',
    '[智能体核心]',
    '[世界状态]',
    '[L1 记忆]',
    '[L2-语义记忆]',
    '[刺激调度器]',
  ],
  'image-generator': ['aka-ai-image-generator', 'UsageReporter', 'ImageGeneration'],
  'chat-luna': ['chatluna', 'chat-luna'],
}

/** Infer which tracked source a log line belongs to, or null if unknown/unmatched. */
export function inferSource(name: string): string | null {
  if (!name || typeof name !== 'string') return null
  for (const [source, patterns] of Object.entries(KNOWN_SOURCES)) {
    if (patterns.some(p => name === p || name.startsWith(p + ':') || name.includes(p))) {
      return source
    }
  }
  return null
}
