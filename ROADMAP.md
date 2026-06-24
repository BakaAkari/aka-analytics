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

## 后续版本候选

- `0.3.0`：接入 `aka-ai-image-generator` 用量事件与积分流水。
- `0.4.0`：新增独立 Analytics 页面，保留首页摘要卡片。
