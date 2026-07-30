import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LogRecordProcessor } from '../lib/services/log-record-processor.js'
import { FakeLogger } from './support/fake-ctx.mjs'

function jsonl(name, content, timestamp = Date.now()) {
  return JSON.stringify({ name, content, timestamp })
}

const DEFAULT_CONFIG = {
  enableAiStats: true,
  enableImageStats: true,
  chatlunaDefaultModel: 'default/model',
  trackedSources: { yesimbot: true, 'image-generator': true, 'chat-luna': true },
}

test('processBatch counts invalidJson and ignored', () => {
  const p = new LogRecordProcessor(DEFAULT_CONFIG, new FakeLogger())
  const result = p.processBatch([
    'not-json',
    jsonl('unknown-source', 'foo'),
    jsonl('[聊天模型] [deepseek-chat]', '🚀 请求开始 [流式] 模型: deepseek-chat'),
  ])
  assert.equal(result.invalidJson, 1)
  assert.equal(result.ignored, 2, 'unknown-source + start line without a finish are ignored/not emitted')
})

test('processBatch: yesimbot chat model finish emits an ai record', () => {
  const p = new LogRecordProcessor(DEFAULT_CONFIG, new FakeLogger())
  const t = Date.parse('2025-06-01T00:00:00Z')
  const lines = [
    jsonl('[聊天模型] [deepseek-chat]', '🚀 请求开始 [流式] 模型: deepseek-chat', t),
    jsonl('[聊天模型] [deepseek-chat]', '🏁 [流式] 传输完成 | 总耗时: 1234ms | 输入: 100 | 输出: 200', t + 1500),
  ]
  const result = p.processBatch(lines)
  assert.equal(result.aiRecords.length, 1)
  const rec = result.aiRecords[0]
  assert.equal(rec.source, 'yesimbot')
  assert.equal(rec.modelId, 'deepseek-chat')
  assert.equal(rec.promptTokens, 100)
  assert.equal(rec.completionTokens, 200)
  assert.equal(rec.totalTokens, 300)
  assert.equal(rec.latencyMs, 1234)
  assert.equal(rec.success, true)
})

test('processBatch: trackedSources gate skips disabled sources', () => {
  const config = { ...DEFAULT_CONFIG, trackedSources: { yesimbot: false, 'image-generator': true, 'chat-luna': true } }
  const p = new LogRecordProcessor(config, new FakeLogger())
  const t = Date.parse('2025-06-01T00:00:00Z')
  const result = p.processBatch([
    jsonl('[聊天模型] [x]', '🏁 [流式] 传输完成 | 总耗时: 100ms | 输入: 1 | 输出: 1', t),
  ])
  assert.equal(result.aiRecords.length, 0)
  assert.equal(result.ignored, 1)
})

test('processBatch: image-generator success + [世界状态] context', () => {
  const p = new LogRecordProcessor(DEFAULT_CONFIG, new FakeLogger())
  const t = Date.parse('2025-06-01T00:00:00Z')
  const lines = [
    jsonl('[世界状态]', '记录指令调用 | 用户: alice | 指令: 画一张 | 频道: onebot:123', t),
    jsonl('aka-ai-image-generator', "requestProviderImages 调用 { provider: 'openai', modelId: 'gpt-image-2', numImages: 1 }", t + 100),
    jsonl('aka-ai-image-generator:openai', 'provider=openai event=create_success current=1 total=1', t + 200),
  ]
  const result = p.processBatch(lines)
  assert.equal(result.imageRecords.length, 1)
  const rec = result.imageRecords[0]
  assert.equal(rec.userId, 'alice', 'command context bridged from yesimbot [世界状态] line')
  assert.equal(rec.commandName, '画一张')
  assert.equal(rec.provider, 'openai')
  assert.equal(rec.modelId, 'gpt-image-2')
  assert.equal(rec.success, true)
})

test('processBatch: enableAiStats=false suppresses ai emission even for yesimbot', () => {
  const config = { ...DEFAULT_CONFIG, enableAiStats: false }
  const p = new LogRecordProcessor(config, new FakeLogger())
  const t = Date.parse('2025-06-01T00:00:00Z')
  const result = p.processBatch([
    jsonl('[聊天模型] [x]', '🏁 [流式] 传输完成 | 总耗时: 100ms | 输入: 1 | 输出: 1', t),
  ])
  assert.equal(result.aiRecords.length, 0)
})

test('processBatch: [世界状态] context feed follows enableImageStats, not enableAiStats', () => {
  // Regression: the image parser's command-context feed previously sat
  // behind enableAiStats, so enableAiStats=false + enableImageStats=true
  // silently dropped user/command attribution on image records.
  const config = { ...DEFAULT_CONFIG, enableAiStats: false }
  const p = new LogRecordProcessor(config, new FakeLogger())
  const t = Date.parse('2025-06-01T00:00:00Z')
  const result = p.processBatch([
    jsonl('[世界状态]', '记录指令调用 | 用户: alice | 指令: 画一张 | 频道: onebot:123', t),
    jsonl('aka-ai-image-generator', "requestProviderImages 调用 { provider: 'openai', modelId: 'gpt-image-2', numImages: 1 }", t + 100),
    jsonl('aka-ai-image-generator:openai', 'provider=openai event=create_success current=1 total=1', t + 200),
  ])
  assert.equal(result.aiRecords.length, 0, 'ai stats disabled: no ai records')
  assert.equal(result.imageRecords.length, 1)
  assert.equal(result.imageRecords[0].userId, 'alice', 'image attribution survives enableAiStats=false')
  assert.equal(result.imageRecords[0].commandName, '画一张')
})

test('processBatch: enableImageStats=false skips the [世界状态] image-context feed', () => {
  const config = { ...DEFAULT_CONFIG, enableImageStats: false }
  const p = new LogRecordProcessor(config, new FakeLogger())
  const t = Date.parse('2025-06-01T00:00:00Z')
  const result = p.processBatch([
    jsonl('[世界状态]', '记录指令调用 | 用户: alice | 指令: 画一张 | 频道: onebot:123', t),
    jsonl('aka-ai-image-generator', "requestProviderImages 调用 { provider: 'openai', modelId: 'gpt-image-2', numImages: 1 }", t + 100),
    jsonl('aka-ai-image-generator:openai', 'provider=openai event=create_success current=1 total=1', t + 200),
  ])
  assert.equal(result.imageRecords.length, 0, 'image stats disabled: no image records at all')
})
