# Changelog

## 0.4.0

- 新增 AI 调用统计：从 yesimbot 日志解析模型、token 消耗、请求延迟、失败率。
- 新增图像生成统计：从 aka-ai-image-generator 日志解析风格、次数、张数、积分消耗。
- 支持首次安装时全量导入历史日志，之后自动切换为增量监听。
- 新增独立 `/analytics` 页面，带滚动、分区块布局和多周期切换。
- 新增 4 个数据库表：`analytics.ai_request`、`analytics.ai_model_daily`、`analytics.image_generation`、`analytics.log_offset`。

## 0.3.1

- 将周期切换从一日、三日、七日、十五日调整为七日、三十日、九十日，移除低价值短周期选项。
- 将默认统计窗口调整为九十日，确保长周期切换有完整数据来源。

## 0.3.0

