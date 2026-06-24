# Changelog

## 0.3.1

- 将周期切换从一日、三日、七日、十五日调整为七日、三十日、九十日，移除低价值短周期选项。
- 将默认统计窗口调整为九十日，确保长周期切换有完整数据来源。

## 0.3.0

- 四个首页统计面板新增一日、三日、七日、十五日周期切换；后端同时聚合多周期数据，前端复用统一周期切换控件。
- 将默认统计窗口调整为十五日，确保周期切换有完整数据来源。

## 0.2.1

- 用户用量排行优先显示已采集到的 Lark 用户名；新增 `analytics.user` 用户资料映射表，并在无新映射时回退读取 Koishi `user.name`。

## 0.2.0

- 将首页“各平台消息占比”卡片替换为“用户用量排行”，基于既有 `analytics.command` 历史数据展示最近统计周期内的 Top 10 用户、调用次数、日均调用和常用指令。

## 0.1.3

- 将服务端入口改为 CommonJS 输出，避免 Koishi loader 通过 CJS 加载插件时触发 Koishi ESM loader 兼容问题。

## 0.1.2

- 修复 package `exports` 主入口未提供默认条件导致 Koishi config 解析插件入口失败的问题。

## 0.1.1

- 修复 package `exports` 未暴露 `./package.json` 导致 Koishi registry/config 无法解析插件的问题。

## 0.1.0

- 基于官方 `@koishijs/plugin-analytics` 搭建替代插件 `koishi-plugin-aka-analytics`。
- 保留 `analytics.message`、`analytics.command`、Console service `analytics` 与首页统计卡片。
- 增加 README 与 ROADMAP，明确必须关闭官方 analytics 后使用本插件。
