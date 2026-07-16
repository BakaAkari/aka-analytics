import { stat, open } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { Logger } from 'koishi'

export interface LogFileInfo {
  fileName: string
  fullPath: string
  inode: string
  size: number
}

export interface ReadResult {
  offset: number
  lines: string[]
}

export class LogReader {
  private logger: Logger

  constructor(logger: Logger) {
    this.logger = logger
  }

  async listLogFiles(logDirectory: string): Promise<LogFileInfo[]> {
    const { readdir } = await import('fs/promises')
    const { resolve } = await import('path')
    const entries = await readdir(logDirectory, { withFileTypes: true })
    const files: LogFileInfo[] = []

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue
      const fullPath = resolve(logDirectory, entry.name)
      try {
        const info = await stat(fullPath)
        files.push({
          fileName: entry.name,
          fullPath,
          inode: String(info.ino),
          size: info.size,
        })
      } catch (err) {
        this.logger.warn('failed to stat log file: %s', fullPath, err)
      }
    }

    return files.sort((a, b) => a.fileName.localeCompare(b.fileName))
  }

  async readNewLines(fullPath: string, lastOffset: number): Promise<ReadResult> {
    let fd: FileHandle | undefined
    try {
      const info = await stat(fullPath)
      if (info.size <= lastOffset) {
        return { offset: lastOffset, lines: [] }
      }

      fd = await open(fullPath, 'r')
      const bufferSize = info.size - lastOffset
      const buffer = Buffer.alloc(bufferSize)
      await fd.read(buffer, 0, bufferSize, lastOffset)
      await fd.close()
      fd = undefined

      const text = buffer.toString('utf-8')
      // Some lines may be split across reads, keep last incomplete line for next read
      const lastNewline = text.lastIndexOf('\\n')
      const validText = lastNewline >= 0 ? text.slice(0, lastNewline) : ''
      const pendingOffset = lastNewline >= 0 ? lastOffset + Buffer.byteLength(text.slice(0, lastNewline + 1)) : lastOffset

      const lines = validText
        .split('\\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)

      return { offset: pendingOffset, lines }
    } catch (err) {
      if (fd !== undefined) await fd.close().catch(() => {})
      this.logger.warn('failed to read log file: %s', fullPath, err)
      return { offset: lastOffset, lines: [] }
    }
  }
}
