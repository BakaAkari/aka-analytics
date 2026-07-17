# Changelog

## 0.4.6

- 修复旧表 `analytics.log_offset` 主键约束残留导致 `42P10` upsert 失败的问题：将偏移表更名为 `analytics.log_offset_v2`。
- 修复因 upsert 持续失败导致 Koishi 卡死的问题。

## 0.4.5

