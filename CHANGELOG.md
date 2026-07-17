# Changelog

## 0.4.5

- 修复 `analytics.log_offset` 缺少主键导致启动失败的问题：明确设置 `primary: 'fileName'`。
- 修复因表创建失败导致 `aggregationService` 未初始化的例外。

## 0.4.4

- 修复 Bug 1（终结版）：从 `analytics.log_offset` 表完全移除 `inode` 字段，以 `fileName` 作为唯一标识。
- 修复 Koishi/Minato schema 中不支持 `bigint` 数字类型的问题，避免 64 位 inode 继续触发 integer out of range。

## 0.4.3

