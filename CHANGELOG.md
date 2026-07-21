# Changelog

## 0.5.0

- **修复：token 统计双倍计数**。7-14 起 yesimbot 同一调用同时写「传输完成」与「心跳 Token 消耗」两条日志，两种格式都被采集导致统计量约翻倍。现在仅保留带延迟信息的「传输完成」格式。
- **修复：ai_model_daily 聚合竞态死循环**。`aggregateDaily` 的 get+set 读改写在高频扫描下与部分写入冲突，反复 INSERT 相同主键报 `duplicate key` 并中断扫描。改为按日期缓冲、扫描结束统一 flush，每天只聚合一次。
- **修复：log-reader 换行符字面量 bug**。`lastIndexOf('\\n')` / `split('\\n')` 使用字符串字面量而非真实换行符，导致日志监控器永远读不到任何行。
- **修复：PostgreSQL upsert override 误用**。`ctx.database.upsert` 第三个参数是主键数组而非 `{ override }` 选项，旧写法导致 `value.replace is not a function`。
- **修复：chatluna 日志 ANSI 转义序列**。颜色代码导致 token 用量正则匹配失败，解析前统一剥离。
- **重构：移除独立分析面板，整合进欢迎页**。AI 调用统计卡片与 5 张分析图表（token 趋势 / 模型占比 / 失败率 / 用户排行 / 图像风格排行）全部迁移至 Koishi Console 首页，与基础统计 UI 格式统一。
- **修复：numeric 组件丢弃 value/unit props**。AI 统计卡片曾因 props 未声明渲染为占位符 `-`。

## 0.4.6

- 修复旧表 `analytics.log_offset` 主键约束残留导致 `42P10` upsert 失败的问题：将偏移表更名为 `analytics.log_offset_v2`。
- 修复因 upsert 持续失败导致 Koishi 卡死的问题。

## 0.4.5