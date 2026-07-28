// Minimal Koishi-ish Context stub for exercising services in isolation.
// Provides: baseDir, setInterval, on, dispose event, and an in-memory
// database with a subset of the query surface the plugin actually uses
// (get / upsert / remove).
//
// This is NOT a general Koishi mock. If new call sites appear inside the
// services we test, add exactly the missing method here and no more.

export function primaryKeys(table) {
  const keys = {
    'analytics.ai_request': ['id'],
    'analytics.ai_model_daily': ['date', 'source', 'provider', 'modelId'],
    'analytics.image_generation': ['id'],
    'analytics.log_offset_v2': ['fileName'],
    'analytics.log_offset_v3': ['fileName'],
    'analytics.log_import_state': ['key'],
    'analytics.ai_daily_dirty': ['date'],
  }
  const k = keys[table]
  if (!k) throw new Error(`fake-ctx: unknown table ${table}`)
  return k
}

function rowKey(row, keys) {
  return keys.map(k => JSON.stringify(row[k])).join('|')
}

function matches(row, filter) {
  if (!filter) return true
  for (const [field, cond] of Object.entries(filter)) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('$gte' in cond && !(row[field] >= cond.$gte)) return false
      if ('$lt' in cond && !(row[field] < cond.$lt)) return false
      if ('$gt' in cond && !(row[field] > cond.$gt)) return false
      if ('$lte' in cond && !(row[field] <= cond.$lte)) return false
      if ('$in' in cond && !cond.$in.includes(row[field])) return false
    } else {
      if (row[field] !== cond) return false
    }
  }
  return true
}

export class FakeDatabase {
  constructor() {
    this.tables = new Map()
  }

  _table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map())
    return this.tables.get(name)
  }

  async get(table, filter) {
    const t = this._table(table)
    return Array.from(t.values()).filter(r => matches(r, filter))
  }

  async upsert(table, rows) {
    const t = this._table(table)
    const keys = primaryKeys(table)
    for (const r of rows) {
      const key = rowKey(r, keys)
      const prev = t.get(key)
      t.set(key, { ...(prev || {}), ...r })
    }
  }

  async create(table, row) {
    const t = this._table(table)
    const keys = primaryKeys(table)
    const key = rowKey(row, keys)
    if (t.has(key)) throw new Error(`create conflict: ${table} ${key}`)
    t.set(key, { ...row })
    return row
  }

  async remove(table, filter) {
    const t = this._table(table)
    const toDelete = []
    for (const [k, v] of t) if (matches(v, filter)) toDelete.push(k)
    for (const k of toDelete) t.delete(k)
  }

  async set(table, filter, patch) {
    const t = this._table(table)
    for (const [k, v] of t) {
      if (matches(v, filter)) t.set(k, { ...v, ...patch })
    }
  }
}

export class FakeLogger {
  constructor() {
    this.records = []
  }
  info(msg, ...rest) { this.records.push({ level: 'info', msg, rest }) }
  warn(msg, ...rest) { this.records.push({ level: 'warn', msg, rest }) }
  debug(msg, ...rest) { this.records.push({ level: 'debug', msg, rest }) }
  error(msg, ...rest) { this.records.push({ level: 'error', msg, rest }) }
  find(level, needle) {
    return this.records.filter(r => r.level === level && String(r.msg).includes(needle))
  }
}

export class FakeContext {
  constructor(opts = {}) {
    this.baseDir = opts.baseDir ?? process.cwd()
    this.database = opts.database ?? new FakeDatabase()
    this._readyHandlers = []
    this._disposeHandlers = []
  }

  setInterval(fn, ms) {
    const id = setInterval(fn, ms)
    return () => clearInterval(id)
  }

  on(event, fn) {
    if (event === 'ready') this._readyHandlers.push(fn)
    else if (event === 'dispose') this._disposeHandlers.push(fn)
    return () => {}
  }

  async fireReady() {
    for (const fn of this._readyHandlers) await fn()
  }

  async fireDispose() {
    for (const fn of this._disposeHandlers) await fn()
  }
}
