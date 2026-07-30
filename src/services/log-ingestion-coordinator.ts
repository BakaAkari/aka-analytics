import { Context, Logger, Time, Disposable } from 'koishi'
import { resolve } from 'path'
import { LogReader, DiscoverySession, compareFileName, type LogFileInfo, type DiscoveryResult } from '../utils/log-reader'
import { LogOffsetService } from './log-offset-service'
import { IngestionStateService } from './ingestion-state-service'
import { AiRequestService } from './ai-request-service'
import { ImageGenerationService } from './image-generation-service'
import { LogRecordProcessor } from './log-record-processor'
import type { Config } from '../config'

/**
 * Format a numeric key=value log line consistent with the existing
 * plugin log style. Values are cast via String(). Booleans/numbers are
 * rendered verbatim; strings are emitted unquoted (they are already
 * ASCII-only identifiers in our call sites).
 */
function fmt(pairs: Record<string, string | number | boolean>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(pairs)) {
    parts.push(`${k}=${v}`)
  }
  return parts.join(' ')
}

/**
 * Per-file outcome from processFiles. The historical cursor advances only
 * over the leading prefix of files where `committed && fullyConsumed`.
 * Totals count only successful commits.
 *
 *  - committed: raw records AND offset both wrote successfully.
 *  - fullyConsumed: reader reached EOF (offset == fileSize post-commit).
 *  - hitLimit: reader stopped early due to maxBytes/maxLines this cycle.
 *  - failed: raw record write or offset commit threw.
 *  - aborted: signal fired mid-file.
 */
export interface ProcessedFileResult {
  fileName: string
  committed: boolean
  fullyConsumed: boolean
  hitLimit: boolean
  failed: boolean
  aborted: boolean
  truncated: boolean
  bytesRead: number
  lines: number
  aiRecords: number
  imageRecords: number
  invalidJson: number
  ignored: number
  newOffset: number
  fileSize: number
}

interface ScanTotals {
  filesTouched: number
  filesFullyConsumed: number
  filesFailed: number
  bytesRead: number
  lines: number
  aiRecords: number
  imageRecords: number
  invalidJson: number
  ignored: number
  hitLimitFiles: number
  truncatedFiles: number
}

const EPOCH_DATE = new Date(0)

/**
 * Bounded exponential backoff schedule for historical retries. Base
 * intervals in milliseconds are indexed by consecutive-failure count;
 * anything past the last index reuses the capped value (~1h). Kept
 * short at the head so a single transient hiccup resumes within a
 * minute or two; long at the tail so a persistently-broken filesystem
 * or database backs off enough to avoid burning warning logs.
 */
const RETRY_BACKOFF_MS: readonly number[] = [
  60_000,        // 1m
  5 * 60_000,    // 5m
  15 * 60_000,   // 15m
  60 * 60_000,   // 1h (cap)
]

function emptyTotals(): ScanTotals {
  return {
    filesTouched: 0,
    filesFullyConsumed: 0,
    filesFailed: 0,
    bytesRead: 0,
    lines: 0,
    aiRecords: 0,
    imageRecords: 0,
    invalidJson: 0,
    ignored: 0,
    hitLimitFiles: 0,
    truncatedFiles: 0,
  }
}

function aggregate(results: ProcessedFileResult[]): ScanTotals {
  const t = emptyTotals()
  for (const r of results) {
    // Files that were opened count as touched regardless of outcome; but
    // record contributions only from successful commits so replay
    // semantics stay honest.
    if (r.committed) {
      t.filesTouched++
      t.bytesRead += r.bytesRead
      t.lines += r.lines
      t.aiRecords += r.aiRecords
      t.imageRecords += r.imageRecords
      t.invalidJson += r.invalidJson
      t.ignored += r.ignored
      if (r.fullyConsumed) t.filesFullyConsumed++
    }
    if (r.failed) t.filesFailed++
    if (r.hitLimit) t.hitLimitFiles++
    if (r.truncated) t.truncatedFiles++
  }
  return t
}

/**
 * Global single-flight orchestrator for log ingestion. Only one scan cycle
 * (live OR historical) runs at a time; the interval and the ready hook
 * both go through the same `mutex`. Busy skips are counted and logged
 * once per BUSY_LOG_INTERVAL_MS to avoid warning-flood on directories
 * where a single scan takes longer than the interval.
 *
 * Both live and historical use `DiscoverySession` that PERSISTS across
 * ticks. On a directory that cannot be walked within one cycle's
 * deadline, iteration resumes on the next tick from where it left off.
 * Candidates are published (and processed) only after a full directory
 * pass has completed — partial snapshots would be biased toward whichever
 * end of the directory sorted first, so tail files could otherwise be
 * permanently starved.
 */
export class LogIngestionCoordinator {
  private readonly ctx: Context
  private readonly config: Config
  private readonly logger: Logger

  private readonly reader: LogReader
  private readonly offsets: LogOffsetService
  private readonly state: IngestionStateService
  private readonly aiService: AiRequestService
  private readonly imageService: ImageGenerationService
  /**
   * Two INDEPENDENT parser instances: one for the live phase, one for
   * historical. Parsers carry stateful context (yesimbot pendingRequests
   * keyed by modelId, chatluna lastModelId, image-generator command
   * context). Feeding a single processor across phases would let the
   * live phase's most recent context contaminate an older historical
   * file — e.g. an image record from a 2024 log getting attributed to
   * the current live user, or a chat finish line getting matched to a
   * stale live modelId. Each phase's processor persists across ticks
   * (so per-file context spans tick boundaries), but they never share.
   */
  private readonly liveProcessor: LogRecordProcessor
  private readonly historicalProcessor: LogRecordProcessor

  private disposed = false
  private running = false
  private lastBusyLogAt = 0
  /** Emitted busy warnings share the same throttle window. */
  private static readonly BUSY_LOG_INTERVAL_MS = 5 * Time.minute
  private intervalDispose: Disposable | null = null
  private abortController: AbortController | null = null

  private liveDiscovery: DiscoverySession | null = null
  private historicalDiscovery: DiscoverySession | null = null
  /** Cursor value used when constructing `historicalDiscovery`. If the
   *  persistent state cursor changes (e.g., another actor bumps it), the
   *  session is invalidated. */
  private historicalDiscoveryCursor: string | null = null

  constructor(
    ctx: Context,
    config: Config,
    logger: Logger,
    aiService: AiRequestService,
    imageService: ImageGenerationService,
    processors?: { live?: LogRecordProcessor; historical?: LogRecordProcessor },
  ) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.reader = new LogReader(logger)
    this.offsets = new LogOffsetService(ctx, logger)
    this.state = new IngestionStateService(ctx, logger)
    this.aiService = aiService
    this.imageService = imageService
    this.liveProcessor = processors?.live ?? new LogRecordProcessor(config, logger)
    this.historicalProcessor = processors?.historical ?? new LogRecordProcessor(config, logger)
  }

  /**
   * Compute the retry schedule for the next failed-state transition
   * from the current state. `consecutiveFailures` is incremented by
   * one; `nextRetryAt` uses the backoff table (see RETRY_BACKOFF_MS)
   * with the index clamped to the last slot. `failedAt` records the
   * start of the current streak — set on the first failure of the
   * streak, preserved on subsequent failures.
   */
  private computeRetrySchedule(state: { consecutiveFailures: number; failedAt: Date }): {
    failedAt: Date
    nextRetryAt: Date
    consecutiveFailures: number
  } {
    const next = state.consecutiveFailures + 1
    const idx = Math.min(state.consecutiveFailures, RETRY_BACKOFF_MS.length - 1)
    const now = Date.now()
    const nextRetryAt = new Date(now + RETRY_BACKOFF_MS[idx])
    const failedAt = state.consecutiveFailures === 0 ? new Date(now) : state.failedAt
    return { failedAt, nextRetryAt, consecutiveFailures: next }
  }

  /**
   * Wire up the interval + ready-hook. Both drive the same `tick()`
   * method; concurrent invocations are collapsed via `running`.
   */
  start(): void {
    const interval = Math.max(5000, this.config.logWatchInterval ?? 60_000)
    this.intervalDispose = this.ctx.setInterval(() => { void this.tick('interval') }, interval)
    this.ctx.on('ready', () => { void this.tick('ready') })
  }

  /**
   * Trigger a scan immediately. Intended for tests; production entry is `start()`.
   */
  async runOnceForTest(): Promise<void> {
    await this.tick('manual')
  }

  /**
   * Reset the persistent historical-import state so the next tick re-runs
   * the import under the current `historicalImportMode` configuration.
   *
   * Returns 'busy' without touching anything when a scan cycle is in
   * flight: a running historical batch patches the state row (with its
   * old cursor) on completion, which would silently overwrite a reset
   * issued mid-cycle and leave the operator believing a re-import was
   * scheduled when it was not. Callers should retry once the cycle ends.
   */
  async resetHistoricalImport(): Promise<'ok' | 'busy'> {
    if (this.running) return 'busy'
    await this.state.resetHistorical()
    // Drop the in-flight historical discovery session; its cursor no
    // longer matches the reset state, and the next tick would otherwise
    // keep advancing the stale iterator.
    if (this.historicalDiscovery) {
      await this.historicalDiscovery.dispose().catch(() => { /* ignore */ })
      this.historicalDiscovery = null
      this.historicalDiscoveryCursor = null
    }
    return 'ok'
  }

  private async tick(source: 'interval' | 'ready' | 'manual'): Promise<void> {
    if (this.disposed) return
    if (this.running) {
      const now = Date.now()
      if (now - this.lastBusyLogAt >= LogIngestionCoordinator.BUSY_LOG_INTERVAL_MS) {
        this.lastBusyLogAt = now
        this.logger.warn(`log_ingestion busy_skip source=${source} — previous scan still running`)
      }
      return
    }

    this.running = true
    this.abortController = new AbortController()
    try {
      await this.runLive()
      if (!this.disposed) await this.runHistorical()
    } catch (err) {
      this.logger.warn(`log_ingestion failed phase=cycle error=${(err as Error)?.message ?? err}`)
    } finally {
      this.running = false
      this.abortController = null
    }
  }

  // ── live ─────────────────────────────────────────────────────────

  private async runLive(): Promise<void> {
    const start = Date.now()
    const logDirectory = resolve(this.ctx.baseDir, this.config.logDirectory ?? 'data/logs')
    const signal = this.abortController?.signal

    const slice = await this.runDiscoverySlice('live', logDirectory, null, signal)
    if (slice.kind === 'failed') {
      // A fresh session will retry on the next tick. Emit a warning and
      // process no partial candidates this cycle.
      this.logger.warn(`log_ingestion phase=live status=discover_failed error=${(slice.error as Error)?.message ?? slice.error}`)
      return
    }
    if (slice.kind === 'partial') {
      // Partial pass: session persisted, will resume next tick. No files
      // processed this cycle. We still emit a summary so the operator
      // sees discovery progress.
      this.logger.info(`log_ingestion ${fmt({ phase: 'live', status: 'discover_partial', totalMs: Date.now() - start })}`)
      return
    }
    const discovery = slice.result

    const results = await this.processFiles(discovery.files, { stopOnIncomplete: false, processor: this.liveProcessor })
    const totals = aggregate(results)

    let recomputeSummary: { dates: number[]; rowsWritten: number; rowsDeleted: number; failedDates: number[]; pendingAfter: number; pendingStateUnknown?: boolean } = { dates: [], rowsWritten: 0, rowsDeleted: 0, failedDates: [], pendingAfter: 0 }
    try {
      recomputeSummary = await this.aiService.recomputeAffectedDates()
    } catch (err) {
      this.logger.warn(`log_ingestion phase=live status=recompute_failed error=${(err as Error)?.message ?? err}`)
    }

    this.logger.info(
      `log_ingestion ${fmt({
        phase: 'live',
        status: discovery.aborted ? 'aborted' : 'ok',
        visited: discovery.visitedEntries,
        matched: discovery.matchedFiles,
        candidates: discovery.candidateFiles,
        files: totals.filesTouched,
        fullyConsumed: totals.filesFullyConsumed,
        failed: totals.filesFailed,
        bytes: totals.bytesRead,
        lines: totals.lines,
        ai: totals.aiRecords,
        img: totals.imageRecords,
        invalid: totals.invalidJson,
        hitLimit: totals.hitLimitFiles,
        truncated: totals.truncatedFiles,
        dates: recomputeSummary.dates.length,
        aggWritten: recomputeSummary.rowsWritten,
        aggDeleted: recomputeSummary.rowsDeleted,
        aggFailed: recomputeSummary.failedDates.length,
        pending: recomputeSummary.pendingAfter,
        discoverMs: discovery.durationMs,
        totalMs: Date.now() - start,
      })}`,
    )
  }

  // ── historical ───────────────────────────────────────────────────

  private async runHistorical(): Promise<void> {
    const mode = this.config.historicalImportMode ?? 'recent'
    if (mode === 'disabled') return

    const state = await this.state.getHistorical()
    if (state.status === 'completed' || state.status === 'paused') {
      return
    }
    // `failed` is transient: the next tick after the persisted
    // nextRetryAt may resume. Both discover and process failures share
    // the same backoff sequence (see computeRetrySchedule). If the
    // wall-clock has not yet reached the scheduled time, skip silently
    // so a fast tick interval does not busy-loop against a broken
    // filesystem or database.
    if (state.status === 'failed') {
      const retryAt = state.nextRetryAt?.getTime?.() ?? 0
      if (retryAt > Date.now()) return
      // Return to running for the retry attempt. Preserve cursor and
      // failure counters; they are only cleared once a cycle completes
      // without new failure.
      await this.state.patchHistorical({ status: 'running', lastError: '' })
      // Refresh in-memory snapshot so downstream reads see 'running'.
      // (The rest of this method already uses the local `state` value
      // only to test its previous status; we don't need to re-fetch.)
    }

    const start = Date.now()
    const logDirectory = resolve(this.ctx.baseDir, this.config.logDirectory ?? 'data/logs')

    // Compute the minimum-permitted filename for 'recent' mode.
    let cursor: string | null = state.cursorFileName || null
    if (mode === 'recent') {
      const days = this.config.historicalImportDays ?? 30
      const d = new Date(Date.now() - days * Time.day)
      // UTC by design: Koishi's file logger stamps rotation filenames
      // with `new Date().toISOString()`, which is UTC. Formatting the
      // cutoff in local time would skip up to a full UTC day for
      // operators outside UTC (or duplicate one). See docs/log-
      // ingestion-stability.md "Historical UTC cutoff".
      const yyyy = d.getUTCFullYear()
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
      const dd = String(d.getUTCDate()).padStart(2, '0')
      const recentCutoff = `${yyyy}-${mm}-${dd}-0.log`
      // Cursor comparison must go through compareFileName so numeric
      // seq ordering (e.g. -9.log vs -10.log) is preserved. Bare string
      // '<' would place -10.log before -2.log lexicographically.
      if (!cursor || compareFileName(cursor, recentCutoff) < 0) cursor = recentCutoff
    }

    const signal = this.abortController?.signal
    const slice = await this.runDiscoverySlice('historical', logDirectory, cursor, signal)
    if (slice.kind === 'failed') {
      // Iterator error is not the same as "history complete". Do NOT
      // advance cursor and do NOT mark completed. Persist a retry
      // schedule so the caller re-tries with a fresh session after
      // backoff. See computeRetrySchedule for the fixed policy.
      const err = slice.error
      const schedule = this.computeRetrySchedule(state)
      await this.state.patchHistorical({
        status: 'failed',
        lastError: `discover: ${(err as Error)?.message ?? err}`,
        failedAt: schedule.failedAt,
        nextRetryAt: schedule.nextRetryAt,
        consecutiveFailures: schedule.consecutiveFailures,
      })
      this.logger.warn(`log_ingestion phase=historical status=discover_failed retryAt=${schedule.nextRetryAt.toISOString()} error=${(err as Error)?.message ?? err}`)
      return
    }

    // First run: mark running.
    if (state.status === 'idle') {
      await this.state.patchHistorical({ status: 'running', startedAt: new Date(), lastError: '' })
    }

    if (slice.kind === 'partial') {
      // Partial pass — resume next tick, do not touch cursor.
      this.logger.info(`log_ingestion ${fmt({ phase: 'historical', status: 'discover_partial', cursor: cursor ?? '-', totalMs: Date.now() - start })}`)
      return
    }

    const discovery = slice.result

    if (discovery.files.length === 0) {
      // Complete pass with no matches → history is fully covered.
      await this.state.patchHistorical({
        status: 'completed',
        completedAt: new Date(),
        lastError: '',
      })
      this.logger.info(`log_ingestion ${fmt({ phase: 'historical', status: 'completed', cursor: cursor ?? '-', discoverMs: discovery.durationMs })}`)
      return
    }

    let results: ProcessedFileResult[]
    try {
      // Historical processes files in cursor-ascending order. Stop at the
      // first file that is not fully consumed / committed so the cursor
      // only advances across a contiguous prefix of finished files.
      results = await this.processFiles(discovery.files, { stopOnIncomplete: true, processor: this.historicalProcessor })
    } catch (err) {
      const schedule = this.computeRetrySchedule(state)
      await this.state.patchHistorical({
        status: 'failed',
        lastError: `process: ${(err as Error)?.message ?? err}`,
        failedAt: schedule.failedAt,
        nextRetryAt: schedule.nextRetryAt,
        consecutiveFailures: schedule.consecutiveFailures,
      })
      throw err
    }

    const totals = aggregate(results)

    // Advance cursor only across the leading prefix of files that were
    // both committed AND fullyConsumed. On the first file that fails or
    // hits a limit or aborts, stop; the cursor stays before it so it is
    // re-selected next cycle from its committed offset.
    let advancedCursor: string | null = null
    let prefixCount = 0
    for (const r of results) {
      const ok = r.committed && r.fullyConsumed && !r.aborted && !r.failed
      if (!ok) break
      advancedCursor = r.fileName
      prefixCount++
    }

    let recomputeSummary: { dates: number[]; rowsWritten: number; rowsDeleted: number; failedDates: number[]; pendingAfter: number; pendingStateUnknown?: boolean } = { dates: [], rowsWritten: 0, rowsDeleted: 0, failedDates: [], pendingAfter: 0 }
    try {
      recomputeSummary = await this.aiService.recomputeAffectedDates()
    } catch (err) {
      this.logger.warn(`log_ingestion phase=historical status=recompute_failed error=${(err as Error)?.message ?? err}`)
    }

    // processedFilesDelta counts only files whose cursor was advanced
    // over — the "made durable progress" count. Byte / record deltas
    // include partial-cycle progress (see totals aggregation above),
    // since those bytes ARE persisted even when the file isn't done.
    //
    // A batch that made durable progress AND observed no committed
    // failure clears the consecutive-failure counter and the retry
    // schedule so the next real failure starts from scratch. If any
    // file in this batch failed to commit (result.failed==true) we
    // leave the failure counter alone — the next tick will attempt
    // that file again and only after a clean batch do we reset.
    const cleanBatch = totals.filesFailed === 0
    await this.state.patchHistorical({
      status: 'running',
      cursorFileName: advancedCursor ?? state.cursorFileName,
      processedFilesDelta: prefixCount,
      processedBytesDelta: totals.bytesRead,
      importedAiRecordsDelta: totals.aiRecords,
      importedImageRecordsDelta: totals.imageRecords,
      ...(cleanBatch && state.consecutiveFailures > 0
        ? { consecutiveFailures: 0, failedAt: EPOCH_DATE, nextRetryAt: EPOCH_DATE, lastError: '' }
        : {}),
    })

    this.logger.info(
      `log_ingestion ${fmt({
        phase: 'historical',
        status: 'batch_done',
        cursor: advancedCursor ?? (cursor ?? '-'),
        cursorAdvanced: prefixCount,
        batchFiles: discovery.files.length,
        attempted: results.length,
        fullyConsumed: totals.filesFullyConsumed,
        failed: totals.filesFailed,
        files: totals.filesTouched,
        bytes: totals.bytesRead,
        lines: totals.lines,
        ai: totals.aiRecords,
        img: totals.imageRecords,
        invalid: totals.invalidJson,
        hitLimit: totals.hitLimitFiles,
        truncated: totals.truncatedFiles,
        dates: recomputeSummary.dates.length,
        aggWritten: recomputeSummary.rowsWritten,
        aggDeleted: recomputeSummary.rowsDeleted,
        aggFailed: recomputeSummary.failedDates.length,
        pending: recomputeSummary.pendingAfter,
        discoverMs: discovery.durationMs,
        totalMs: Date.now() - start,
      })}`,
    )
  }

  // ── discovery slice ──────────────────────────────────────────────

  /**
   * Advance the persistent discovery session for the given phase by one
   * slice. Returns:
   *  - { kind: 'partial' } when the pass is still partial (session
   *    stays alive and resumes next tick),
   *  - { kind: 'complete', result } when the pass has just completed
   *    (session was finalized and cleared; caller processes files),
   *  - { kind: 'failed', error } when the iterator threw. The session
   *    slot is cleared and the session disposed; the next tick will
   *    construct a fresh session and retry. Callers MUST NOT advance
   *    persistent state (cursor, completion) on this outcome.
   */
  private async runDiscoverySlice(
    phase: 'live' | 'historical',
    logDirectory: string,
    cursor: string | null,
    signal: AbortSignal | undefined,
  ): Promise<
    | { kind: 'partial' }
    | { kind: 'complete'; result: DiscoveryResult }
    | { kind: 'failed'; error: unknown }
  > {
    let session = phase === 'live' ? this.liveDiscovery : this.historicalDiscovery

    if (session && phase === 'historical' && this.historicalDiscoveryCursor !== cursor) {
      // Cursor changed between ticks (state reset, mode flipped, etc.).
      // Drop the old session and start fresh.
      await session.dispose()
      session = null
      this.historicalDiscovery = null
    }

    if (!session) {
      if (phase === 'live') {
        session = this.reader.beginRecentDiscovery(logDirectory, {
          maxCandidates: this.config.maxRecentFiles ?? 64,
        })
        this.liveDiscovery = session
      } else {
        session = this.reader.beginAfterCursorDiscovery(logDirectory, {
          maxCandidates: this.config.maxHistoricalFilesPerBatch ?? 500,
          cursor,
        })
        this.historicalDiscovery = session
        this.historicalDiscoveryCursor = cursor
      }
    }

    const status = await session.advance({
      deadlineMs: this.config.maxScanDuration,
      signal,
    })

    if (status.failed) {
      // Session is unusable: dispose it and clear the slot so the next
      // tick begins a fresh session. Do NOT publish any candidate list.
      await session.dispose().catch(() => { /* ignore */ })
      if (phase === 'live') this.liveDiscovery = null
      else {
        this.historicalDiscovery = null
        this.historicalDiscoveryCursor = null
      }
      return { kind: 'failed', error: status.failureError }
    }

    if (status.aborted) {
      // The session may have gotten partway through this slice; keep it
      // around for the next tick where the caller might not be aborted.
      // Coordinator dispose() will tear it down.
      return { kind: 'partial' }
    }

    if (!status.complete) return { kind: 'partial' }

    const result = await session.finalize()
    // Session is finalized and disposed; clear the slot for a fresh
    // pass on the next tick.
    if (phase === 'live') this.liveDiscovery = null
    else {
      this.historicalDiscovery = null
      this.historicalDiscoveryCursor = null
    }
    return { kind: 'complete', result }
  }

  // ── file processing ──────────────────────────────────────────────

  private async processFiles(
    files: LogFileInfo[],
    opts: { stopOnIncomplete: boolean; processor: LogRecordProcessor },
  ): Promise<ProcessedFileResult[]> {
    const results: ProcessedFileResult[] = []
    const offsets = await this.offsets.getMany(files.map(f => f.fileName))
    const signal = this.abortController?.signal

    for (const file of files) {
      if (this.disposed || signal?.aborted) break
      const res = await this.processOneFile(file, offsets.get(file.fileName) ?? null, signal, opts.processor)
      results.push(res)

      if (opts.stopOnIncomplete) {
        const ok = res.committed && res.fullyConsumed && !res.aborted && !res.failed
        if (!ok) break
      }
    }

    return results
  }

  private async processOneFile(
    file: LogFileInfo,
    prior: { size: number; lastOffset: number; mtimeMs: number } | null,
    signal: AbortSignal | undefined,
    processor: LogRecordProcessor,
  ): Promise<ProcessedFileResult> {
    const result: ProcessedFileResult = {
      fileName: file.fileName,
      committed: false,
      fullyConsumed: false,
      hitLimit: false,
      failed: false,
      aborted: false,
      truncated: false,
      bytesRead: 0,
      lines: 0,
      aiRecords: 0,
      imageRecords: 0,
      invalidJson: 0,
      ignored: 0,
      newOffset: prior?.lastOffset ?? 0,
      fileSize: file.size,
    }

    let startOffset = prior?.lastOffset ?? 0
    // Rotation heuristic: recorded size shrank, or mtime moved backward
    // beyond a small tolerance.
    if (prior && (prior.size > file.size || (prior.mtimeMs && file.mtimeMs < prior.mtimeMs - 1_000))) {
      startOffset = 0
      result.truncated = true
    }
    if (startOffset > file.size) startOffset = 0

    let batch
    try {
      batch = await this.reader.readBatch(file.fullPath, startOffset, {
        chunkBytes: this.config.logReadChunkBytes ?? 1024 * 1024,
        maxBytes: this.config.maxBytesPerFilePerCycle ?? 8 * 1024 * 1024,
        maxLines: this.config.logReadBatchLines ?? 1000,
        signal,
      })
    } catch (err) {
      this.logger.warn(`log_ingestion file=${file.fileName} status=read_failed error=${(err as Error)?.message ?? err}`)
      result.failed = true
      return result
    }

    if (batch.truncated) {
      result.truncated = true
      try {
        batch = await this.reader.readBatch(file.fullPath, 0, {
          chunkBytes: this.config.logReadChunkBytes ?? 1024 * 1024,
          maxBytes: this.config.maxBytesPerFilePerCycle ?? 8 * 1024 * 1024,
          maxLines: this.config.logReadBatchLines ?? 1000,
          signal,
        })
      } catch (err) {
        this.logger.warn(`log_ingestion file=${file.fileName} status=read_retry_failed error=${(err as Error)?.message ?? err}`)
        result.failed = true
        return result
      }
    }

    if (batch.aborted) {
      result.aborted = true
      return result
    }

    const processed = processor.processBatch(batch.lines)
    result.bytesRead = batch.bytesRead
    result.lines = batch.lines.length
    result.aiRecords = processed.aiRecords.length
    result.imageRecords = processed.imageRecords.length
    result.invalidJson = processed.invalidJson
    result.ignored = processed.ignored
    result.hitLimit = batch.hitLimit
    result.newOffset = batch.newOffset
    result.fileSize = batch.fileSize

    // Persist records first (raw upsert marks dirty dates), THEN commit
    // the offset. If any step throws, the file is marked failed and the
    // caller does NOT advance the historical cursor across it.
    try {
      if (processed.aiRecords.length) await this.aiService.record(processed.aiRecords)
      if (processed.imageRecords.length) await this.imageService.record(processed.imageRecords)
      await this.offsets.update({
        fileName: file.fileName,
        size: batch.fileSize,
        lastOffset: batch.newOffset,
        mtimeMs: batch.fileMtimeMs,
      })
    } catch (err) {
      this.logger.warn(`log_ingestion file=${file.fileName} status=commit_failed error=${(err as Error)?.message ?? err}`)
      result.failed = true
      return result
    }

    result.committed = true
    // Fully consumed = reader returned EOF AND the committed offset now
    // matches the file's end (defends against a same-cycle append).
    result.fullyConsumed = batch.eof && batch.newOffset >= batch.fileSize
    return result
  }

  dispose(): void {
    this.disposed = true
    try { this.abortController?.abort(new Error('coordinator disposed')) } catch { /* ignore */ }
    if (this.intervalDispose) {
      try { this.intervalDispose() } catch { /* ignore */ }
      this.intervalDispose = null
    }
    // Dispose lingering discovery sessions so the underlying directory
    // handles are closed. Fire-and-forget: dispose() is sync per the
    // Koishi contract, but session.dispose() awaits closing the handle.
    if (this.liveDiscovery) {
      void this.liveDiscovery.dispose().catch(() => { /* ignore */ })
      this.liveDiscovery = null
    }
    if (this.historicalDiscovery) {
      void this.historicalDiscovery.dispose().catch(() => { /* ignore */ })
      this.historicalDiscovery = null
      this.historicalDiscoveryCursor = null
    }
  }
}
