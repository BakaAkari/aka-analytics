# Changelog

## 0.1.1

- 修复 package `exports` 未暴露 `./package.json` 导致 Koishi registry/config 无法解析插件的问题。

## 0.1.0

- 基于官方 `@koishijs/plugin-analytics` 搭建替代插件 `koishi-plugin-aka-analytics`。
- 保留 `analytics.message`、`analytics.command`、Console service `analytics` 与首页统计卡片。
- 增加 README 与 ROADMAP，明确必须关闭官方 analytics 后使用本插件。
