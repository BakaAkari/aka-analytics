import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LogIngestionCoordinator } from '../lib/services/log-ingestion-coordinator.js'
import { AiRequestService } from '../lib/services/ai-request-service.js'
import { ImageGenerationService } from '../lib/services/image-generation-service.js'
import { FakeContext, FakeLogger, FakeDatabase } from './support/fake-ctx.mjs'

const BASE_CONFIG = {
  logWatchInterval: 60_000,
  logDirectory: 'logs',
  enableAiStats: true,
  enableImageStats: true,
  chatlunaDefaultModel: 'default/model',
  chatlunaTokenPerChar: 0.25,
  trackedSources: { yesimbot: true, 'image-generator': true, 'chat-luna': true },
  maxRecentFiles: 16,
  maxHistoricalFilesPerBatch: 4,
  maxBytesPerFilePerCycle: 8 * 1024 * 1024,
  logReadChunkBytes: 4096,
  logReadBatchLines: 500,
  maxScanDuration: 120_000,
  historicalImportMode: 'full',
  historicalImportDays: 30,
}

async function setupDir() {
  const base = await mkdtemp(join(tmpdir(), 'aka-coord-'))
  await mkdir(join(base, 'logs'))
  return base
}

function makeLine(ts, name, content) {
  return JSON.stringify({ name, content, timestamp: ts })
}

async function seedYesimbotFile(path, count, dateISO = '2025-06-01T00:00:00Z') {
  const t0 = Date.parse(dateISO)
  const lines = []
  for (let i = 0; i < count; i++) {
    const t = t0 + i * 1000
    lines.push(makeLine(t, '[聊天模型] [deepseek-chat]', '🚀 请求开始 [流式] 模型: deepseek-chat'))
    lines.push(makeLine(t + 500, '[聊天模型] [deepseek-chat]', '🏁 [流式] 传输完成 | 总耗时: 100ms | 输入: 10 | 输出: 20'))
  }
  await writeFile(path, lines.join('\n') + '\n')
}

test('coordinator: concurrent tick() calls collapse into one scan', async () => {
  const base = await setupDir()
  try {
    await seedYesimbotFile(join(base, 'logs', '2025-06-01-0.log'), 3)
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, BASE_CONFIG, logger, ai, img)

    const p1 = coord.runOnceForTest()
    const p2 = coord.runOnceForTest()
    const p3 = coord.runOnceForTest()
    await Promise.all([p1, p2, p3])

    const busy = logger.records.filter(r => String(r.msg).includes('busy_skip'))
    assert.ok(busy.length >= 1, 'at least one busy_skip warning emitted for the overlapping call')
    // 3 requests emitted from 3 finish lines.
    const raw = await ctx.database.get('analytics.ai_request', {})
    assert.equal(raw.length, 3)
    // Aggregation should show requestCount=3.
    const daily = await ctx.database.get('analytics.ai_model_daily', {})
    assert.equal(daily.length, 1)
    assert.equal(daily[0].requestCount, 3)
    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('coordinator: dispose stops future ticks', async () => {
  const base = await setupDir()
  try {
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, BASE_CONFIG, logger, ai, img)

    coord.dispose()
    await coord.runOnceForTest()
    assert.equal(logger.records.filter(r => r.level === 'info').length, 0,
      'no scan summary emitted after dispose')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('coordinator: busy_skip warning is rate-limited', async () => {
  const base = await setupDir()
  try {
    await seedYesimbotFile(join(base, 'logs', '2025-06-01-0.log'), 1)
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, BASE_CONFIG, logger, ai, img)

    // Fire a real tick that will run and a chorus of skipped ticks.
    const active = coord.runOnceForTest()
    const skips = [
      coord.runOnceForTest(),
      coord.runOnceForTest(),
      coord.runOnceForTest(),
      coord.runOnceForTest(),
    ]
    await Promise.all([active, ...skips])
    const warns = logger.records.filter(r => String(r.msg).includes('busy_skip'))
    assert.ok(warns.length <= 1,
      `expected <=1 rate-limited busy_skip, got ${warns.length}`)
    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('coordinator: historical marks completed when no matching files remain', async () => {
  const base = await setupDir()
  try {
    // Empty logs dir + historicalImportMode 'full'
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, BASE_CONFIG, logger, ai, img)
    await coord.runOnceForTest()
    const state = await ctx.database.get('analytics.log_import_state', { key: 'historical' })
    assert.equal(state.length, 1)
    assert.equal(state[0].status, 'completed')
    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('coordinator: historical processes cursor-driven batches without rerunning completed dirs', async () => {
  const base = await setupDir()
  try {
    for (let d = 1; d <= 6; d++) {
      const day = String(d).padStart(2, '0')
      await seedYesimbotFile(join(base, 'logs', `2025-06-${day}-0.log`), 1, `2025-06-${day}T00:00:00Z`)
    }
    const config = { ...BASE_CONFIG, maxHistoricalFilesPerBatch: 2 }
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, config, logger, ai, img)

    // Batch 1: first 2 files
    await coord.runOnceForTest()
    let state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.status, 'running')
    assert.equal(state.processedFiles, 2)
    // Batch 2
    await coord.runOnceForTest()
    state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.processedFiles, 4)
    // Batch 3
    await coord.runOnceForTest()
    state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.processedFiles, 6)
    // Batch 4: nothing left, completed
    await coord.runOnceForTest()
    state = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(state.status, 'completed')

    // Extra cycle: completed state must not re-run.
    const before = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    await coord.runOnceForTest()
    const after = (await ctx.database.get('analytics.log_import_state', { key: 'historical' }))[0]
    assert.equal(after.processedFiles, before.processedFiles)

    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('coordinator: historicalImportMode=disabled leaves state untouched', async () => {
  const base = await setupDir()
  try {
    await seedYesimbotFile(join(base, 'logs', '2025-06-01-0.log'), 3)
    const config = { ...BASE_CONFIG, historicalImportMode: 'disabled' }
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, config, logger, ai, img)
    await coord.runOnceForTest()
    const state = await ctx.database.get('analytics.log_import_state', { key: 'historical' })
    assert.equal(state.length, 0, 'no historical state row written when disabled')
    // But live should still have recorded from the file.
    const raw = await ctx.database.get('analytics.ai_request', {})
    assert.equal(raw.length, 3)
    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('coordinator: replay of same file does not duplicate raw records or double-count aggregation', async () => {
  const base = await setupDir()
  try {
    await seedYesimbotFile(join(base, 'logs', '2025-06-01-0.log'), 3)
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, BASE_CONFIG, logger, ai, img)

    await coord.runOnceForTest()
    // Force replay by clearing the offset row.
    await ctx.database.remove('analytics.log_offset_v3', {})
    await coord.runOnceForTest()

    const raw = await ctx.database.get('analytics.ai_request', {})
    assert.equal(raw.length, 3, 'raw table stays de-duplicated by primary key on replay')
    const daily = await ctx.database.get('analytics.ai_model_daily', {})
    assert.equal(daily.length, 1)
    assert.equal(daily[0].requestCount, 3,
      'aggregation recomputes from raw and does not accumulate replays')
    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('coordinator: live discovery keeps only maxRecentFiles', async () => {
  const base = await setupDir()
  try {
    // Create 8 files, only 2 should be scanned per cycle when
    // maxRecentFiles=2. The two kept must be the newest.
    for (let s = 0; s < 8; s++) {
      await seedYesimbotFile(join(base, 'logs', `2025-06-01-${s}.log`), 1, `2025-06-01T00:00:0${s}Z`)
    }
    const config = { ...BASE_CONFIG, maxRecentFiles: 2, historicalImportMode: 'disabled' }
    const ctx = new FakeContext({ baseDir: base })
    const logger = new FakeLogger()
    const ai = new AiRequestService(ctx, logger)
    const img = new ImageGenerationService(ctx, logger)
    const coord = new LogIngestionCoordinator(ctx, config, logger, ai, img)

    await coord.runOnceForTest()
    const offsets = await ctx.database.get('analytics.log_offset_v3', {})
    assert.equal(offsets.length, 2, 'only the newest 2 files were opened this cycle')
    const names = offsets.map(o => o.fileName).sort()
    assert.deepEqual(names, ['2025-06-01-6.log', '2025-06-01-7.log'])
    coord.dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
