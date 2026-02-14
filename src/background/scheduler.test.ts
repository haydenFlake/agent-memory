import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BackgroundScheduler } from './scheduler.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider } from '../core/types.js'

class MockEmbeddings implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    return Array.from({ length: 384 }, () => 0)
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => Array.from({ length: 384 }, () => 0))
  }
  dimensions(): number { return 384 }
}

class MockLance {
  async add() {}
  async search() { return [] }
  async delete() {}
  async count() { return 0 }
}

describe('BackgroundScheduler', () => {
  let sqlite: SqliteStorage
  let scheduler: BackgroundScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    sqlite = SqliteStorage.inMemory()
    const config = loadConfig({ anthropicApiKey: null, consolidationInterval: 60000 })
    scheduler = new BackgroundScheduler(
      sqlite,
      new MockLance() as any,
      new MockEmbeddings(),
      config,
    )
  })

  afterEach(() => {
    scheduler.stop()
    vi.useRealTimers()
  })

  it('starts and stops without errors', () => {
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)
  })

  it('does not double-start', () => {
    scheduler.start()
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)
  })

  it('handles stop when not started', () => {
    expect(() => scheduler.stop()).not.toThrow()
  })

  it('sets isRunning correctly through lifecycle', () => {
    expect(scheduler.isRunning).toBe(false)
    scheduler.start()
    expect(scheduler.isRunning).toBe(true)
    scheduler.stop()
    expect(scheduler.isRunning).toBe(false)
  })
})
