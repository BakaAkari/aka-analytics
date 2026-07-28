import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AiRequestService } from '../lib/services/ai-request-service.js'
import { FakeContext, FakeLogger } from './support/fake-ctx.mjs'

function req(overrides = {}) {
  return {
    id: overrides.id ?? 'r-1',
    timestamp: new Date('2025-06-01T00:00:00Z'),
    date: 20250601,
    hour: 0,
    source: 'yesimbot',
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    userId: '',
    platform: '',
    channelId: '',
    guildId: '',
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    latencyMs: 100,
    firstTokenLatencyMs: 0,
    success: true,
    errorCode: '',
    fallbackFrom: '',
    ...overrides,
  }
}

test('recompute is idempotent under replay', async () => {
  const ctx = new FakeContext()
  const svc = new AiRequestService(ctx, new FakeLogger())

  await svc.record([req({ id: 'a' }), req({ id: 'b', totalTokens: 50, promptTokens: 20, completionTokens: 30 })])
  await svc.recomputeAffectedDates()
  const afterFirst = await ctx.database.get('analytics.ai_model_daily', {})
  assert.equal(afterFirst.length, 1)
  assert.equal(afterFirst[0].requestCount, 2)
  assert.equal(afterFirst[0].totalTokens, 80)
  assert.equal(afterFirst[0].totalLatencyMs, 200)

  // Replay the same batch: upsert-by-id keeps ai_request identical,
  // recompute should still show requestCount=2 (not doubled).
  await svc.record([req({ id: 'a' }), req({ id: 'b', totalTokens: 50, promptTokens: 20, completionTokens: 30 })])
  await svc.recomputeAffectedDates()
  const afterReplay = await ctx.database.get('analytics.ai_model_daily', {})
  assert.equal(afterReplay.length, 1)
  assert.equal(afterReplay[0].requestCount, 2, 'replay does not double-count')
  assert.equal(afterReplay[0].totalTokens, 80)
})

test('recompute clears stale (provider,model) combinations for a date', async () => {
  const ctx = new FakeContext()
  const svc = new AiRequestService(ctx, new FakeLogger())

  // Simulate a prior write that produced ghost data.
  await ctx.database.upsert('analytics.ai_model_daily', [{
    date: 20250601,
    source: 'yesimbot',
    provider: 'ghost',
    modelId: 'ghost-model',
    requestCount: 99,
    successCount: 99,
    failCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
  }])

  await svc.record([req({ id: 'x' })])
  await svc.recomputeAffectedDates()

  const remaining = await ctx.database.get('analytics.ai_model_daily', {})
  assert.equal(remaining.length, 1, 'stale row removed, only fresh row remains')
  assert.equal(remaining[0].provider, 'deepseek')
})

test('recompute rebuilds a date after a failure record is added later', async () => {
  const ctx = new FakeContext()
  const svc = new AiRequestService(ctx, new FakeLogger())

  await svc.record([req({ id: 'ok', success: true })])
  await svc.recomputeAffectedDates()

  await svc.record([req({ id: 'bad', success: false, promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0 })])
  await svc.recomputeAffectedDates()

  const rows = await ctx.database.get('analytics.ai_model_daily', {})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requestCount, 2)
  assert.equal(rows[0].successCount, 1)
  assert.equal(rows[0].failCount, 1)
})
