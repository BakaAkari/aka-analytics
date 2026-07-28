import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LogOffsetService } from '../lib/services/log-offset-service.js'
import { FakeContext, FakeLogger } from './support/fake-ctx.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// ── shape guard — protects against reintroducing the 0.5.0 crash bug ──
//
// The regression this whole task is fixing:
//   0.4.6 shipped analytics.log_offset_v2 with 4 int columns.
//   0.5.0 kept the SAME table name but changed the shape to 5 columns
//   (added mtimeMs) with double byte columns. On startup against a 0.4.x
//   database, Minato rebuilds the table via
//     INSERT INTO ..._temp SELECT fileName,size,lastOffset,updatedAt FROM ...
//   which fails: "table ..._temp has 5 columns but 4 values were supplied".
//
// This test locks the fix in: v2 must retain its ORIGINAL 4-column int
// shape forever; the new fields live in log_offset_v3.

test('schema: log_offset_v2 keeps original 4-column shape', async () => {
  const src = await readFile(join(REPO_ROOT, 'src/index.ts'), 'utf8')
  const block = src.match(/ctx\.model\.extend\(\s*'analytics\.log_offset_v2'\s*,\s*\{([\s\S]*?)\}\s*,\s*\{[\s\S]*?\}\s*\)/)
  assert.ok(block, 'log_offset_v2 model definition found')
  const body = block[1]
  const fieldNames = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1])
  assert.deepEqual(
    fieldNames,
    ['fileName', 'size', 'lastOffset', 'updatedAt'],
    'v2 must expose exactly the original 4 int columns — no mtimeMs, no doubles',
  )
  assert.match(body, /size:\s*'integer'/, 'v2.size stays integer')
  assert.match(body, /lastOffset:\s*'integer'/, 'v2.lastOffset stays integer')
  assert.doesNotMatch(body, /mtimeMs/, 'v2 must NOT contain mtimeMs')
  assert.doesNotMatch(body, /'double'/, 'v2 must NOT contain double columns')
})

test('schema: log_offset_v3 carries the new columns', async () => {
  const src = await readFile(join(REPO_ROOT, 'src/index.ts'), 'utf8')
  const block = src.match(/ctx\.model\.extend\(\s*'analytics\.log_offset_v3'\s*,\s*\{([\s\S]*?)\}\s*,\s*\{[\s\S]*?\}\s*\)/)
  assert.ok(block, 'log_offset_v3 model definition found')
  const body = block[1]
  const fieldNames = [...body.matchAll(/^\s*(\w+)\s*:/gm)].map(m => m[1])
  assert.deepEqual(
    fieldNames,
    ['fileName', 'size', 'lastOffset', 'mtimeMs', 'updatedAt'],
    'v3 exposes the new set — size/lastOffset/mtimeMs as double + updatedAt',
  )
  assert.match(body, /size:\s*'double'/)
  assert.match(body, /lastOffset:\s*'double'/)
  assert.match(body, /mtimeMs:\s*'double'/)
})

// ── service: v3-first / v2-fallback semantics ─────────────────────────

function newService() {
  const ctx = new FakeContext()
  const svc = new LogOffsetService(ctx, new FakeLogger())
  return { ctx, svc }
}

test('get: returns null when neither v3 nor v2 has the file', async () => {
  const { svc } = newService()
  assert.equal(await svc.get('missing.log'), null)
})

test('get: reads from v3 when v3 has the row', async () => {
  const { ctx, svc } = newService()
  await ctx.database.upsert('analytics.log_offset_v3', [{
    fileName: 'a.log', size: 100, lastOffset: 50, mtimeMs: 12345, updatedAt: new Date(1_700_000_000_000),
  }])
  const rec = await svc.get('a.log')
  assert.equal(rec?.lastOffset, 50)
  assert.equal(rec?.mtimeMs, 12345)
})

test('get: falls back to legacy v2 row with mtimeMs=0', async () => {
  const { ctx, svc } = newService()
  await ctx.database.upsert('analytics.log_offset_v2', [{
    fileName: 'old.log', size: 200, lastOffset: 100, updatedAt: new Date(1_600_000_000_000),
  }])
  const rec = await svc.get('old.log')
  assert.ok(rec, 'v2 fallback surfaces the row')
  assert.equal(rec.lastOffset, 100)
  assert.equal(rec.size, 200)
  assert.equal(rec.mtimeMs, 0, 'legacy v2 has no mtimeMs — normalized to 0')
})

test('get: v3 wins over v2 when both tables have the file', async () => {
  const { ctx, svc } = newService()
  await ctx.database.upsert('analytics.log_offset_v2', [{
    fileName: 'both.log', size: 100, lastOffset: 50, updatedAt: new Date(1_600_000_000_000),
  }])
  await ctx.database.upsert('analytics.log_offset_v3', [{
    fileName: 'both.log', size: 999, lastOffset: 900, mtimeMs: 42, updatedAt: new Date(1_700_000_000_000),
  }])
  const rec = await svc.get('both.log')
  assert.equal(rec?.lastOffset, 900, 'newer v3 offset is authoritative')
  assert.equal(rec?.mtimeMs, 42)
})

test('getMany: empty input returns empty map without hitting the DB', async () => {
  const { ctx, svc } = newService()
  let calls = 0
  const orig = ctx.database.get.bind(ctx.database)
  ctx.database.get = async (...args) => { calls++; return orig(...args) }
  const map = await svc.getMany([])
  assert.equal(map.size, 0)
  assert.equal(calls, 0, 'no DB query issued for an empty file list')
})

test('getMany: merges v3 hits + v2 fallback for names missing from v3', async () => {
  const { ctx, svc } = newService()
  await ctx.database.upsert('analytics.log_offset_v3', [{
    fileName: 'new.log', size: 10, lastOffset: 5, mtimeMs: 100, updatedAt: new Date(),
  }])
  await ctx.database.upsert('analytics.log_offset_v2', [
    { fileName: 'legacy1.log', size: 20, lastOffset: 15, updatedAt: new Date() },
    { fileName: 'legacy2.log', size: 30, lastOffset: 20, updatedAt: new Date() },
    // A v2 row that's ALSO in v3 — v3 should win, v2 must not overwrite.
    { fileName: 'new.log', size: 999, lastOffset: 999, updatedAt: new Date() },
  ])
  const map = await svc.getMany(['new.log', 'legacy1.log', 'legacy2.log', 'missing.log'])
  assert.equal(map.size, 3)
  assert.equal(map.get('new.log')?.lastOffset, 5, 'v3 wins for shared name')
  assert.equal(map.get('new.log')?.mtimeMs, 100)
  assert.equal(map.get('legacy1.log')?.lastOffset, 15)
  assert.equal(map.get('legacy1.log')?.mtimeMs, 0)
  assert.equal(map.get('legacy2.log')?.lastOffset, 20)
  assert.equal(map.get('legacy2.log')?.mtimeMs, 0)
  assert.equal(map.has('missing.log'), false)
})

test('update: writes only to v3, never touches v2', async () => {
  const { ctx, svc } = newService()
  await ctx.database.upsert('analytics.log_offset_v2', [{
    fileName: 'a.log', size: 1, lastOffset: 1, updatedAt: new Date(1_600_000_000_000),
  }])
  const v2Before = await ctx.database.get('analytics.log_offset_v2', {})
  await svc.update({ fileName: 'a.log', size: 500, lastOffset: 400, mtimeMs: 777 })

  const v2After = await ctx.database.get('analytics.log_offset_v2', {})
  assert.deepEqual(v2After.map(r => r.lastOffset), v2Before.map(r => r.lastOffset),
    'v2 row must not be mutated — legacy shape is read-only after the upgrade')
  const v3 = await ctx.database.get('analytics.log_offset_v3', {})
  assert.equal(v3.length, 1)
  assert.equal(v3[0].fileName, 'a.log')
  assert.equal(v3[0].lastOffset, 400)
  assert.equal(v3[0].mtimeMs, 777)
})

test('update: v3 write failure propagates (must not silently strand progress)', async () => {
  const { ctx, svc } = newService()
  const orig = ctx.database.upsert.bind(ctx.database)
  ctx.database.upsert = async (table, rows) => {
    if (table === 'analytics.log_offset_v3') throw new Error('injected v3 write failure')
    return orig(table, rows)
  }
  await assert.rejects(
    () => svc.update({ fileName: 'x.log', size: 1, lastOffset: 1, mtimeMs: 1 }),
    /injected v3 write failure/,
  )
})

test('v2 read failure degrades to no offset (does NOT throw)', async () => {
  const ctx = new FakeContext()
  const logger = new FakeLogger()
  const svc = new LogOffsetService(ctx, logger)
  const orig = ctx.database.get.bind(ctx.database)
  ctx.database.get = async (table, filter) => {
    if (table === 'analytics.log_offset_v2') throw new Error('injected legacy read failure')
    return orig(table, filter)
  }
  const rec = await svc.get('legacy.log')
  assert.equal(rec, null, 'v2 read failure → no offset, next cycle re-reads from 0')
  assert.ok(
    logger.find('warn', 'v2_fallback_read_failed').length >= 1,
    'v2 read failure is logged as a warning, not swallowed silently',
  )
})

// ── organic migration: a v2 file promotes to v3 on next commit ─────

test('migration path: v2 row is superseded by v3 write on next scan', async () => {
  const { ctx, svc } = newService()
  // Seed a database that looks like a 0.4.6 install: v2 has offsets;
  // v3 is empty (new column just created by the model.extend).
  await ctx.database.upsert('analytics.log_offset_v2', [
    { fileName: 'file-a.log', size: 100, lastOffset: 100, updatedAt: new Date(1_600_000_000_000) },
    { fileName: 'file-b.log', size: 200, lastOffset: 200, updatedAt: new Date(1_600_000_000_000) },
  ])

  // First read: both files come out of the v2 fallback with mtimeMs=0.
  const before = await svc.getMany(['file-a.log', 'file-b.log'])
  assert.equal(before.get('file-a.log')?.mtimeMs, 0)
  assert.equal(before.get('file-b.log')?.mtimeMs, 0)

  // Simulate the coordinator processing file-a: it commits a fresh
  // offset. That write goes only to v3.
  await svc.update({ fileName: 'file-a.log', size: 150, lastOffset: 150, mtimeMs: 1234 })

  // Next read: file-a comes from v3 (with real mtimeMs), file-b still
  // from v2 (mtimeMs=0). No batch copy required.
  const after = await svc.getMany(['file-a.log', 'file-b.log'])
  assert.equal(after.get('file-a.log')?.lastOffset, 150)
  assert.equal(after.get('file-a.log')?.mtimeMs, 1234, 'file-a promoted to v3')
  assert.equal(after.get('file-b.log')?.lastOffset, 200)
  assert.equal(after.get('file-b.log')?.mtimeMs, 0, 'file-b still on v2 until it is scanned')

  // v2 remains intact — nothing rewrites it.
  const v2 = await ctx.database.get('analytics.log_offset_v2', {})
  assert.equal(v2.length, 2, 'v2 rows preserved verbatim')
})
