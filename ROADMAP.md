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

## 后续版本候选

- `0.2.0`：细化消息和指令维度，增加平台 / bot / 群 / 用户筛选。
- `0.3.0`：接入 `aka-ai-image-generator` 用量事件与积分流水。
- `0.4.0`：新增独立 Analytics 页面，保留首页摘要卡片。
