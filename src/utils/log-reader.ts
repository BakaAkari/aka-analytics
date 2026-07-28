import { opendir, stat, open } from 'fs/promises'
import { resolve } from 'path'
import type { FileHandle } from 'fs/promises'
import { Logger } from 'koishi'

export interface LogFileInfo {
  fileName: string
  fullPath: string
  size: number
  mtimeMs: number
}

/**
 * Composite sort key: [dateNum, seq] where dateNum = YYYYMMDD as integer.
 * Files not matching the Koishi logger pattern get [0, 0, name] with the
 * name used as a stable secondary key so they sort deterministically at
 * the beginning of the ordering.
 */
export interface FileSortKey {
  dateNum: number
  seq: number
  fallbackName: string
}

export interface DiscoveryResult {
  files: LogFileInfo[]
  visitedEntries: number
  matchedFiles: number
  candidateFiles: number
  durationMs: number
  deadlineExceeded: boolean
  aborted: boolean
  /** True when the underlying async iterator completed without deadline/abort. */
  completed: boolean
}

export interface ReadBatchResult {
  newOffset: number
  lines: string[]
  bytesRead: number
  /** Reached maxBytes or maxLines; more content may remain to be read next cycle. */
  hitLimit: boolean
  /** Detected: current file size < startOffset. Caller should reset offset to 0. */
  truncated: boolean
  fileSize: number
  fileMtimeMs: number
  eof: boolean
  aborted: boolean
}

export interface ReadBatchOptions {
  chunkBytes: number
  maxBytes: number
  maxLines: number
  signal?: AbortSignal
}

export interface DiscoverRecentOptions {
  maxCandidates: number
  signal?: AbortSignal
  deadlineMs?: number
  /**
   * Optional injectable source of directory entries. Used by tests to avoid
   * writing hundreds of thousands of real files. Must yield objects with a
   * `name` property (compatible with fs.Dirent).
   */
  entrySource?: AsyncIterable<{ name: string; isFile(): boolean }>
  /** Optional injectable stat. Defaults to fs/promises.stat. */
  statFn?: (fullPath: string) => Promise<{ size: number; mtimeMs: number }>
}

export interface DiscoverAfterCursorOptions extends DiscoverRecentOptions {
  /** Files strictly greater than this cursor filename are considered. Null → no cursor. */
  cursor: string | null
}

export interface DiscoveryAdvanceOptions {
  /** Soft wall-clock deadline for this slice. */
  deadlineMs?: number
  /**
   * Max directory entries visited in this slice. Primarily a test hook so
   * cases don't depend on wall-clock timing. Production leaves this
   * unset and uses `deadlineMs`.
   */
  maxEntries?: number
  signal?: AbortSignal
}

export interface DiscoveryAdvanceStatus {
  /** True once the directory iterator has been fully consumed. */
  complete: boolean
  /**
   * True when the underlying iterator (or its stat backing) threw. A
   * failed session must NOT be finalized: candidates may be biased or
   * missing. Callers must dispose the session and construct a fresh one
   * on the next tick. Terminal — same slot as `complete` conceptually,
   * but callers key different persistence decisions off it (never
   * advance historical cursor on failure).
   */
  failed: boolean
  /** Populated when `failed` is true. */
  failureError?: unknown
  visitedEntries: number
  matchedFiles: number
  /** Cumulative visits across all slices so far. */
  cumulativeVisitedEntries: number
  cumulativeMatchedFiles: number
  deadlineExceeded: boolean
  aborted: boolean
  entryBudgetExceeded: boolean
}

const KOISHI_LOG_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(\d+)\.log$/

export function parseFileSortKey(fileName: string): FileSortKey {
  const m = KOISHI_LOG_PATTERN.exec(fileName)
  if (!m) {
    return { dateNum: 0, seq: 0, fallbackName: fileName }
  }
  const [, y, mo, d, seq] = m
  return {
    dateNum: Number(y) * 10000 + Number(mo) * 100 + Number(d),
    seq: Number(seq),
    fallbackName: fileName,
  }
}

/** Returns a<b: negative, a===b: 0, a>b: positive. */
export function compareFileSortKey(a: FileSortKey, b: FileSortKey): number {
  if (a.dateNum !== b.dateNum) return a.dateNum - b.dateNum
  if (a.seq !== b.seq) return a.seq - b.seq
  return a.fallbackName < b.fallbackName ? -1 : a.fallbackName > b.fallbackName ? 1 : 0
}

/** Compare filenames directly by sort key. */
export function compareFileName(a: string, b: string): number {
  return compareFileSortKey(parseFileSortKey(a), parseFileSortKey(b))
}

function nowMs(): number {
  return Date.now()
}

/**
 * Maintain the top-K entries by sort key. `keepMode` decides which K to keep:
 *  - 'largest': keep the K largest sort keys (recent files).
 *  - 'smallest': keep the K smallest sort keys (earliest after cursor).
 * Internally uses a sorted array of size <= K. K is expected to be small
 * (default 64), so O(K) inserts are acceptable.
 */
class TopKBuffer {
  private readonly cap: number
  private readonly keepMode: 'largest' | 'smallest'
  private items: Array<{ key: FileSortKey; name: string }> = []

  constructor(cap: number, keepMode: 'largest' | 'smallest') {
    if (!Number.isInteger(cap) || cap <= 0) {
      throw new RangeError(`TopKBuffer cap must be positive integer, got ${cap}`)
    }
    this.cap = cap
    this.keepMode = keepMode
  }

  /**
   * Item ordering inside the sorted array is always ascending by sort key.
   * With keepMode 'largest' we drop the smallest (index 0) when full.
   * With keepMode 'smallest' we drop the largest (last index) when full.
   */
  offer(name: string, key: FileSortKey): void {
    const insertAt = this.lowerBound(key)
    if (this.items.length < this.cap) {
      this.items.splice(insertAt, 0, { key, name })
      return
    }
    if (this.keepMode === 'largest') {
      if (compareFileSortKey(key, this.items[0].key) <= 0) return
      this.items.splice(insertAt, 0, { key, name })
      this.items.shift()
    } else {
      if (compareFileSortKey(key, this.items[this.items.length - 1].key) >= 0) return
      this.items.splice(insertAt, 0, { key, name })
      this.items.pop()
    }
  }

  private lowerBound(key: FileSortKey): number {
    let lo = 0
    let hi = this.items.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareFileSortKey(this.items[mid].key, key) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  values(): Array<{ name: string; key: FileSortKey }> {
    return this.items.slice()
  }

  size(): number {
    return this.items.length
  }
}

/**
 * Async iterator of directory entries from an actual directory. Wraps
 * `opendir` so the LogReader can await entries one at a time and close
 * the handle deterministically on error/abort.
 */
async function* directoryEntries(dirPath: string): AsyncIterable<{ name: string; isFile(): boolean }> {
  const dir = await opendir(dirPath)
  try {
    for await (const entry of dir) {
      yield entry
    }
  } finally {
    try {
      await dir.close()
    } catch {
      /* opendir iterator already closed itself on completion. */
    }
  }
}

/**
 * Resumable, bounded-memory directory discovery session. Iteration state
 * persists across `advance()` calls so a huge directory that cannot be
 * fully walked within one scan cycle's deadline eventually completes over
 * multiple cycles — the tail of the directory cannot be permanently
 * starved.
 *
 * Semantics:
 *  - Buffer accumulates across slices; the top-K state at any time
 *    reflects the entries visited so far.
 *  - `advance()` returns `complete: false` while the iterator has more.
 *    In that state candidates are NOT published: partial snapshots would
 *    be biased toward whichever end of the directory sorted first.
 *  - When `complete: true`, `finalize()` stat()s the candidate set and
 *    returns a `DiscoveryResult` with the fully-consistent top-K.
 *  - `dispose()` releases the underlying iterator (closes the opendir
 *    handle) whether or not iteration finished. Idempotent.
 */
export class DiscoverySession {
  private iter: AsyncIterator<{ name: string; isFile(): boolean }> | null = null
  private readonly source: AsyncIterable<{ name: string; isFile(): boolean }>
  private readonly buffer: TopKBuffer
  private readonly cursorKey: FileSortKey | null
  private readonly statFn: (fullPath: string) => Promise<{ size: number; mtimeMs: number }>
  private readonly dir: string
  private cumulativeVisited = 0
  private cumulativeMatched = 0
  private complete = false
  private failed = false
  private failureError: unknown = null
  private disposed = false
  private finalized = false
  private startedAt: number = 0

  constructor(dir: string, opts: {
    maxCandidates: number
    keepMode: 'largest' | 'smallest'
    cursor?: string | null
    entrySource?: AsyncIterable<{ name: string; isFile(): boolean }>
    statFn?: (fullPath: string) => Promise<{ size: number; mtimeMs: number }>
  }) {
    this.dir = dir
    this.buffer = new TopKBuffer(opts.maxCandidates, opts.keepMode)
    this.cursorKey = opts.cursor ? parseFileSortKey(opts.cursor) : null
    this.source = opts.entrySource ?? directoryEntries(dir)
    this.statFn = opts.statFn ?? (async (fullPath) => {
      const info = await stat(fullPath)
      return { size: info.size, mtimeMs: info.mtimeMs }
    })
  }

  isComplete(): boolean { return this.complete }
  isFailed(): boolean { return this.failed }
  isDisposed(): boolean { return this.disposed }

  async advance(opts: DiscoveryAdvanceOptions = {}): Promise<DiscoveryAdvanceStatus> {
    if (this.disposed || this.complete || this.failed) {
      return {
        complete: this.complete,
        failed: this.failed,
        failureError: this.failureError ?? undefined,
        visitedEntries: 0,
        matchedFiles: 0,
        cumulativeVisitedEntries: this.cumulativeVisited,
        cumulativeMatchedFiles: this.cumulativeMatched,
        deadlineExceeded: false,
        aborted: false,
        entryBudgetExceeded: false,
      }
    }

    if (!this.iter) {
      this.iter = this.source[Symbol.asyncIterator]()
      this.startedAt = nowMs()
    }

    const deadlineAt = typeof opts.deadlineMs === 'number' && opts.deadlineMs > 0
      ? nowMs() + opts.deadlineMs
      : null
    const entryBudget = typeof opts.maxEntries === 'number' && opts.maxEntries > 0
      ? opts.maxEntries
      : Infinity

    let visitedSlice = 0
    let matchedSlice = 0
    let deadlineExceeded = false
    let aborted = false
    let entryBudgetExceeded = false

    while (true) {
      if (opts.signal?.aborted) { aborted = true; break }
      if (deadlineAt !== null && nowMs() > deadlineAt) { deadlineExceeded = true; break }
      if (visitedSlice >= entryBudget) { entryBudgetExceeded = true; break }

      let next: IteratorResult<{ name: string; isFile(): boolean }>
      try {
        next = await this.iter.next()
      } catch (err) {
        // Iteration error is TERMINAL and NOT the same as a normal
        // complete pass. If we set `complete = true`, finalize() would
        // publish a possibly-biased/partial top-K to the coordinator
        // and the historical cursor could advance across files we never
        // actually saw. Instead: mark failed, do NOT mark complete, and
        // let the caller dispose + retry with a fresh session next tick.
        this.failed = true
        this.failureError = err
        break
      }
      if (next.done) { this.complete = true; break }
      const entry = next.value

      visitedSlice++
      this.cumulativeVisited++
      if (typeof entry.isFile === 'function' && !entry.isFile()) continue
      if (!entry.name.endsWith('.log')) continue
      matchedSlice++
      this.cumulativeMatched++
      const key = parseFileSortKey(entry.name)
      if (this.cursorKey && compareFileSortKey(key, this.cursorKey) <= 0) continue
      this.buffer.offer(entry.name, key)
    }

    return {
      complete: this.complete,
      failed: this.failed,
      failureError: this.failureError ?? undefined,
      visitedEntries: visitedSlice,
      matchedFiles: matchedSlice,
      cumulativeVisitedEntries: this.cumulativeVisited,
      cumulativeMatchedFiles: this.cumulativeMatched,
      deadlineExceeded,
      aborted,
      entryBudgetExceeded,
    }
  }

  /**
   * Stat the candidate set and return a `DiscoveryResult`. Must only be
   * called after `advance()` reports `complete: true`. Automatically
   * disposes the session — a fresh session must be constructed for the
   * next round.
   */
  async finalize(): Promise<DiscoveryResult> {
    if (this.failed) throw new Error('DiscoverySession.finalize called on failed session')
    if (!this.complete) throw new Error('DiscoverySession.finalize called before iterator completed')
    if (this.finalized) throw new Error('DiscoverySession already finalized')
    this.finalized = true

    const files: LogFileInfo[] = []
    for (const c of this.buffer.values()) {
      const fullPath = resolve(this.dir, c.name)
      try {
        const info = await this.statFn(fullPath)
        files.push({ fileName: c.name, fullPath, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        /* stat may race with rotation; skip missing files. */
      }
    }
    files.sort((a, b) => compareFileName(a.fileName, b.fileName))

    const result: DiscoveryResult = {
      files,
      visitedEntries: this.cumulativeVisited,
      matchedFiles: this.cumulativeMatched,
      candidateFiles: this.buffer.size(),
      durationMs: nowMs() - this.startedAt,
      deadlineExceeded: false,
      aborted: false,
      completed: true,
    }
    await this.dispose()
    return result
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.iter && typeof this.iter.return === 'function') {
      try { await this.iter.return() } catch { /* ignore */ }
    }
    this.iter = null
  }
}

export class LogReader {
  private logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  /**
   * Begin a resumable recent-files discovery session. Coordinator holds a
   * session across ticks so the top-K result is published only after a
   * full directory pass finishes — no permanent starvation of tail files.
   */
  beginRecentDiscovery(dir: string, opts: {
    maxCandidates: number
    entrySource?: AsyncIterable<{ name: string; isFile(): boolean }>
    statFn?: (fullPath: string) => Promise<{ size: number; mtimeMs: number }>
  }): DiscoverySession {
    return new DiscoverySession(dir, { ...opts, keepMode: 'largest', cursor: null })
  }

  beginAfterCursorDiscovery(dir: string, opts: {
    maxCandidates: number
    cursor: string | null
    entrySource?: AsyncIterable<{ name: string; isFile(): boolean }>
    statFn?: (fullPath: string) => Promise<{ size: number; mtimeMs: number }>
  }): DiscoverySession {
    // Pass cursor explicitly: an object spread of `opts` alone is fragile
    // against future signature changes (e.g. a refactor of the wrapper
    // options interface that drops `cursor` from the intersection type).
    // The historical pipeline correctness depends on every file at or
    // below the cursor being filtered out at discovery time.
    return new DiscoverySession(dir, {
      maxCandidates: opts.maxCandidates,
      keepMode: 'smallest',
      cursor: opts.cursor,
      entrySource: opts.entrySource,
      statFn: opts.statFn,
    })
  }

  /**
   * One-shot recent-file discovery. Preserved for tests and simple call
   * sites; production coordinator uses `beginRecentDiscovery` so a
   * partial pass can resume across ticks.
   *
   * `deadlineMs` acts as a soft deadline. When exceeded, iteration stops
   * and `deadlineExceeded=true`; whatever candidates were already
   * collected are returned. Callers must treat `completed=false` as
   * partial discovery — no permanent-starvation guarantee is available
   * in the one-shot path.
   */
  async discoverRecent(logDirectory: string, opts: DiscoverRecentOptions): Promise<DiscoveryResult> {
    return this.discoverOneShot(logDirectory, { ...opts, keepMode: 'largest', cursor: null })
  }

  /**
   * One-shot cursor-driven discovery. See `discoverRecent` for the
   * partial-pass caveat.
   */
  async discoverAfterCursor(logDirectory: string, opts: DiscoverAfterCursorOptions): Promise<DiscoveryResult> {
    return this.discoverOneShot(logDirectory, { ...opts, keepMode: 'smallest' })
  }

  private async discoverOneShot(
    logDirectory: string,
    opts: DiscoverRecentOptions & { keepMode: 'largest' | 'smallest'; cursor: string | null },
  ): Promise<DiscoveryResult> {
    const session = new DiscoverySession(logDirectory, {
      maxCandidates: opts.maxCandidates,
      keepMode: opts.keepMode,
      cursor: opts.cursor,
      entrySource: opts.entrySource,
      statFn: opts.statFn,
    })
    try {
      const started = nowMs()
      const status = await session.advance({
        deadlineMs: opts.deadlineMs,
        signal: opts.signal,
      })
      if (status.failed) {
        throw status.failureError instanceof Error
          ? status.failureError
          : new Error(`discovery iterator failed: ${String(status.failureError)}`)
      }
      if (status.complete) {
        const result = await session.finalize()
        return {
          ...result,
          deadlineExceeded: status.deadlineExceeded,
          aborted: status.aborted,
        }
      }
      // Partial: DO NOT publish a biased snapshot. Return an empty file
      // list with the appropriate flag so callers wait for the next tick.
      return {
        files: [],
        visitedEntries: status.cumulativeVisitedEntries,
        matchedFiles: status.cumulativeMatchedFiles,
        candidateFiles: 0,
        durationMs: nowMs() - started,
        deadlineExceeded: status.deadlineExceeded,
        aborted: status.aborted,
        completed: false,
      }
    } finally {
      await session.dispose()
    }
  }

  /**
   * Read a single bounded batch of lines from `fullPath` starting at
   * `startOffset`. Precise byte-offset accounting is maintained across
   * UTF-8 multi-byte characters that straddle chunk boundaries.
   *
   * Never allocates more than `chunkBytes` at a time. Caller iterates by
   * repeated calls; the returned `newOffset` is the byte position AFTER
   * the last complete `\n` consumed. Incomplete trailing lines are NOT
   * consumed (their bytes remain unaccounted so a future call can retry).
   */
  async readBatch(
    fullPath: string,
    startOffset: number,
    opts: ReadBatchOptions,
  ): Promise<ReadBatchResult> {
    if (!Number.isInteger(opts.chunkBytes) || opts.chunkBytes <= 0) {
      throw new RangeError(`chunkBytes must be positive, got ${opts.chunkBytes}`)
    }
    if (!Number.isInteger(opts.maxBytes) || opts.maxBytes <= 0) {
      throw new RangeError(`maxBytes must be positive, got ${opts.maxBytes}`)
    }
    if (!Number.isInteger(opts.maxLines) || opts.maxLines <= 0) {
      throw new RangeError(`maxLines must be positive, got ${opts.maxLines}`)
    }

    let fd: FileHandle | undefined
    try {
      const info = await stat(fullPath)
      const fileSize = info.size
      const fileMtimeMs = info.mtimeMs

      if (fileSize < startOffset) {
        return {
          newOffset: startOffset,
          lines: [],
          bytesRead: 0,
          hitLimit: false,
          truncated: true,
          fileSize,
          fileMtimeMs,
          eof: false,
          aborted: false,
        }
      }
      if (fileSize === startOffset) {
        return {
          newOffset: startOffset,
          lines: [],
          bytesRead: 0,
          hitLimit: false,
          truncated: false,
          fileSize,
          fileMtimeMs,
          eof: true,
          aborted: false,
        }
      }

      fd = await open(fullPath, 'r')

      const chunkBuffer = Buffer.allocUnsafe(opts.chunkBytes)
      const lines: string[] = []
      const decoder = new TextDecoder('utf-8', { fatal: false })

      let cursor = startOffset
      let bytesReadTotal = 0
      let pendingText = ''
      let bytesInPending = 0
      let hitLimit = false
      let aborted = false
      let eof = false

      while (true) {
        if (opts.signal?.aborted) { aborted = true; break }
        if (lines.length >= opts.maxLines) { hitLimit = true; break }
        if (bytesReadTotal >= opts.maxBytes) { hitLimit = true; break }

        const remaining = fileSize - cursor
        if (remaining <= 0) { eof = true; break }

        const toRead = Math.min(opts.chunkBytes, remaining, opts.maxBytes - bytesReadTotal)
        if (toRead <= 0) { hitLimit = true; break }

        const { bytesRead } = await fd.read(chunkBuffer, 0, toRead, cursor)
        if (bytesRead === 0) { eof = true; break }

        const isFinalChunk = cursor + bytesRead >= fileSize
        const decoded = decoder.decode(chunkBuffer.subarray(0, bytesRead), { stream: !isFinalChunk })
        pendingText += decoded
        bytesInPending += bytesRead
        bytesReadTotal += bytesRead
        cursor += bytesRead

        while (true) {
          const nl = pendingText.indexOf('\n')
          if (nl === -1) break

          let line = pendingText.slice(0, nl)
          if (line.endsWith('\r')) line = line.slice(0, -1)
          line = line.trim()

          const finalizedByteLen = Buffer.byteLength(pendingText.slice(0, nl + 1), 'utf-8')
          pendingText = pendingText.slice(nl + 1)
          bytesInPending -= finalizedByteLen

          if (line.length > 0) {
            lines.push(line)
            if (lines.length >= opts.maxLines) {
              hitLimit = true
              break
            }
          }
        }

        if (hitLimit) break
      }

      const newOffset = cursor - bytesInPending

      return {
        newOffset,
        lines,
        bytesRead: bytesReadTotal,
        hitLimit,
        truncated: false,
        fileSize,
        fileMtimeMs,
        eof,
        aborted,
      }
    } finally {
      if (fd !== undefined) {
        try { await fd.close() } catch { /* ignore */ }
      }
    }
  }
}
