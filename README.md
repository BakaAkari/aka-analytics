# koishi-plugin-aka-analytics

替代官方 `@koishijs/plugin-analytics` 的 Koishi 统计看板插件。

独立源码仓库：`git@github.com:BakaAkari/aka-analytics.git`

## 当前状态

`0.3.1` 在官方 `@koishijs/plugin-analytics` 替代基线上，将低价值的单平台消息占比卡片替换为用户用量排行，优先显示已采集到的 Lark 用户名，并支持四个首页统计面板按七日、三十日、九十日切换统计周期。

## 使用要求

- 启用本插件前需要关闭官方 `@koishijs/plugin-analytics`。
- 本插件继续注册 Console service `analytics`，并继续使用 `analytics.message` 与 `analytics.command` 表，目的是完全替代官方插件并兼容既有统计数据。
- 用户用量排行会额外维护 `analytics.user` 用户资料映射表；配合 `aka-adapter-lark` 的用户资料补全能力时，可显示 Lark 用户名。
- 同时启用官方插件会发生 service、首页 slot、数据库写入重复等冲突，不支持。

## 首版统计范围

- 用户数量、群组数量、今日 DAU。
- 历史消息数量、每小时消息数量。
- 指令调用频率、用户用量排行。
- 首页四个统计面板支持七日、三十日、九十日周期切换。

## 后续方向

- 细化群、用户、指令维度。
- 增加成功 / 失败、异常增长、活跃趋势等运营指标。
- 接入 AI / ChatLuna / 图像生成模型用量、模型占比、积分消耗、用户排行等业务统计。

## 日志采集配置（0.5.1 起）

`aka-analytics` 通过轮询 Koishi `data/logs/` 目录下的 `YYYY-MM-DD-N.log` 文件采集 yesimbot、chat-luna、aka-ai-image-generator 的运行日志。当日志目录累积到十万到百万级文件时，粗糙的实现会导致 Koishi 事件循环 stall。0.5.1 起采用有界发现 + 流式读取 + 状态机，可安全应对 34 万级目录。

主要可调项（均可在 Koishi Console 插件设置面板中修改）：

| 配置 | 默认 | 说明 |
| ---- | ---- | ---- |
| `logWatchInterval` | 60 秒 | 每轮扫描间隔，最小 5 秒。 |
| `maxRecentFiles` | 64 | 实时扫描保留的最近文件数上限（`opendir` 迭代过程中的候选集大小）。 |
| `maxHistoricalFilesPerBatch` | 500 | 单次历史导入批次的文件数。 |
| `maxBytesPerFilePerCycle` | 8 MiB | 单文件单轮读取的最大字节数。 |
| `logReadChunkBytes` | 1 MiB | `fd.read` 单次分配的缓冲区大小。 |
| `logReadBatchLines` | 1000 | 单文件单轮生成的最大行数。 |
| `maxScanDuration` | 120 秒 | 目录发现阶段的软性超时，超时后本轮返回 partial 结果。 |
| `historicalImportMode` | `recent` | 历史导入策略：`disabled` / `recent` / `full`（`full` 会扫描整个目录，谨慎启用）。 |
| `historicalImportDays` | 30 | `recent` 模式覆盖的天数。 |

历史导入使用独立的 `analytics.log_import_state` 表记录状态（`idle` / `running` / `paused` / `completed` / `failed`），完成后不会再自动重跑；如需重新导入请手工清空该表的 `historical` 行。每日聚合按受影响日期从 `analytics.ai_request` 原始表整体重算，因此 offset 提交失败后的重放不会造成 `ai_model_daily` 双计。

极端目录（34 万文件级别）下已知延迟：

- 单轮实时扫描的 `opendir` 迭代仍会耗时（数十秒到一分钟量级），但事件循环仍可响应；`maxScanDuration` 达到软性超时时会返回 partial 结果而不是无限等待。
- 历史导入默认只回填 30 天窗口；`full` 模式下每 60 秒完成一批 500 个文件，34 万级目录需要多个小时才能全部完成（可接受，因为运行时并不 block）。

## 本地开发

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

首版依赖 `yakumo` 构建 Console 前端，构建产物输出到 `lib/` 与 `dist/`。测试使用内置 `node:test`，不引入额外重型框架。

## 发布边界

本插件同时保留在 `koishi-dev` 工作区内开发；发布仍优先使用工作区根目录的标准脚本：

```sh
./push.sh aka-analytics
```

`./push.sh aka-analytics` 会执行 typecheck、build 和 npm publish。

## 来源与许可

本插件基础代码复制自 `@koishijs/plugin-analytics` / `koishijs/webui/plugins/analytics`，原项目许可证为 `AGPL-3.0`。本插件保留 `AGPL-3.0` 许可证。
