# koishi-plugin-aka-analytics

替代官方 `@koishijs/plugin-analytics` 的 Koishi 统计看板插件。

独立源码仓库：`git@github.com:BakaAkari/aka-analytics.git`

## 当前状态

`0.1.0` 是干净基线版：源码基于官方 `@koishijs/plugin-analytics` 复制并改名，保持同等统计范围与 Console 首页显示效果，后续在此基础上扩展更细的统计维度。

## 使用要求

- 启用本插件前需要关闭官方 `@koishijs/plugin-analytics`。
- 本插件继续注册 Console service `analytics`，并继续使用 `analytics.message` 与 `analytics.command` 表，目的是完全替代官方插件并兼容既有统计数据。
- 同时启用官方插件会发生 service、首页 slot、数据库写入重复等冲突，不支持。

## 首版统计范围

- 用户数量、群组数量、今日 DAU。
- 历史消息数量、每小时消息数量、各平台消息占比。
- 指令调用频率。

## 后续方向

- 细化平台、bot、群、用户、指令维度。
- 增加成功 / 失败、异常增长、活跃趋势等运营指标。
- 接入 AI / ChatLuna / 图像生成模型用量、模型占比、积分消耗、用户排行等业务统计。

## 本地开发

```sh
pnpm install
pnpm typecheck
pnpm build
```

首版依赖 `yakumo` 构建 Console 前端，构建产物输出到 `lib/` 与 `dist/`。

## 发布边界

本插件同时保留在 `koishi-dev` 工作区内开发；发布仍优先使用工作区根目录的标准脚本：

```sh
./push.sh aka-analytics
```

`./push.sh aka-analytics` 会执行 typecheck、build 和 npm publish。

## 来源与许可

本插件基础代码复制自 `@koishijs/plugin-analytics` / `koishijs/webui/plugins/analytics`，原项目许可证为 `AGPL-3.0`。本插件保留 `AGPL-3.0` 许可证。
