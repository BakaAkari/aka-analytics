import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LogReader, parseFileSortKey, compareFileName } from '../lib/utils/log-reader.js'
import { FakeLogger } from './support/fake-ctx.mjs'

function fakeDirent(name) {
  return { name, isFile: () => true }
}

async function* iter(entries) {
  for (const e of entries) yield e
}

test('parseFileSortKey handles Koishi pattern and fallbacks', () => {
  assert.deepEqual(parseFileSortKey('2026-01-15-42.log'), {
    dateNum: 20260115, seq: 42, fallbackName: '2026-01-15-42.log',
  })
  assert.deepEqual(parseFileSortKey('weird.log'), {
    dateNum: 0, seq: 0, fallbackName: 'weird.log',
  })
  assert.equal(Math.sign(compareFileName('2026-01-15-0.log', '2026-01-15-10.log')), -1)
  assert.equal(Math.sign(compareFileName('2026-02-01-0.log', '2026-01-15-99.log')), 1)
})

test('discoverRecent keeps only top-K largest across 350k entries', async () => {
  const reader = new LogReader(new FakeLogger())
  const names = []
  for (let d = 1; d <= 30; d++) {
    for (let s = 0; s < 1000; s++) {
      names.push(`2025-01-${String(d).padStart(2, '0')}-${s}.log`)
    }
  }
  // Add tens of thousands of unmatched entries.
  for (let i = 0; i < 320_000; i++) names.push(`ignored-${i}.txt`)

  let statCalls = 0
  const result = await reader.discoverRecent('/nowhere', {
    maxCandidates: 64,
    entrySource: iter(names.map(fakeDirent)),
    statFn: async () => { statCalls++; return { size: 100, mtimeMs: 0 } },
  })
  assert.equal(result.candidateFiles, 64, 'candidate cap enforced')
  assert.equal(statCalls, 64, 'stat called only on candidates')
  assert.equal(result.matchedFiles, 30_000)
  assert.equal(result.visitedEntries, 30_000 + 320_000)
  assert.equal(result.completed, true)
  // Files array should be sorted ascending by our compare.
  for (let i = 1; i < result.files.length; i++) {
    assert.ok(compareFileName(result.files[i - 1].fileName, result.files[i].fileName) < 0)
  }
  // Verify we kept the largest 64 (highest date/seq).
  const first = result.files[0].fileName
  const last = result.files[result.files.length - 1].fileName
  assert.equal(last, '2025-01-30-999.log')
  assert.equal(first, '2025-01-30-936.log')
})

test('discoverAfterCursor keeps earliest K strictly greater than cursor', async () => {
  const reader = new LogReader(new FakeLogger())
  const names = []
  for (let d = 1; d <= 10; d++) {
    for (let s = 0; s < 3; s++) names.push(`2025-01-${String(d).padStart(2, '0')}-${s}.log`)
  }
  const result = await reader.discoverAfterCursor('/nowhere', {
    cursor: '2025-01-03-2.log',
    maxCandidates: 5,
    entrySource: iter(names.map(fakeDirent)),
    statFn: async () => ({ size: 100, mtimeMs: 0 }),
  })
  assert.equal(result.files.length, 5)
  assert.equal(result.files[0].fileName, '2025-01-04-0.log')
  assert.equal(result.files[4].fileName, '2025-01-05-1.log')
})

test('discovery deadline flags partial and skips stat when aborted', async () => {
  const reader = new LogReader(new FakeLogger())
  async function* slow() {
    yield fakeDirent('2025-01-01-0.log')
    // Simulate time passing per iteration.
    await new Promise(r => setTimeout(r, 30))
    yield fakeDirent('2025-01-01-1.log')
    await new Promise(r => setTimeout(r, 30))
    yield fakeDirent('2025-01-01-2.log')
  }
  const result = await reader.discoverRecent('/nowhere', {
    maxCandidates: 10,
    entrySource: slow(),
    deadlineMs: 20,
    statFn: async () => ({ size: 100, mtimeMs: 0 }),
  })
  assert.equal(result.deadlineExceeded, true)
  assert.equal(result.completed, false)
})

test('readBatch: line boundaries, CRLF, and trailing incomplete line', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aka-log-'))
  const path = join(dir, '2025-01-01-0.log')
  await writeFile(path, 'line one\r\nline two\nincomplete')
  try {
    const reader = new LogReader(new FakeLogger())
    const r = await reader.readBatch(path, 0, {
      chunkBytes: 4, maxBytes: 1024, maxLines: 100,
    })
    assert.deepEqual(r.lines, ['line one', 'line two'])
    assert.equal(r.newOffset, 'line one\r\nline two\n'.length)
    assert.equal(r.truncated, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBatch: UTF-8 multibyte across chunk boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aka-log-'))
  const path = join(dir, '2025-01-01-0.log')
  // Each of the following characters is 3 bytes in UTF-8.
  const line = '中文测试日志\n'
  await writeFile(path, line + line + line)
  try {
    const reader = new LogReader(new FakeLogger())
    const r = await reader.readBatch(path, 0, {
      chunkBytes: 5, maxBytes: 1024, maxLines: 100,
    })
    assert.equal(r.lines.length, 3)
    for (const l of r.lines) assert.equal(l, '中文测试日志')
    assert.equal(r.newOffset, Buffer.byteLength(line + line + line, 'utf-8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBatch: maxBytes limit halts and reports hitLimit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aka-log-'))
  const path = join(dir, '2025-01-01-0.log')
  const line = 'x'.repeat(100) + '\n'
  await writeFile(path, line.repeat(1000))
  try {
    const reader = new LogReader(new FakeLogger())
    const r = await reader.readBatch(path, 0, {
      chunkBytes: 128, maxBytes: 400, maxLines: 10_000,
    })
    assert.equal(r.hitLimit, true)
    assert.ok(r.bytesRead <= 400 + 128, 'bytesRead within chunk-granularity limit')
    // newOffset must be at a line boundary
    assert.equal(r.newOffset % 101, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBatch: maxLines limit halts and reports hitLimit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aka-log-'))
  const path = join(dir, '2025-01-01-0.log')
  await writeFile(path, 'a\n'.repeat(20))
  try {
    const reader = new LogReader(new FakeLogger())
    const r = await reader.readBatch(path, 0, {
      chunkBytes: 1024, maxBytes: 1024, maxLines: 5,
    })
    assert.equal(r.hitLimit, true)
    assert.equal(r.lines.length, 5)
    assert.equal(r.newOffset, 10)  // 5 * "a\n" = 10 bytes
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBatch: truncation detection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aka-log-'))
  const path = join(dir, '2025-01-01-0.log')
  await writeFile(path, 'short\n')
  try {
    const reader = new LogReader(new FakeLogger())
    const r = await reader.readBatch(path, 500, {
      chunkBytes: 1024, maxBytes: 1024, maxLines: 100,
    })
    assert.equal(r.truncated, true)
    assert.equal(r.lines.length, 0)
    assert.equal(r.newOffset, 500)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBatch: file growth between calls advances offset precisely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aka-log-'))
  const path = join(dir, '2025-01-01-0.log')
  await writeFile(path, 'a\nb\n')
  try {
    const reader = new LogReader(new FakeLogger())
    const first = await reader.readBatch(path, 0, {
      chunkBytes: 1024, maxBytes: 1024, maxLines: 100,
    })
    assert.deepEqual(first.lines, ['a', 'b'])
    assert.equal(first.newOffset, 4)
    await appendFile(path, 'c\nd\n')
    const second = await reader.readBatch(path, first.newOffset, {
      chunkBytes: 1024, maxBytes: 1024, maxLines: 100,
    })
    assert.deepEqual(second.lines, ['c', 'd'])
    assert.equal(second.newOffset, 8)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('beginAfterCursorDiscovery: explicit cursor filters out earlier files', async () => {
  const reader = new LogReader(new FakeLogger())
  // Numeric-seq order: -8 < -9 < -10 < -11. With cursor=-9 the session
  // must expose ONLY -10 and -11. This is asserted directly on the
  // session so we don't accidentally rely on the coordinator's offset
  // table masking a discovery-level bug.
  const names = ['2025-06-01-8.log', '2025-06-01-9.log', '2025-06-01-10.log', '2025-06-01-11.log']
  const session = reader.beginAfterCursorDiscovery('/nowhere', {
    maxCandidates: 10,
    cursor: '2025-06-01-9.log',
    entrySource: iter(names.map(fakeDirent)),
    statFn: async () => ({ size: 100, mtimeMs: 0 }),
  })
  const status = await session.advance()
  assert.equal(status.complete, true)
  const result = await session.finalize()
  const surfaced = result.files.map(f => f.fileName).sort()
  assert.deepEqual(surfaced, ['2025-06-01-10.log', '2025-06-01-11.log'])
})

test('readBatch: aborted signal short-circuits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aka-log-'))
  const path = join(dir, '2025-01-01-0.log')
  await writeFile(path, 'x\n'.repeat(1000))
  try {
    const reader = new LogReader(new FakeLogger())
    const ac = new AbortController()
    ac.abort(new Error('nope'))
    const r = await reader.readBatch(path, 0, {
      chunkBytes: 128, maxBytes: 1024, maxLines: 100, signal: ac.signal,
    })
    assert.equal(r.aborted, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
