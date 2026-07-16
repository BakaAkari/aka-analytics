# Changelog

## 0.4.3

- 修复 Bug 1: `analytics.log_offset` 表的 `inode` 字段由 `integer` 改为 `string(63)`，以兼容 64 位文件系统（btrfs）分配的超大 inode。
- 修复因 inode 上限超出 PostgreSQL int4 范围导致的无限刷屏报错。

## 0.4.2

- 修复 Koishi 插件加载器 unwrapExports 导致 Config schema 不识别的问题：将 Config 作为静态属性挂在 Analytics 类上。

## 0.4.1

- 修复未导出 Config schema 导致插件配置界面不显示配置项的问题。

## 0.4.0

