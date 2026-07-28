# koishi-plugin-aka-analytics Roadmap

## 0.1.0 官方 analytics 替代基线

状态：已搭建基础代码。

目标：

- 复制官方 `@koishijs/plugin-analytics` 源码作为干净基线。
- 发布为独立包 `koishi-plugin-aka-analytics`。
- 保留 Console service `analytics` 和数据表 `analytics.message` / `analytics.command`，确保作为官方插件的替代品使用。
- 明确要求用户关闭官方 `@koishijs/plugin-analytics` 后再启用本插件。

非目标：

- 不在 `0.1.0` 改变统计口径。
- 不在 `0.1.0` 接入 AI 模型用量。
- 不在 `0.1.0` 新增独立统计页面。

## 0.2.0 用户用量排行

状态：已实现。

目标：

- 保留历史消息数量、每小时消息数量、指令调用频率。
- 将单平台场景价值较低的“各平台消息占比”替换为“用户用量排行”。
- 复用既有 `analytics.command` 历史数据，不新增表、不要求重新开始统计。

## 0.2.1 Lark 用户名显示

状态：已实现。

目标：

- 在指令统计时记录会话中的用户显示名。
- 用户用量排行优先显示 Lark 用户名，缺失时回退到 Koishi `user.name` 或内部用户 ID。
- 不改动 `analytics.command` 主键，避免破坏官方 analytics 历史统计兼容性。

## 0.3.0 多周期切换

状态：已实现。

目标：

- 四个首页统计面板统一支持一日、三日、七日、十五日周期切换。
- 后端一次下发多周期聚合结果，避免前端切换时重新请求。
- 历史消息趋势按周期裁剪；每小时消息、指令调用频率、用户用量排行按所选周期重算日均值。

## 0.3.1 周期口径调整

状态：已实现。

目标：

- 移除一日、三日、十五日周期选项。
- 保留七日周期，并新增三十日、九十日周期。
- 默认统计窗口调整为九十日，覆盖当前全部可选周期。

## 0.5.1 日志采集稳定性重构

状态：已完成并通过旧 SQLite 数据库兼容启动验证。

目标：

- 解决 34 万级 `data/logs` 目录导致 Koishi 事件循环 stall / HTTP 无响应的生产故障。
- 引入 `LogIngestionCoordinator` 单飞调度、`opendir` 有界发现、字节精确的流式读取。
- 引入 `analytics.log_import_state` 历史导入状态机，替代「offset 表非空即完成」的粗糙判定。
- 历史导入默认策略 `recent`，仅回填最近 30 天；`full` 需显式启用。
- 每日聚合改为按受影响日期从原始 `analytics.ai_request` 表整体重算，重放幂等。
- 详见 `docs/log-ingestion-stability.md`。

非目标：

- 不改变前端图表与统计口径。
- 不改变现有原始表主键。
- 不注册 Koishi `Logger.Target` 直接接管实时事件（留给 0.6.0）。

## 0.6.0 Logger Target 直接输入（预留）

状态：待评估，尚未开始。

方向：

- 在 aka-analytics 内注册一个 Koishi `Logger.Target`（或等价的 in-process hook），将 yesimbot / chat-luna / aka-ai-image-generator 的日志事件直接送入 `LogRecordProcessor`，让统计不再依赖磁盘日志轮询。
- 磁盘轮询仍保留，作为历史导入与故障回填通路。
- 需要额外处理 target 内部循环日志（aka-analytics 自身日志不能进入被统计通道）。

## 历史版本

- `0.1.0`：官方 analytics 替代基线。
- `0.2.0`：将「各平台消息占比」替换为「用户用量排行」。
- `0.2.1`：Lark 用户名显示。
- `0.3.0`：多周期切换。
- `0.3.1`：周期口径调整（保留 7/30/90 日）。
- `0.4.6`：偏移表更名为 `analytics.log_offset_v2` 以避免 `42P10` upsert 失败。
- `0.5.0`：token 统计双计数修复、aggregate 竞态修复、welcome 页图表整合。

## 后续版本候选

- 独立 Analytics 页面，保留首页摘要卡片。
