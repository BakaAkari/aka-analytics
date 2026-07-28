# Changelog

## 0.5.3

- 修复 `0.5.2` npm 包缺失后端 `lib/` 产物的问题：清理构建目录时同时删除 `tsconfig.tsbuildinfo`，避免 TypeScript 增量缓存错误跳过编译。
- 新增发布内容强制校验：发布前必须存在 `lib/index.js`、`lib/services/log-ingestion-coordinator.js` 等当前后端产物，同时禁止旧 `log-watcher` / `historical-log-importer` 残留；任一条件不满足都会阻止打包发布。

## 0.5.2

- 修复 npm 发布包可能混入旧 `lib/` 构建残留的问题；构建前强制清理 `lib` 与 `dist`，确保已删除的 `LogWatcher` / `HistoricalLogImporter` 不再出现在 tarball 中。运行逻辑与 0.5.1 一致。

## 0.5.1

- **重构：日志采集稳定性**。生产 NAS 日志目录累积至约 34.9 万文件，旧实现每 10 秒起一轮 `readdir({withFileTypes: true})` 全量目录物化 + 每文件一次 `stat` + 全文件 `Buffer.alloc(size)`，多个轮次叠加导致 Node 堆内存爆炸、事件循环失联、HTTP 无响应。本次重构：
  - 新增 `LogIngestionCoordinator` 统一调度实时扫描与历史导入，全局 single-flight，`dispose()` 触发 `AbortController`，busy skip 警告限频 5 分钟。
  - 重写 `LogReader`：`opendir()` 异步迭代 + `TopK` 候选集固定内存（默认 K=64/500）；仅对候选执行 `stat`；`readBatch()` 以 UTF-8 边界安全的方式流式读取，字节精确 offset，支持截断、CRLF、末尾未换行、AbortSignal 与 max bytes/lines。
  - 抽出 `LogRecordProcessor`：live 与 historical 共用同一 JSON/source dispatch，`[世界状态]` 上下文馈送 image parser 的行为不再漂移。
  - 新增 `analytics.log_import_state` 历史导入状态机（`idle` / `running` / `paused` / `completed` / `failed` + cursor），取代旧的「offset 表非空即完成」判定；historical 完成后不再重扫，失败保留 lastError。
  - 兼容旧库启动：`analytics.log_offset_v2` 保留原 4 列整型 schema 不动，避免 Minato 在启动时重建表触发 `INSERT INTO ..._temp SELECT fileName,size,lastOffset,updatedAt FROM ...` 列数不匹配（0.5.0 曾把 v2 改成 5 列 + double，直接读 0.4.x 生产库启动失败）。新增独立 `analytics.log_offset_v3`，字段为 `size` / `lastOffset` / `mtimeMs`（均 `double`）+ `updatedAt`，避免大目录累计溢出 int32 并新增 mtime 用于判定同名重写。`LogOffsetService` 读优先 v3，未命中回退 v2（`mtimeMs=0`），所有 update 只写 v3；已在跑的库无需迁移脚本，文件下次被扫描时自然把该行从 v2 迁到 v3。v2 读失败会记录 warning 并按无 offset 处理（后续读一次即可自愈，raw 表主键幂等）；v3 write 失败仍然 throw。
  - `AiRequestService.recomputeAffectedDates()` 从 `analytics.ai_request` 原始表按日期整体重算 `ai_model_daily`，并删除失效的旧 `(source, provider, model)` 组合；offset 提交失败后的重放不会双计。
  - 历史导入默认策略调整为 `historicalImportMode: 'recent'`，仅覆盖最近 `historicalImportDays: 30` 天；如需全量导入需显式改为 `full`。
  - `logWatchInterval` 默认由 10 秒调整为 60 秒，最小 5 秒；新增 `maxRecentFiles` / `maxHistoricalFilesPerBatch` / `maxBytesPerFilePerCycle` / `logReadChunkBytes` / `logReadBatchLines` / `maxScanDuration` 可调项，均带 Schema `min` / `max`。
  - 每轮扫描输出一行 `log_ingestion phase=... status=... ...` 结构化 key=value 汇总日志（visited / matched / candidates / bytes / dates / discoverMs / totalMs），不再打印每个文件路径。
- **修复：审查复审阻断项**。第二轮代码审查发现四个 correctness 阻断项，全部修复：
  - **historical cursor 越过未读完文件**。原实现在 `processFiles` 结束后无条件把 cursor 推到批次最后文件；hitLimit / offset commit 失败 / abort 时也照推。改为 `processFiles` 返回 `ProcessedFileResult[]`（`committed` / `fullyConsumed` / `failed` / `aborted` 等），historical 顺序处理并在首个非 `committed && fullyConsumed` 文件处停止；cursor 只越过连续成功前缀，`processedFilesDelta` 也只统计该前缀。
  - **offset commit 失败但 cursor 仍推进**。任何 raw / dirty / offset 写入失败都会把该文件标记为 `failed`，historical 不越过它；raw 表通过主键 upsert 保持幂等，重放安全。新增 `analytics.ai_daily_dirty` 表持久化待重算日期，`record()` 在 raw upsert 后立即写入 dirty 标记，`recomputeAffectedDates()` 仅在重算成功后删除对应 dirty 行；进程崩溃后新进程从 dirty 表恢复。
  - **聚合失败会丢失 affectedDates**。原实现进入函数即清空 in-memory Set；改为逐日期尝试重算，失败日期保留在 Set + dirty 表；`hasPendingDates()` 仍为 true；下轮无新记录也会重试。coordinator 日志新增 `aggFailed` / `pending` 字段。
  - **partial recent discovery 永久看不到尾部**。`LogReader` 新增 `DiscoverySession`：跨 tick 保留 opendir iterator 和 top-K buffer，`advance()` 支持 `deadlineMs`（生产）与 `maxEntries`（测试）；只有完整走过一圈后 `finalize()` 才发布候选并 stat，避免 partial 快照偏向目录头部导致尾部永久饥饿。coordinator 分别持有 live / historical session。
  - **cursor 比较统一使用 `compareFileName`**。recent-mode cutoff 与 state cursor 的比较改用 `compareFileName()`，与 discovery 内部一致，避免 `-9.log` / `-10.log` 序号裸字符串排序误差。
- **新增：`test/` 目录 + `node:test` 单元测试**。共 57 项：discovery top-K + 可续跑（含 35 万条固定顺序 iterator 尾部文件必然被发现）、流式读取（UTF-8 / CRLF / 截断 / 增长 / abort / 上限）、processor 分发、AiRequestService 重算幂等 / 失败保留 / 崩溃恢复、historical 状态机 + cursor 前缀推进 + offset commit 失败回滚 + numeric seq 顺序、coordinator 单飞与 busy 限频，以及旧 `log_offset_v2` 到 v3 的兼容读取与自然迁移。
- **文档：新增 `docs/log-ingestion-stability.md`**，记录设计决策、数据一致性策略、故障恢复顺序（raw upsert → dirty 标记 → offset commit → daily recompute → 清 dirty）、配置与已知延迟。

## 0.5.0

- **修复：token 统计双倍计数**。7-14 起 yesimbot 同一调用同时写「传输完成」与「心跳 Token 消耗」两条日志，两种格式都被采集导致统计量约翻倍。现在仅保留带延迟信息的「传输完成」格式。
- **修复：ai_model_daily 聚合竞态死循环**。`aggregateDaily` 的 get+set 读改写在高频扫描下与部分写入冲突，反复 INSERT 相同主键报 `duplicate key` 并中断扫描。改为按日期缓冲、扫描结束统一 flush，每天只聚合一次。
- **修复：log-reader 换行符字面量 bug**。`lastIndexOf('\\n')` / `split('\\n')` 使用字符串字面量而非真实换行符，导致日志监控器永远读不到任何行。
- **修复：PostgreSQL upsert override 误用**。`ctx.database.upsert` 第三个参数是主键数组而非 `{ override }` 选项，旧写法导致 `value.replace is not a function`。
- **修复：chatluna 日志 ANSI 转义序列**。颜色代码导致 token 用量正则匹配失败，解析前统一剥离。
- **重构：移除独立分析面板，整合进欢迎页**。AI 调用统计卡片与 5 张分析图表（token 趋势 / 模型占比 / 失败率 / 用户排行 / 图像风格排行）全部迁移至 Koishi Console 首页，与基础统计 UI 格式统一。
- **修复：numeric 组件丢弃 value/unit props**。AI 统计卡片曾因 props 未声明渲染为占位符 `-`。

## 0.4.6

- 修复旧表 `analytics.log_offset` 主键约束残留导致 `42P10` upsert 失败的问题：将偏移表更名为 `analytics.log_offset_v2`。
- 修复因 upsert 持续失败导致 Koishi 卡死的问题。

## 0.4.5
