const { existsSync } = require('node:fs')

const required = [
  'lib/index.js',
  'lib/index.d.ts',
  'lib/services/log-ingestion-coordinator.js',
  'lib/services/log-record-processor.js',
  'lib/services/ingestion-state-service.js',
  'dist/index.js',
]

const forbidden = [
  'lib/services/log-watcher.js',
  'lib/services/historical-log-importer.js',
]

const missing = required.filter(path => !existsSync(path))
const stale = forbidden.filter(path => existsSync(path))

if (missing.length || stale.length) {
  if (missing.length) console.error(`missing package artifacts: ${missing.join(', ')}`)
  if (stale.length) console.error(`stale package artifacts: ${stale.join(', ')}`)
  process.exit(1)
}

console.log(`package artifacts verified: required=${required.length} stale=0`)