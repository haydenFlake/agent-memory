import { describe, it, expect, beforeEach } from 'vitest'
import { ReflectionEngine } from './reflection.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider, MemoryEvent } from '../core/types.js'
import { generateId } from '../core/ulid.js'

class MockEmbeddings implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const hash = Array.from(text).reduce((a, c) => a + c.charCodeAt(0), 0)
    return Array.from({ length: 384 }, (_, i) => Math.sin(hash + i * 0.1))
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)))
  }
  dimensions(): number { return 384 }
}

class MockLance {
  records: Array<{ memory_id: string; memory_type: string }> = []
  async add(memoryId: string, memoryType: string, _v: number[], _c: string, _t: string): Promise<void> {
    this.records.push({ memory_id: memoryId, memory_type: memoryType })
  }
  async search() { return [] }
  async delete() {}
  async count() { return this.records.length }
}

function insertEvent(sqlite: SqliteStorage, importance: number, content?: string): MemoryEvent {
  const event: MemoryEvent = {
    id: generateId(),
    agent_id: 'test-agent',
    event_type: 'observation',
    content: content ?? `Event with importance ${importance}`,
    importance,
    entities: [],
    metadata: {},
    created_at: new Date().toISOString(),
    accessed_at: null,
    access_count: 0,
  }
  sqlite.insertEvent(event)
  return event
}

describe('ReflectionEngine', () => {
  let sqlite: SqliteStorage
  let lance: MockLance
  let embeddings: MockEmbeddings

  beforeEach(() => {
    sqlite = SqliteStorage.inMemory()
    lance = new MockLance()
    embeddings = new MockEmbeddings()
  })

  describe('enabled', () => {
    it('returns false without API key', () => {
      const config = loadConfig({ anthropicApiKey: null })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)
      expect(engine.enabled).toBe(false)
    })

    it('returns true with API key', () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test' })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)
      expect(engine.enabled).toBe(true)
    })
  })

  describe('shouldReflect', () => {
    it('returns false without API key', async () => {
      const config = loadConfig({ anthropicApiKey: null })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)
      expect(await engine.shouldReflect('test-agent')).toBe(false)
    })

    it('returns false when cumulative importance below threshold', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 150 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      // 5 events * 0.5 importance * 10 = 25 (below 150)
      for (let i = 0; i < 5; i++) {
        insertEvent(sqlite, 0.5)
      }

      expect(await engine.shouldReflect('test-agent')).toBe(false)
    })

    it('returns true when cumulative importance exceeds threshold', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 10 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      // 5 events * 0.8 importance * 10 = 40 (above 10)
      for (let i = 0; i < 5; i++) {
        insertEvent(sqlite, 0.8)
      }

      expect(await engine.shouldReflect('test-agent')).toBe(true)
    })
  })

  describe('reflect', () => {
    it('returns empty when no API key', async () => {
      const config = loadConfig({ anthropicApiKey: null })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      const reflections = await engine.reflect('test-agent')
      expect(reflections).toEqual([])
    })

    it('returns empty when no unreflected events', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 150 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      const reflections = await engine.reflect('test-agent')
      expect(reflections).toEqual([])
    })

    it('returns empty when threshold not met and force=false', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 9999 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      insertEvent(sqlite, 0.5)

      const reflections = await engine.reflect('test-agent', false)
      expect(reflections).toEqual([])
    })
  })
})
