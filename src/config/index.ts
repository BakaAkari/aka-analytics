import { Schema, Time } from 'koishi'

export type HistoricalImportMode = 'disabled' | 'recent' | 'full'

export interface Config {
  statsInterval?: number
  recentDayCount?: number
  logWatchInterval?: number
  logDirectory?: string
  enableAiStats?: boolean
  enableImageStats?: boolean
  chatlunaDefaultModel?: string
  chatlunaTokenPerChar?: number
  /** Per-source toggle: plugin name -> enabled/disabled. Only enabled sources are parsed. */
  trackedSources: Record<string, boolean>

  // ── log-ingestion tunables (0.5.1) ─────────────────────────────────
  /** Maximum candidate files kept in memory during recent-file discovery. */
  maxRecentFiles?: number
  /** Maximum candidate files per historical-import batch. */
  maxHistoricalFilesPerBatch?: number
  /** Hard cap on bytes read from a single file per scan cycle. */
  maxBytesPerFilePerCycle?: number
  /** fd.read chunk size. */
  logReadChunkBytes?: number
  /** Max lines produced per file per cycle. */
  logReadBatchLines?: number
  /** Soft deadline for directory discovery (ms). */
  maxScanDuration?: number
  /** Historical import strategy. */
  historicalImportMode?: HistoricalImportMode
  /** How many days back 'recent' mode covers. */
  historicalImportDays?: number
}

const MINUTE = Time.minute
const SECOND = Time.second
const MIB = 1024 * 1024

/**
 * Config schema. Numeric fields carry both a min and max so a misconfigured
 * `0` or absurdly large value cannot silently break the scheduler or
 * exhaust memory.
 */
export const Config: Schema<Config> = Schema.object({
  statsInterval: Schema.natural().role('ms').description('统计数据推送的时间间隔。').default(MINUTE * 10),
  recentDayCount: Schema.number().min(1).max(365).step(1).description('统计最近几天的数据。').default(90),
  logDirectory: Schema.string().description('Koishi 日志目录路径，相对于 Koishi 根目录。').default('data/logs'),
  enableAiStats: Schema.boolean().description('是否启用 AI 调用统计。').default(true),
  enableImageStats: Schema.boolean().description('是否启用图像生成统计。').default(true),
  chatlunaDefaultModel: Schema.string().description('ChatLuna 默认模型，用于日志中未给出模型时的回退。').default('deepseek/deepseek-v4-flash-high-thinking'),
  chatlunaTokenPerChar: Schema.number().min(0.05).max(4).description('ChatLuna 字符到 token 的估算系数。').default(0.25),
  trackedSources: Schema.dict(Boolean)
    .description('统计来源（插件名 -> 启用/禁用）。只有启用的来源才会被解析。')
    .default({
      yesimbot: true,
      'image-generator': true,
      'chat-luna': true,
    }),

  logWatchInterval: Schema.number().role('ms').min(5 * SECOND).max(60 * MINUTE).step(1000)
    .description('日志监控轮询间隔（最小 5 秒）。').default(60 * SECOND),
  historicalImportMode: Schema.union([
    Schema.const('disabled' as const).description('disabled — 不做历史导入'),
    Schema.const('recent' as const).description('recent — 仅导入最近若干天'),
    Schema.const('full' as const).description('full — 导入全部历史（目录巨大时非常慢，谨慎启用）'),
  ]).description('历史日志导入策略。默认只导入最近若干天，避免34万级日志目录时全量扫描。').default('recent'),
  historicalImportDays: Schema.number().min(1).max(365).step(1)
    .description("'recent' 模式覆盖的天数。").default(30),
  maxRecentFiles: Schema.number().min(1).max(1024).step(1)
    .description('单轮实时扫描保留的最近文件数上限。').default(64),
  maxHistoricalFilesPerBatch: Schema.number().min(1).max(5000).step(1)
    .description('单次历史导入批次处理的文件数上限。').default(500),
  maxBytesPerFilePerCycle: Schema.number().min(64 * 1024).max(64 * MIB).step(1024)
    .description('单文件单轮读取的最大字节数。').default(8 * MIB),
  logReadChunkBytes: Schema.number().min(4 * 1024).max(16 * MIB).step(1024)
    .description('单次 fd.read 的字节数。').default(1 * MIB),
  logReadBatchLines: Schema.number().min(50).max(50_000).step(1)
    .description('单文件单轮生成的最大行数。').default(1000),
  maxScanDuration: Schema.number().role('ms').min(5 * SECOND).max(30 * MINUTE).step(1000)
    .description('目录发现阶段的软性超时。').default(120 * SECOND),
})
