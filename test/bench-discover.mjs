// Non-default benchmark that simulates a 350k-entry directory via an
// injected async iterator. Not run under `pnpm test`; invoke manually
// with:  node test/bench-discover.mjs
//
// The point is to confirm that the discovery path stays O(entries) in
// iteration time and O(K) in memory even at production scale.

import { LogReader } from '../lib/utils/log-reader.js'
import { FakeLogger } from './support/fake-ctx.mjs'

async function* iter(entries) {
  for (const e of entries) yield e
}

const N = Number(process.argv[2] ?? 350_000)
const K = Number(process.argv[3] ?? 64)

async function* lazyEntries(count) {
  for (let i = 0; i < count; i++) {
    const d = 1 + (i % 30)
    const s = Math.floor(i / 30)
    yield { name: `2025-01-${String(d).padStart(2, '0')}-${s}.log`, isFile: () => true }
  }
}

// Warm up so measurements exclude JIT startup.
{
  const warm = new LogReader(new FakeLogger())
  await warm.discoverRecent('/nowhere', {
    maxCandidates: K,
    entrySource: lazyEntries(1000),
    statFn: async () => ({ size: 100, mtimeMs: 0 }),
  })
}
if (global.gc) global.gc()

const before = process.memoryUsage().heapUsed
const start = Date.now()
const reader = new LogReader(new FakeLogger())
const result = await reader.discoverRecent('/nowhere', {
  maxCandidates: K,
  entrySource: lazyEntries(N),
  statFn: async () => ({ size: 100, mtimeMs: 0 }),
})
const elapsed = Date.now() - start
const after = process.memoryUsage().heapUsed

console.log(`entries=${N} K=${K} candidates=${result.candidateFiles} matched=${result.matchedFiles} visited=${result.visitedEntries} completed=${result.completed}`)
console.log(`duration_ms=${elapsed} heap_delta_kb=${((after - before) / 1024).toFixed(1)}`)
console.log(`newest=${result.files[result.files.length - 1]?.fileName}`)
