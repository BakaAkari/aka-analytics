import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IngestionStateService } from '../lib/services/ingestion-state-service.js'
import { FakeContext, FakeLogger } from './support/fake-ctx.mjs'

test('fresh state defaults to idle with empty cursor', async () => {
  const ctx = new FakeContext()
  const svc = new IngestionStateService(ctx, new FakeLogger())
  const s = await svc.getHistorical()
  assert.equal(s.status, 'idle')
  assert.equal(s.cursorFileName, '')
})

test('patch merges deltas and persists', async () => {
  const ctx = new FakeContext()
  const svc = new IngestionStateService(ctx, new FakeLogger())
  await svc.patchHistorical({ status: 'running', startedAt: new Date('2025-01-01') })
  await svc.patchHistorical({
    cursorFileName: '2025-06-01-3.log',
    processedFilesDelta: 12,
    processedBytesDelta: 1_500_000,
    importedAiRecordsDelta: 300,
    importedImageRecordsDelta: 5,
  })
  const s = await svc.getHistorical()
  assert.equal(s.status, 'running')
  assert.equal(s.cursorFileName, '2025-06-01-3.log')
  assert.equal(s.processedFiles, 12)
  assert.equal(s.processedBytes, 1_500_000)
  assert.equal(s.importedAiRecords, 300)
  assert.equal(s.importedImageRecords, 5)
})

test('reset clears state', async () => {
  const ctx = new FakeContext()
  const svc = new IngestionStateService(ctx, new FakeLogger())
  await svc.patchHistorical({ status: 'completed', cursorFileName: 'x.log' })
  await svc.resetHistorical()
  const s = await svc.getHistorical()
  assert.equal(s.status, 'idle')
  assert.equal(s.cursorFileName, '')
})

test('completed state persists across reads (does not silently revert)', async () => {
  const ctx = new FakeContext()
  const svc = new IngestionStateService(ctx, new FakeLogger())
  await svc.patchHistorical({
    status: 'completed',
    completedAt: new Date('2025-06-01T00:00:00Z'),
  })
  const a = await svc.getHistorical()
  const b = await svc.getHistorical()
  assert.equal(a.status, 'completed')
  assert.equal(b.status, 'completed')
})
