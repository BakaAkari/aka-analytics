# Changelog

## 0.4.7

- **新功能：插件源过滤**（#akari）。添加 `trackedSources` 配置项，在插件设置页面中列出所有可统计来源并支持启用/禁用开关。解析器现在通过 `log.name` 字段识别日志来源，仅处理已启用的来源。
- **新功能：trackedSources 配置 UI**。`Schema.dict(Boolean)` 在 Koishi 配置页渲染为键值对列表，每个插件名对应一个开关，默认全部启用。
- **修复：立即刷新，不缓存到 500 条**。历史导入器和日志监控器现在每个文件处理完后立即写入数据库，不再等待累积到 500 条才 flush。
- 移除旧版 `enableAiStats` / `enableImageStats` 开关的 `parseLine` 中逐个遍历所有 parser 的模式，改为按 `source` 路由到对应 parser。

# Changelog

## 0.4.6

- 修复旧表 `analytics.log_offset` 主键约束残留导致 `42P10` upsert 失败的问题：将偏移表更名为 `analytics.log_offset_v2`。
- 修复因 upsert 持续失败导致 Koishi 卡死的问题。

## 0.4.5