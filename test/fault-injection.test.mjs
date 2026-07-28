import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogIngestionCoordinator } from '../lib/services/log-ingestion-coordinator.js'
import { AiRequestService } from '../lib/services/ai-request-service.js'
import { ImageGenerationService } from '../lib/services/image-generation-service.js'
import { FakeContext, FakeLogger, FakeDatabase } from './support/fake-ctx.mjs'

/**
 * Fault-injection tests for the code-review blockers on
 * `refactor/log-ingestion-stability`. Every test verifies a specific
 * failure path documented in `docs/log-ingestion-stability.md` and
 * ensures the coordinator/pipeline stays consistent after retry.
 */

const BASE_CONFIG = {
  logWatchInterval: 60_000,
  logDirectory: 'logs',
  enableAiStats: true,
  enableImageStats: true,
  chatlunaDefaultModel: 'default/model',
  chatlunaTokenPerChar: 0.25,
  trackedSources: { yesimbot: true, 'image-generator': true, 'chat-luna': true },
  maxRecentFiles: 16,
  maxHistoricalFilesPerBatch: 8,
  maxBytesPerFilePerCycle: 8 * 1024 * 1024,
  logReadChunkBytes: 4096,
  logReadBatchLines: 500,
  maxScanDuration: 120_000,
  historicalImportMode: 'full',
  historicalImportDays: 30,
}

async function setupDir() {
  const base = await mkdtemp(join(tmpdir(), 'aka-fi-'))
  await mkdir(join(base, 'logs'))
  return base
}

function makeLine(ts, name, content) {
  return JSON.stringify({ name, content, timestamp: ts })
}

async function seedYesimbotPairs(path, count, dateISO = '2025-06-01T00:00:00Z') {
  const t0 = Date.parse(dateISO)
  const lines = []
  for (let i = 0; i < count; i++) {
    const t = t0 + i * 1000
    lines.push(makeLine(t, '[聊天模型] [deepseek-chat]', '🚀 请求开始 [流式] 模型: deepseek-chat'))
    lines.push(makeLine(t + 500, '[聊天模型] [deepseek-chat]', '🏁 [流式] 传输完成 | 总耗时: 100ms | 输入: 10 | 输出: 20'))
  }
  await writeFile(path, lines.join('\n') + '\n')
}

// ── Blocker 1 ────────────────────────────────────────────────────────

test('historical: cursor never skips over a partially-read file', async () => {
  const base = await setupDir()
  try {
    // File 1 needs multiple ticks; file 2 is trivial. Historical cursor
    // must never advance to file 2 while file 1 has bytes remaining.
    // (Live-phase processing also runs but does not touch the cursor.)
    await seedYesimbotPairs(join(base, 'logs', '2025-06-01-0.log'), 600)
    await seedYesimbotPairs(join(base, 'logs', '2025-06-02-0.log'), 3, '2025-06-02T00:00:00Z')

    const config = {
      ...BASE_CONFIG,
      logReadBatchLines: 200,
      maxBytesPerFilePerCycle: 200 * 1024,
    }
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, config, logger, ai, img)

    let ticks = 0
    const MAX_TICKS = 30
    let cursor = ''
    let file1Offset = null
    let file1Size = null
    while (ticks < MAX_TICKS) {
      await coord.runOnceForTest()
      ticks++
      const state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
      cursor = state.cursorFileName
      const offsetRow = (await ctx.database.get('analytics.log_offset_v3', { fileName: '2025-06-01-0.log' }))[0]
      file1Offset = offsetRow?.lastOffset ?? 0
      file1Size = offsetRow?.size ?? 0

      // KEY invariant: cursor must never reach file 2 unless file 1 is
      // fully consumed on disk. Failing this assertion means we advanced
      // over an incomplete file.
      if (cursor === '2025-06-02-0.log') {
        assert.equal(file1Offset, file1Size,
          'cursor reached file 2 before file 1 finished reading')
        break
      }
      if (cursor === '2025-06-01-0.log') {
        // The tick that advanced past file 1 must have observed EOF.
        assert.equal(file1Offset, file1Size,
          'cursor advanced past file 1 while its offset was still short of its size')
      }
    }
    assert.ok(ticks < MAX_TICKS, `cursor never reached file 2 within ${MAX_TICKS} ticks`)
    assert.equal(cursor, '2025-06-02-0.log')

    // Every record ingested exactly once.
    const raw = await ctx.database.get('analytics.ai_request', {})
    assert.equal(raw.length, 603, 'no records lost or duplicated across multi-tick reads')

    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ── Blocker 2 ────────────────────────────────────────────────────────

test('historical: offset commit failure leaves cursor unchanged; next cycle recovers', async () => {
  const base = await setupDir()
  try {
    await seedYesimbotPairs(join(base, 'logs', '2025-06-01-0.log'), 3)
    await seedYesimbotPairs(join(base, 'logs', '2025-06-02-0.log'), 2, '2025-06-02T00:00:00Z')

    // Fail every offset upsert on tick 1, then allow all writes on tick 2.
    // Injecting a per-call counter would give the coordinator a green
    // window inside the same tick (e.g. failure on file 1 then success
    // on file 2), which is not the invariant we're testing.
    const db = new FakeDatabase()
    let allowOffsetCommits = false
    const originalUpsert = db.upsert.bind(db)
    db.upsert = async (table, rows) => {
      if (table === 'analytics.log_offset_v3' && !allowOffsetCommits) {
        throw new Error('injected offset commit failure')
      }
      return originalUpsert(table, rows)
    }

    const ctx = new FakeContext({ baseDir: base, database: db })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, BASE_CONFIG, logger, ai, img)

    // Tick 1: every offset commit fails (in both live and historical
    // phases). Cursor must NOT advance. Raw records ARE written (their
    // upsert precedes the offset commit) — subsequent replay depends on
    // primary-key idempotence.
    await coord.runOnceForTest()
    let state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.cursorFileName, '', 'cursor did not advance while commits failed')
    const offsetsAfterTick1 = await ctx.database.get('analytics.log_offset_v3', {})
    assert.equal(offsetsAfterTick1.length, 0, 'no offset rows committed on the failure tick')
    const commitWarn = logger.records.filter(r => String(r.msg).includes('commit_failed'))
    assert.ok(commitWarn.length >= 1, 'commit_failed warning emitted')

    // Tick 2: retries succeed. Cursor advances across both files. Raw
    // rows remain de-duplicated by primary key. Daily aggregates hold
    // exactly one row per (date, source, provider, model) with counts
    // matching the on-disk logs.
    allowOffsetCommits = true
    await coord.runOnceForTest()
    state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.cursorFileName, '2025-06-02-0.log',
      'cursor advanced through both files after recovery')

    const raw = await ctx.database.get('analytics.ai_request', {})
    assert.equal(raw.length, 5, 'raw table de-duplicated across the failed tick')
    const daily = await ctx.database.get('analytics.ai_model_daily', {})
    assert.equal(daily.length, 2, 'daily aggregates cover both dates')
    // Koishi's `getDateNumber` returns days-since-epoch, not YYYYMMDD; the
    // exact integer depends on the runtime timezone, so match on the two
    // distinct dates by ordering (file 1 has 3 records, file 2 has 2).
    const rawDates = [...new Set(raw.map(r => r.date))].sort((a, b) => a - b)
    for (const row of daily) {
      const expected = row.date === rawDates[0] ? 3 : 2
      assert.equal(row.requestCount, expected)
    }

    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ── Blocker 3 ────────────────────────────────────────────────────────

test('recompute failure keeps date pending; next call retries with no new records', async () => {
  const ctx = new FakeContext()
  const svc = new AiRequestService(ctx, new FakeLogger())

  await svc.record([{
    id: 'r-1',
    timestamp: new Date('2025-06-01T00:00:00Z'),
    date: 20250601,
    hour: 0,
    source: 'yesimbot',
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    userId: '', platform: '', channelId: '', guildId: '',
    promptTokens: 10, completionTokens: 20, totalTokens: 30,
    latencyMs: 100, firstTokenLatencyMs: 0,
    success: true, errorCode: '', fallbackFrom: '',
  }])
  assert.equal(svc.hasPendingDates(), true)

  // Wrap ai_model_daily upsert to fail once.
  const originalUpsert = ctx.database.upsert.bind(ctx.database)
  let failuresLeft = 1
  ctx.database.upsert = async (table, rows) => {
    if (table === 'analytics.ai_model_daily' && failuresLeft > 0) {
      failuresLeft--
      throw new Error('injected recompute failure')
    }
    return originalUpsert(table, rows)
  }

  const first = await svc.recomputeAffectedDates()
  assert.deepEqual(first.failedDates, [20250601], 'failed date surfaced')
  assert.equal(first.pendingAfter, 1)
  assert.equal(svc.hasPendingDates(), true, 'in-memory pending marker retained on failure')

  // On-disk dirty marker survives too.
  const persisted = await ctx.database.get('analytics.ai_daily_dirty', {})
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].date, 20250601)

  // No new record; second recompute must retry the pending date and clear it.
  const second = await svc.recomputeAffectedDates()
  assert.deepEqual(second.failedDates, [])
  assert.equal(svc.hasPendingDates(), false, 'in-memory pending cleared after success')
  const persistedAfter = await ctx.database.get('analytics.ai_daily_dirty', {})
  assert.equal(persistedAfter.length, 0, 'on-disk dirty marker cleared after success')

  const daily = await ctx.database.get('analytics.ai_model_daily', {})
  assert.equal(daily.length, 1)
  assert.equal(daily[0].requestCount, 1)
})

test('recompute picks up on-disk dirty dates left by a prior process crash', async () => {
  const ctx = new FakeContext()
  const svc = new AiRequestService(ctx, new FakeLogger())

  // Simulate: prior process wrote raw records + dirty marker, then died
  // before recompute. New process has empty in-memory pending set but the
  // dirty marker still points at date 20250601.
  await ctx.database.upsert('analytics.ai_request', [{
    id: 'r-1', timestamp: new Date('2025-06-01T00:00:00Z'),
    date: 20250601, hour: 0, source: 'yesimbot', provider: 'deepseek',
    modelId: 'deepseek-chat', userId: '', platform: '', channelId: '', guildId: '',
    promptTokens: 10, completionTokens: 20, totalTokens: 30,
    latencyMs: 100, firstTokenLatencyMs: 0,
    success: true, errorCode: '', fallbackFrom: '',
  }])
  await ctx.database.upsert('analytics.ai_daily_dirty', [{ date: 20250601, updatedAt: new Date() }])
  assert.equal(svc.hasPendingDates(), false, 'in-memory set is empty for a fresh service')

  const result = await svc.recomputeAffectedDates()
  assert.deepEqual(result.dates, [20250601])
  assert.deepEqual(result.failedDates, [])
  const daily = await ctx.database.get('analytics.ai_model_daily', {})
  assert.equal(daily.length, 1)
  assert.equal(daily[0].requestCount, 1)
  const dirtyAfter = await ctx.database.get('analytics.ai_daily_dirty', {})
  assert.equal(dirtyAfter.length, 0)
})

// ── Blocker 4 ────────────────────────────────────────────────────────

test('discovery: resumable session eventually surfaces tail files across many ticks', async () => {
  const { LogReader } = await import('../lib/utils/log-reader.js')

  // Fixed-order iterator: 300k unmatched entries at head, then 3k
  // matched log files at tail. With a per-slice budget of 25k entries,
  // a naive one-shot would time out before ever reaching the tail.
  const heads = []
  for (let i = 0; i < 300_000; i++) heads.push(`skip-${i}.txt`)
  const matched = []
  for (let d = 1; d <= 30; d++) {
    const dd = String(d).padStart(2, '0')
    for (let s = 0; s < 100; s++) matched.push(`2025-01-${dd}-${s}.log`)
  }
  const all = heads.concat(matched)

  async function* source() {
    for (const name of all) yield { name, isFile: () => true }
  }

  const reader = new LogReader(new FakeLogger())
  const session = reader.beginRecentDiscovery('/nowhere', {
    maxCandidates: 5,
    entrySource: source(),
    statFn: async () => ({ size: 100, mtimeMs: 0 }),
  })

  let ticks = 0
  let complete = false
  const MAX_TICKS = 50
  while (!complete && ticks < MAX_TICKS) {
    ticks++
    const status = await session.advance({ maxEntries: 25_000 })
    complete = status.complete
  }
  assert.ok(complete, `discovery never completed after ${MAX_TICKS} ticks`)
  const result = await session.finalize()
  assert.equal(result.files.length, 5)
  assert.equal(result.files[result.files.length - 1].fileName, '2025-01-30-99.log',
    'top-K contains the newest tail file')
  assert.equal(result.files[0].fileName, '2025-01-30-95.log')
  assert.equal(result.completed, true)
})

test('discovery: dispose closes the iterator even mid-pass', async () => {
  const { LogReader } = await import('../lib/utils/log-reader.js')
  let closed = false
  async function* source() {
    try {
      for (let i = 0; i < 1000; i++) yield { name: `a-${i}.log`, isFile: () => true }
    } finally {
      closed = true
    }
  }
  const reader = new LogReader(new FakeLogger())
  const session = reader.beginRecentDiscovery('/nowhere', {
    maxCandidates: 5,
    entrySource: source(),
    statFn: async () => ({ size: 1, mtimeMs: 0 }),
  })
  await session.advance({ maxEntries: 100 })
  await session.dispose()
  // Generators observe `return()` via `finally` — verifies the session
  // proactively releases the underlying handle.
  assert.equal(closed, true, 'session.dispose closed the iterator')
})

// ── P0-2: iterator throwing mid-pass is a failed session ─────────

test('discovery: iterator error marks session failed and does NOT advance state', async () => {
  const { LogReader } = await import('../lib/utils/log-reader.js')

  let closed = false
  async function* throwingSource() {
    try {
      yield { name: '2025-01-01-0.log', isFile: () => true }
      yield { name: '2025-01-01-1.log', isFile: () => true }
      throw new Error('injected iterator error')
    } finally {
      closed = true
    }
  }
  const reader = new LogReader(new FakeLogger())
  const session = reader.beginRecentDiscovery('/nowhere', {
    maxCandidates: 10,
    entrySource: throwingSource(),
    statFn: async () => ({ size: 100, mtimeMs: 0 }),
  })
  const status = await session.advance({})
  assert.equal(status.failed, true, 'iterator throw marks the slice failed')
  assert.equal(status.complete, false, 'failed is NOT the same as complete')
  await assert.rejects(() => session.finalize(), /failed session/,
    'finalize refuses to publish a failed session')
  // dispose closes the underlying iterator so the handle is released
  await session.dispose()
  assert.equal(closed, true, 'iterator return() was called')

  // A brand-new session on the next tick sees the same source retry cleanly.
  async function* okSource() {
    yield { name: '2025-01-01-0.log', isFile: () => true }
    yield { name: '2025-01-01-1.log', isFile: () => true }
  }
  const fresh = reader.beginRecentDiscovery('/nowhere', {
    maxCandidates: 10,
    entrySource: okSource(),
    statFn: async () => ({ size: 100, mtimeMs: 0 }),
  })
  const st2 = await fresh.advance({})
  assert.equal(st2.complete, true)
  const result = await fresh.finalize()
  assert.equal(result.files.length, 2)
})

test('coordinator: historical iterator error → failed state with nextRetryAt in the future', async () => {
  const base = await setupDir()
  try {
    await seedYesimbotPairs(join(base, 'logs', '2025-06-01-0.log'), 1)

    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()

    // Patch opendir at the fs layer indirectly: monkey-patch the reader's
    // beginAfterCursorDiscovery to return a session whose iterator throws.
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, BASE_CONFIG, logger, ai, img)

    const { LogReader, DiscoverySession } = await import('../lib/utils/log-reader.js')
    const readerAny = coord.reader
    const originalAfter = readerAny.beginAfterCursorDiscovery.bind(readerAny)
    let injectionsLeft = 1
    readerAny.beginAfterCursorDiscovery = function (dir, opts) {
      if (injectionsLeft > 0) {
        injectionsLeft--
        async function* throwingSource() {
          throw new Error('injected historical iterator error')
        }
        return new DiscoverySession(dir, {
          maxCandidates: opts.maxCandidates,
          keepMode: 'smallest',
          cursor: opts.cursor,
          entrySource: throwingSource(),
          statFn: async () => ({ size: 100, mtimeMs: 0 }),
        })
      }
      return originalAfter(dir, opts)
    }

    await coord.runOnceForTest()

    // Historical row must be marked failed with a future retry time.
    const state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.status, 'failed')
    assert.ok(state.consecutiveFailures >= 1, 'consecutiveFailures incremented')
    assert.ok(state.nextRetryAt.getTime() > Date.now(),
      'nextRetryAt persisted in the future so restarts honor backoff')
    // Cursor is still empty (never advanced through a failure).
    assert.equal(state.cursorFileName, '')

    // Next tick BEFORE retry expiry: skipped, state unchanged.
    const before = { ...state }
    await coord.runOnceForTest()
    const afterSkip = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(afterSkip.status, 'failed', 'still failed while nextRetryAt is in the future')
    assert.equal(afterSkip.consecutiveFailures, before.consecutiveFailures,
      'failure count not double-incremented while backoff is in force')

    // Simulate retry expiry: rewind nextRetryAt to the past, then tick.
    await ctx.database.upsert('analytics.log_import_state', [{
      ...afterSkip,
      nextRetryAt: new Date(Date.now() - 1000),
    }])
    await coord.runOnceForTest()
    const recovered = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(recovered.status, 'running',
      'expired retry: state returned to running and processed the file')
    assert.equal(recovered.consecutiveFailures, 0,
      'clean batch reset consecutiveFailures')
    assert.equal(recovered.cursorFileName, '2025-06-01-0.log')

    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ── P1-2: dirty-marker delete failure keeps pending non-zero ──────

test('recompute: dirty-marker delete failure keeps pendingAfter=1', async () => {
  const ctx = new FakeContext()
  const svc = new AiRequestService(ctx, new FakeLogger())

  await svc.record([{
    id: 'r-1',
    timestamp: new Date('2025-06-01T00:00:00Z'),
    date: 20250601,
    hour: 0,
    source: 'yesimbot',
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    userId: '', platform: '', channelId: '', guildId: '',
    promptTokens: 10, completionTokens: 20, totalTokens: 30,
    latencyMs: 100, firstTokenLatencyMs: 0,
    success: true, errorCode: '', fallbackFrom: '',
  }])

  // Fail delete on the dirty table exactly once.
  const originalRemove = ctx.database.remove.bind(ctx.database)
  let removeFailuresLeft = 1
  ctx.database.remove = async (table, filter) => {
    if (table === 'analytics.ai_daily_dirty' && removeFailuresLeft > 0) {
      removeFailuresLeft--
      throw new Error('injected dirty-marker delete failure')
    }
    return originalRemove(table, filter)
  }

  const first = await svc.recomputeAffectedDates()
  assert.deepEqual(first.failedDates, [],
    'recompute itself succeeded — failedDates is empty')
  assert.equal(first.pendingAfter, 1,
    'pendingAfter reflects the on-disk dirty row that could NOT be removed')

  // On-disk dirty marker still present.
  const persisted = await ctx.database.get('analytics.ai_daily_dirty', {})
  assert.equal(persisted.length, 1)

  // Next call clears cleanly.
  const second = await svc.recomputeAffectedDates()
  assert.equal(second.pendingAfter, 0, 'clean cycle drains pending to 0')
  const persistedAfter = await ctx.database.get('analytics.ai_daily_dirty', {})
  assert.equal(persistedAfter.length, 0)
})

test('recompute: pendingStateUnknown when dirty table read throws', async () => {
  const ctx = new FakeContext()
  const svc = new AiRequestService(ctx, new FakeLogger())

  await svc.record([{
    id: 'r-1',
    timestamp: new Date('2025-06-01T00:00:00Z'),
    date: 20250601, hour: 0, source: 'yesimbot', provider: 'deepseek',
    modelId: 'deepseek-chat', userId: '', platform: '', channelId: '', guildId: '',
    promptTokens: 10, completionTokens: 20, totalTokens: 30,
    latencyMs: 100, firstTokenLatencyMs: 0,
    success: true, errorCode: '', fallbackFrom: '',
  }])

  // Break the dirty-table read AFTER the recompute-loop merge succeeds
  // (recompute reads once at the top; we let that succeed and only fail
  // the second read that computes pendingAfter). Simplest: only fail
  // when the on-disk row set is being counted — meaning after the
  // per-date pass. We approximate by counting reads.
  const originalGet = ctx.database.get.bind(ctx.database)
  let readCount = 0
  ctx.database.get = async (table, filter) => {
    if (table === 'analytics.ai_daily_dirty') {
      readCount++
      if (readCount >= 2) throw new Error('injected pending-count read failure')
    }
    return originalGet(table, filter)
  }
  const result = await svc.recomputeAffectedDates()
  assert.equal(result.pendingStateUnknown, true,
    'flag surfaces that pending count could not be authoritatively determined')
  // pendingAfter is a lower-bound estimate; never lies as 0 while
  // failures/in-memory pending exist.
  assert.ok(typeof result.pendingAfter === 'number')
})

// ── P0-3: live and historical parser context are isolated ─────────

test('coordinator: live parser context does NOT bleed into historical parser', async () => {
  const base = await setupDir()
  try {
    // Live-tick file: a [世界状态] alice command AND a completed image
    // event for the openai provider. These set live parser context.
    const live = [
      makeLine(Date.parse('2025-06-10T00:00:00Z'), '[世界状态]',
        '记录指令调用 | 用户: alice | 指令: 画一张 | 频道: onebot:1'),
      makeLine(Date.parse('2025-06-10T00:00:01Z'), 'aka-ai-image-generator',
        "requestProviderImages 调用 { provider: 'openai', modelId: 'gpt-image-2', numImages: 1 }"),
      makeLine(Date.parse('2025-06-10T00:00:02Z'), 'aka-ai-image-generator:openai',
        'provider=openai event=create_success current=1 total=1'),
    ].join('\n') + '\n'
    // Historical file (older date, seq -0): another provider success but
    // NO [世界状态] context in this file. If parsers were shared, the
    // historical image event would inherit user=alice / command=画一张
    // from the live parse. They must not.
    const historical = [
      makeLine(Date.parse('2025-06-01T00:00:00Z'), 'aka-ai-image-generator',
        "requestProviderImages 调用 { provider: 'openai', modelId: 'gpt-image-2', numImages: 1 }"),
      makeLine(Date.parse('2025-06-01T00:00:01Z'), 'aka-ai-image-generator:openai',
        'provider=openai event=create_success current=1 total=1'),
    ].join('\n') + '\n'

    // Write files. Note historical file has an OLDER date so it sorts
    // before the live file, and live discovery keeps only the newest —
    // the live file is what runs the live phase.
    await writeFile(join(base, 'logs', '2025-06-10-0.log'), live)
    await writeFile(join(base, 'logs', '2025-06-01-0.log'), historical)

    const config = { ...BASE_CONFIG, maxRecentFiles: 1 }
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, config, logger, ai, img)

    await coord.runOnceForTest()

    const rows = await ctx.database.get('analytics.image_generation', {})
    // Two records: one from live (2025-06-10), one from historical (2025-06-01).
    assert.equal(rows.length, 2, `expected two image records, got ${rows.length}`)
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))
    // The live record carries the alice / 画一张 context.
    const liveRec = rows.find(r => r.timestamp.toISOString().startsWith('2025-06-10'))
    const histRec = rows.find(r => r.timestamp.toISOString().startsWith('2025-06-01'))
    assert.ok(liveRec && histRec)
    assert.equal(liveRec.userId, 'alice', 'live record picks up its own [世界状态] context')
    assert.equal(liveRec.commandName, '画一张')
    // The historical record MUST NOT inherit alice/画一张 from the live
    // parser. Its parser instance never saw a [世界状态] line.
    assert.notEqual(histRec.userId, 'alice',
      'historical parser must not inherit live parser userId')
    assert.notEqual(histRec.commandName, '画一张',
      'historical parser must not inherit live parser commandName')

    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// ── P1-1: heartbeat is skipped, no double count ───────────────────

test('yesimbot: heartbeat line accompanying a finish line only generates one record', async () => {
  const { LogRecordProcessor } = await import('../lib/services/log-record-processor.js')
  const p = new LogRecordProcessor({
    enableAiStats: true, enableImageStats: true,
    chatlunaDefaultModel: 'default/model', chatlunaTokenPerChar: 0.25,
    trackedSources: { yesimbot: true, 'image-generator': true, 'chat-luna': true },
  }, new FakeLogger())

  const t = Date.parse('2025-06-01T00:00:00Z')
  const lines = [
    makeLine(t, '[聊天模型] [deepseek-chat]', '🚀 请求开始 [流式] 模型: deepseek-chat'),
    makeLine(t + 500, '[聊天模型] [deepseek-chat]', '🏁 [流式] 传输完成 | 总耗时: 100ms | 输入: 10 | 输出: 20'),
    // Heartbeat line for the same invocation. Must be skipped.
    makeLine(t + 600, '[心跳处理器]', '💰 Token 消耗 | 输入: 10 | 输出: 20'),
  ]
  const result = p.processBatch(lines)
  assert.equal(result.aiRecords.length, 1,
    'heartbeat is redundant with the finish line; only one record emitted')
  assert.equal(result.aiRecords[0].totalTokens, 30)
})

// ── Extra A: cursor comparison uses numeric seq order ─────────────

test('historical: recent-mode cursor comparison uses numeric seq order', async () => {
  const base = await setupDir()
  try {
    // Pre-populate state cursor to '2025-06-01-9.log'. In 'recent' mode
    // the coordinator raises the cursor to the recent-cutoff filename if
    // the stored cursor is earlier. Under buggy lexicographic
    // comparison "2025-06-01-100.log" < "2025-06-01-9.log", so a cutoff
    // like "2025-06-01-100.log" would be considered EARLIER than the
    // cursor and the cursor would not be raised — even though numerically
    // the cutoff is later. This test locks compareFileName in as the
    // comparison operator.
    await seedYesimbotPairs(join(base, 'logs', '2025-06-01-9.log'), 1)
    await seedYesimbotPairs(join(base, 'logs', '2025-06-01-10.log'), 1)

    const config = { ...BASE_CONFIG, historicalImportMode: 'recent', historicalImportDays: 3650 }
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()

    // Seed a state row so the state service returns a real cursor. Note
    // this cursor value is lexicographically GREATER than 3-digit-seq
    // strings like "2025-06-01-100.log" but numerically SMALLER.
    await ctx.database.upsert('analytics.log_import_state', [{
      key: 'historical', status: 'running', cursorFileName: '2025-06-01-9.log',
      processedFiles: 0, processedBytes: 0, importedAiRecords: 0, importedImageRecords: 0,
      startedAt: new Date(0), updatedAt: new Date(), completedAt: new Date(0), lastError: '',
    }])

    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, config, logger, ai, img)

    await coord.runOnceForTest()

    // After the tick, the discovery must have used compareFileName so
    // "2025-06-01-10.log" is correctly identified as strictly greater
    // than the cursor "2025-06-01-9.log" (numeric seq 10 > 9). It gets
    // discovered, processed, and the cursor moves past it.
    const state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.cursorFileName, '2025-06-01-10.log',
      'cursor advanced to the numerically-largest seq, not the lexicographic one')

    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
