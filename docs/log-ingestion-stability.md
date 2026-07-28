# Log ingestion stability (0.5.1)

**Status:** implemented on `refactor/log-ingestion-stability`, awaiting local acceptance testing. Version remains at `0.5.0`; the changes are recorded under the `Unreleased` section of the changelog.

## Problem

Production Koishi on NAS accumulated approximately **349,537** files under `data/logs/`. The previous log watcher had three compounding defects:

1. **No single-flight.** `LogWatcher` re-entered `scan()` on every 10-second interval AND on `ready`, with no `running`/`disposed`/`AbortController` state to prevent overlapping runs.
2. **Full directory materialization.** `listLogFiles()` called `readdir(path, { withFileTypes: true })` which allocated a `Dirent[]` for all ~350k entries per scan, then `stat()`'d every file whose name ended in `.log`. A single pass measured at ~112 seconds.
3. **Unbounded stream buffer.** `readNewLines()` did `Buffer.alloc(fileSize - lastOffset)` and returned a `string[]` split across the entire remainder, so a large log at first read allocated hundreds of megabytes.

Under 10-second cadence, cycle N+1 started before cycle N returned, layering multi-hundred-megabyte allocations onto each other until Node's heap could not keep up. TCP 5140 continued to accept, but the event loop was starved and HTTP had no chance to respond.

Independently:

- `HistoricalLogImporter.runIfNeeded()` scanned the same directory on every `ready`, using `analytics.log_offset_v2.limit(1)` as its "already done" check. Any single row marked the entire history complete, and clearing the table triggered another 350k-file import.
- `LogOffsetService.update()` silently swallowed errors, so raw record writes could succeed while the offset stayed at zero, guaranteeing replay next cycle.
- `AiRequestService.bufferDaily` incrementally accumulated `ai_model_daily` from each batch, so any replayed batch double-counted the daily rollup even though the raw `ai_request` table remained idempotent via primary-key upsert.
- `LogWatcher.parseLine` and `HistoricalLogImporter.parseLine` were two copies with drifted behavior — the watcher fed `[世界状态]` command-invocation lines into the image parser's command-context tracker, the importer did not.

## Design

The refactor is scoped to bring the ingestion pipeline safely under a bounded and predictable resource envelope while preserving all existing on-disk record semantics.

### `LogIngestionCoordinator`

A single class owns the entire ingestion lifecycle:

- One `setInterval` and one `ctx.on('ready')` hook, both routed through the same `tick()` method.
- `tick()` short-circuits when `running === true`, emitting a rate-limited `busy_skip` warning (at most one every 5 minutes).
- On dispose, `AbortController.abort()` is signalled and the interval is torn down. All in-flight discovery and file reads observe the signal and exit at their next checkpoint.
- Each tick runs live-first, then historical (if enabled and not complete). Both share the same abort signal and lock, so they never overlap each other or a subsequent tick.

### `LogReader`

Reworked to allocate only bounded amounts of memory regardless of directory size.

- `discoverRecent(dir, { maxCandidates })` async-iterates the directory via `opendir()` and maintains a fixed-size `TopKBuffer` keyed by parsed `YYYY-MM-DD-seq`. Non-matching filenames fall back to a stable secondary key (filename compare) so the ordering is deterministic. Only the candidate set (default K = 64) is `stat()`'d.
- `discoverAfterCursor(dir, { cursor, maxCandidates })` uses the same iterator but keeps the smallest-K entries strictly greater than the cursor, for cursor-driven historical batches.
- Both take `signal?: AbortSignal` and `deadlineMs?: number`. When the deadline fires, iteration stops with `deadlineExceeded=true` and `completed=false`; the historical importer will not mark a run "completed" on a partial pass.
- `readBatch(path, startOffset, { chunkBytes, maxBytes, maxLines, signal })` reads at most `maxBytes` and produces at most `maxLines` per call. `chunkBytes` (default 1 MiB) is the largest single `fd.read` allocation. UTF-8 stream decoding preserves multi-byte character boundaries across chunks. CRLF is stripped. The final incomplete line (no trailing `\n`) stays unconsumed, and the returned `newOffset` sits precisely at the byte after the last committed `\n`. Truncation (current size < startOffset) is surfaced as a flag so the coordinator can retry from offset 0.

### `LogRecordProcessor`

Single canonical parse + dispatch, shared by live and historical scans. Encapsulates:

- JSON parse (invalid lines are counted separately from ignored ones).
- `inferSource(name)` + tracked-sources gate.
- Yesimbot / ChatLuna / ImageGenerator parser routing.
- The `[世界状态]` context bridge into the image parser is applied here in one place, so live and historical produce identical records for identical inputs.

The processor is stateful because the underlying parsers carry per-instance state (yesimbot pending requests, image parser last-command tracker, chatluna last-model). One processor instance per coordinator; a fresh processor per test.

### `IngestionStateService`

Replaces the "any offset row means done" heuristic. `analytics.log_import_state` stores per-key state:

- `key = 'historical'` for the current historical import cursor.
- `status ∈ {idle, running, paused, completed, failed}`.
- `cursorFileName` — last filename fully processed. New batches start strictly greater than this.
- `processedFiles`, `processedBytes` (as `double` to survive multi-GB totals), `importedAiRecords`, `importedImageRecords`.
- `startedAt`, `updatedAt`, `completedAt`, `lastError`.

`completed` and `failed` states block automatic retries. Operators re-run by calling `resetHistorical()` (or by manually deleting the state row).

### `AiRequestService`

- `record(requests)` upserts raw records by primary key (unchanged), and marks each `date` as affected.
- `recomputeAffectedDates()` runs once per scan cycle. For each affected date it:
  1. Queries `analytics.ai_request` for all rows on that date, groups by `(source, provider, modelId)`.
  2. Enumerates existing `analytics.ai_model_daily` rows on that date; any tuple absent from the fresh group set is removed (no ghost combinations).
  3. Upserts the freshly computed rows.
- This makes replay idempotent: an offset commit failure followed by a re-read of the same lines produces the same `analytics.ai_request` state (upsert by `id`), the same set of affected dates, and the same recomputed aggregates.

### `LogOffsetService`

- `get(name)` returns the full record or `null`, not just a number, so the coordinator can check `mtimeMs` and detect same-name-but-rewritten files.
- `update(record)` **throws** on failure. Coordinator ordering is: raw record write → aggregate recompute (deferred to end of cycle) → offset commit. On any commit failure, the offset does not advance; next cycle replays the batch; raw table remains stable because primary-key upsert is idempotent; aggregation is idempotent because it recomputes from raw.
- **v2 → v3 compatibility.** The legacy table `analytics.log_offset_v2` was created in 0.4.6 with 4 int columns (`fileName`, `size`, `lastOffset`, `updatedAt`). Any change to its shape triggers a Minato temp-table rebuild whose `INSERT INTO ..._temp SELECT ...` column count would no longer match the existing rows, and Koishi fails to start. 0.5.1 therefore leaves v2 exactly alone and introduces a new table `analytics.log_offset_v3` with wider `double` columns and the additional `mtimeMs` field. Reads consult v3 first; a file whose only record lives in v2 is returned with `mtimeMs = 0`. Writes go only to v3, so a file's next successful commit organically promotes it out of v2 — no startup-time bulk copy of the ~350k v2 rows on the target NAS deployment. v2 read errors degrade to "no offset" with a warning (the file is re-read from zero, downstream tables are idempotent); v3 write errors still throw.

## Ordering guarantees

For every file processed in one cycle:

1. `LogReader.readBatch` produces a bounded `{lines, newOffset, fileSize, fileMtimeMs}`.
2. `LogRecordProcessor.processBatch` parses the lines into raw records.
3. `AiRequestService.record` upserts the raw records AND upserts a row per affected date into `analytics.ai_daily_dirty` (in that order). Both are keyed by a synthetic `id` (raw) or the date integer (dirty), so replay-by-content produces the same primary keys.
4. `ImageGenerationService.record` upserts the image raw records.
5. `LogOffsetService.update` commits the new offset. On failure it throws, `processOneFile` marks the file `failed`, and the historical cursor does NOT advance across it.
6. After all files in the cycle are processed, `AiRequestService.recomputeAffectedDates()` merges the in-memory affected-date set with the on-disk dirty rows and rebuilds `ai_model_daily` per date; each successfully rebuilt date has its dirty row deleted, failed dates stay pending for the next cycle.

### Recovery matrix

| Failure point                                         | Raw table       | Dirty markers                | Offset            | Daily aggregate                     | Recovery on next cycle                                                                 |
|-------------------------------------------------------|-----------------|------------------------------|-------------------|-------------------------------------|----------------------------------------------------------------------------------------|
| Raw upsert throws                                     | Not modified    | Not written                  | Not advanced      | Untouched                           | Re-read the file from the previous offset; raw + dirty written together on success.    |
| Dirty upsert throws (raw already succeeded)           | Contains rows   | Missing                      | Not advanced      | Stale for that date                 | Re-read the file; raw upsert is idempotent by PK; dirty gets written on the retry.     |
| Offset commit throws                                  | Contains rows   | Rows persisted               | Not advanced      | Recomputed at end of cycle if dirty | Re-read from the previous offset; raw + dirty already-idempotent, offset now commits.  |
| Daily recompute throws for a date                     | Contains rows   | Row for that date persists   | Advanced          | Stale for that date                 | Next cycle merges the persistent dirty rows and retries recompute (no new raw needed). |
| Process crash between raw upsert and next recompute   | Contains rows   | Rows persisted               | May have advanced | Stale for those dates               | New process reads dirty rows on first `recomputeAffectedDates()` call and rebuilds.    |

The dirty-marker table (`analytics.ai_daily_dirty`) is the crash-safety anchor: `record()` writes it before the offset advances, and `recomputeAffectedDates()` clears each row only after that date's aggregate is durable.

## Historical cursor advance

`processFiles({stopOnIncomplete: true})` returns a per-file `ProcessedFileResult`. Historical iterates the results in cursor-ascending order and advances the cursor over the leading prefix where `committed && fullyConsumed && !failed && !aborted`. On the first non-successful file it stops the batch — the cursor never straddles a partially-read file. Byte / record deltas in the state row still count the whole cycle's successful commits, but `processedFilesDelta` only counts the advanced-cursor prefix.

## Discovery: resumable, no starvation

`DiscoverySession` (in `log-reader.ts`) owns the async iterator across ticks. `coordinator.runDiscoverySlice()` calls `session.advance({deadlineMs})` each tick; when a full pass has NOT completed, the session stays alive and no files are processed this cycle (a partial snapshot would bias toward whichever end of the directory sorted first). When the pass completes, `session.finalize()` stat()'s the top-K candidates and returns them, then the session is discarded. Live and historical each hold their own session. Under a directory too large to walk within one `maxScanDuration`, iteration resumes across as many ticks as necessary; tail files cannot be permanently starved.

## Configuration

All numeric knobs carry Schema `min` and `max` (see `src/config/index.ts`). Defaults:

- `logWatchInterval` = 60 s (was 10 s)
- `maxRecentFiles` = 64
- `maxHistoricalFilesPerBatch` = 500
- `maxBytesPerFilePerCycle` = 8 MiB
- `logReadChunkBytes` = 1 MiB
- `logReadBatchLines` = 1000
- `maxScanDuration` = 120 s
- `historicalImportMode` = `recent`
- `historicalImportDays` = 30

Migration note: previously users relied on `logWatchInterval = 10_000` for near-realtime dashboards. Under the new implementation, 10-second cadence is safe for tiny log directories but wasteful for our target scale. Users may still override to as low as 5 seconds.

## Observability

Each cycle emits exactly one structured summary log line per phase. Example:

```
log_ingestion phase=live status=partial visited=349537 matched=349537 candidates=64 files=64 bytes=183220 lines=482 ai=7 img=0 invalid=0 hitLimit=1 truncated=0 dates=1 aggWritten=3 aggDeleted=0 discoverMs=114532 totalMs=118203
```

Per-file paths are not logged at info level. Failures emit a single warn line with `phase`, `status`, and `error`. Busy skips are rate-limited to one warning per 5 minutes.

## Testing

`test/*.test.mjs` (run via `pnpm test`) covers:

- **LogReader** — TopK top-largest across 350k simulated entries, TopK earliest-greater-than-cursor, UTF-8 chunk boundary, CRLF, trailing incomplete line, max-bytes / max-lines limits, truncation, file growth between calls, abort signal.
- **LogRecordProcessor** — invalid JSON vs. ignored line counting, yesimbot chat model start+finish sequence, tracked-sources gate, image-generator `[世界状态]` context bridge, `enableAiStats=false` suppression.
- **AiRequestService** — replay does not double-count, stale `(source, provider, model)` combinations for a date are removed, adding a failure record after success rebuilds the row.
- **IngestionStateService** — idle default, patch deltas, reset, persistence across reads.
- **LogIngestionCoordinator** — concurrent tick collapse, dispose stops future ticks, busy-skip rate limiting, historical marks completed when directory is empty, cursor-driven historical progresses across batches, `disabled` leaves state untouched, replay after offset deletion does not duplicate records or aggregates, `maxRecentFiles` cap enforced.
- **Fault-injection** (`test/fault-injection.test.mjs`):
  - Historical cursor never advances past a partially-read file across many ticks; all records eventually ingested exactly once.
  - Injected offset-commit failure on tick 1 leaves the cursor at its prior value; tick 2 with the fault removed recovers, and raw + daily rows are exactly the expected counts.
  - Injected `ai_model_daily` upsert failure keeps the date pending (both in memory and on disk); a second call with no new records retries and clears the dirty marker.
  - A fresh service picks up an on-disk dirty marker left by a prior "process crash" and recomputes without any in-memory hint.
  - `DiscoverySession` walking a fixed-order 300k-entry-then-tail iterator with a 25k-entry-per-slice budget completes across multiple advances and finalizes with the tail files in the top-K.
  - `DiscoverySession.dispose()` calls `iterator.return()` on the underlying source (verified via a generator `finally` block).
  - `historicalImportMode: 'recent'` cursor comparison uses `compareFileName` so numeric seq order is preserved end-to-end.

Tests use `node:test` and a minimal in-memory `FakeDatabase` matching only the subset of Koishi query surface the services touch. No extra runtime dependency was added.

## Known follow-ups

- **Real-time via `Logger.Target`** (0.6.0): even with the bounded reader, live latency is bounded below by `logWatchInterval` (default 60 s). To reach sub-second latency without polling, hook a Koishi `Logger.Target` that feeds the same `LogRecordProcessor`. Disk polling remains as the fallback / historical path. Design intentionally left the processor stateful-and-injectable so it can accept target-driven events without further refactor.
- **Historical throughput vs. schedule**: 34 万文件 × 500-file batches × 60 s cadence ≈ 12 小时 to sweep the whole directory in `full` mode. Acceptable because the process is fully non-blocking; operators can override `maxHistoricalFilesPerBatch` and `logWatchInterval` for offline back-fill.
- **Directory enumeration is still O(entries)**: `opendir` iteration walks every file. This is unavoidable at the filesystem layer without an index. The bounded candidate set + soft deadline turn this into a partial, always-progressing scan rather than a blocking one.
- **Per-file `stat` after discovery is still O(K)**: we only stat 64 candidates per live cycle, so this is negligible.

## Image record `styleName` (temporary fallback)

`aka-ai-image-generator`'s `requestProviderImages` log currently records only `supplier`, `provider`, `modelId`, `modelSource`, `numImages`, `imageUrlsCount`, `resolution`, and `aspectRatio` — there is no real style identifier. The parser therefore leaves `styleName` undefined on every emitted record and only populates `commandName` from the `[世界状态]` context bridge. `AggregationService.getImageStats` computes the style-usage ranking with the pre-existing fallback chain `r.styleName || r.commandName || 'unknown'`, so the "style" chart continues to work — it just groups by command until upstream starts emitting a real style, at which point the parser only needs to fill `styleName` for real.

## Historical `failed` retry policy

`failed` is transient. When a discover or process error surfaces, the state row is patched with `status='failed'` and a `nextRetryAt` computed by `computeRetrySchedule(state)`. The backoff table is `1m → 5m → 15m → 1h (cap)` indexed by `consecutiveFailures`. On the next tick, if `Date.now() >= nextRetryAt`, historical flips back to `running` and retries with a fresh `DiscoverySession`. A clean batch (no per-file commit failures AND cursor advance completed) resets `consecutiveFailures` to 0 and clears `failedAt`/`nextRetryAt`/`lastError`. `completed` and `paused` states are never auto-retried. All schedule fields are persisted, so a restart during the backoff still honors it — a broken NAS cannot make a fresh process busy-loop.

## Historical UTC cutoff

`runHistorical` derives the `recent` mode's cursor floor from `new Date(Date.now() - days * Time.day)` and formats it with `getUTCFullYear` / `getUTCMonth` / `getUTCDate`. This is intentional: Koishi's file logger stamps rotation filenames with `new Date().toISOString()`, which is UTC. Using local-date components would produce a cutoff off by up to a full day for operators outside UTC — and could wrap around midnight, silently skipping the previous UTC day's log. Do not change to local-date formatting without also verifying Koishi's logger.
