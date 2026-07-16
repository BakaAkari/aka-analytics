# Changelog

## 0.4.4

- 修复 Bug 1（终结版）：从 `analytics.log_offset` 表完全移除 `inode` 字段，以 `fileName` 作为唯一标识。
- 修复 Koishi/Minato schema 中不支持 `bigint` 数字类型的问题，避免 64 位 inode 继续触发 integer out of range。

## 0.4.3

- 修复 Bug 1: `analytics.log_offset` 表的 `inode` 字段由 `integer` 改为 `string(63)`，以兼容 64 位文件系统（btrfs）分配的超大 inode。
- 修复因 inode 上限超出 PostgreSQL int4 范围导致的无限刷屏报错。

## 0.4.2

