import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ReflectionEngine } from './reflection.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider, MemoryEvent } from '../core/types.js'
import { generateId } from '../core/ulid.js'

class MockEmbeddings implements EmbeddingProvider {
  shouldFail = false
  async embed(text: string): Promise<number[]> {
    if (this.shouldFail) throw new Error('Embedding failed')
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
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 15 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      // 5 events * 0.5 importance = 2.5 (below 15)
      for (let i = 0; i < 5; i++) {
        insertEvent(sqlite, 0.5)
      }

      expect(await engine.shouldReflect('test-agent')).toBe(false)
    })

    it('returns true when cumulative importance exceeds threshold', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 3 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      // 5 events * 0.8 importance = 4.0 (above 3)
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
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 15 })
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

  describe('embed-first safety', () => {
    it('does not create orphaned reflection if embed fails', async () => {
      // We can't fully test reflect() without a real Anthropic client,
      // but we verify that the embed-first pattern means embed runs before insertReflection.
      // The embed call in reflect() is: const vector = await this.embeddings.embed(insight)
      // followed by: this.sqlite.insertReflection(reflection)
      // If embed throws, insertReflection is never called.

      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 1 })
      const failingEmbeddings = new MockEmbeddings()

      // Create a ReflectionEngine with a mock that will fail on embed
      const engine = new ReflectionEngine(sqlite, lance as any, failingEmbeddings, config)

      // Insert events so threshold is met
      for (let i = 0; i < 10; i++) {
        insertEvent(sqlite, 0.8)
      }

      // Mock the private Anthropic client's messages.create to return valid responses
      const mockClient = {
        messages: {
          create: vi.fn()
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Question 1\nQuestion 2\nQuestion 3' }],
            })
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Insight from synthesis' }],
            }),
        },
      }
      ;(engine as any).client = mockClient

      // Make embeddings fail
      failingEmbeddings.shouldFail = true

      // reflect() should not throw (errors are caught in the loop) but no reflections stored
      const reflections = await engine.reflect('test-agent', true)
      expect(reflections).toEqual([])

      // Verify no orphaned reflections in sqlite
      const storedReflections = sqlite.getReflections()
      expect(storedReflections).toHaveLength(0)

      // Verify no records in lance
      expect(lance.records).toHaveLength(0)
    })
  })

  describe('concurrent reflection guard', () => {
    it('second concurrent call returns empty', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 1 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      // Insert events
      for (let i = 0; i < 5; i++) {
        insertEvent(sqlite, 0.8)
      }

      // Mock Anthropic client with a slow response
      let resolveFirst: () => void
      const slowPromise = new Promise<void>(r => { resolveFirst = r })
      const mockClient = {
        messages: {
          create: vi.fn()
            .mockImplementationOnce(async () => {
              await slowPromise
              return { content: [{ type: 'text', text: 'Q1\nQ2\nQ3' }] }
            })
            .mockResolvedValue({ content: [{ type: 'text', text: 'Insight' }] }),
        },
      }
      ;(engine as any).client = mockClient

      // Start first reflection (will hang on slowPromise)
      const firstCall = engine.reflect('test-agent', true)

      // Wait a tick for the first call to set the reflecting flag
      await new Promise(r => setTimeout(r, 10))

      // Second call should return empty immediately
      const secondResult = await engine.reflect('test-agent', true)
      expect(secondResult).toEqual([])

      // Resolve the first call
      resolveFirst!()
      const firstResult = await firstCall
      // First call should complete normally (may have reflections)
      expect(Array.isArray(firstResult)).toBe(true)
    })
  })

  describe('mocked API reflection', () => {
    it('generates reflections with correct source_ids', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 1 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      // Insert events
      const events: MemoryEvent[] = []
      for (let i = 0; i < 5; i++) {
        events.push(insertEvent(sqlite, 0.8, `Important event ${i}`))
      }

      // Mock Anthropic client
      const mockClient = {
        messages: {
          create: vi.fn()
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'What patterns emerge?\nWhat decisions were made?\nWhat was learned?' }],
            })
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Pattern insight based on [1] and [2]' }],
            })
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Decision insight based on [3]' }],
            })
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Learning insight based on [4] and [5]' }],
            }),
        },
      }
      ;(engine as any).client = mockClient

      const reflections = await engine.reflect('test-agent', true)
      expect(reflections.length).toBe(3)

      // source_ids should include ALL unreflected events (not truncated to 50)
      for (const r of reflections) {
        expect(r.source_ids).toHaveLength(5)
        // source_ids come from unreflected events (DESC order), so sort both for comparison
        expect([...r.source_ids].sort()).toEqual([...events.map(e => e.id)].sort())
      }

      // Verify stored in sqlite
      const storedReflections = sqlite.getReflections()
      expect(storedReflections).toHaveLength(3)

      // Verify stored in lance
      expect(lance.records).toHaveLength(3)
      expect(lance.records.every(r => r.memory_type === 'reflection')).toBe(true)
    })

    it('source_ids includes all unreflected events, not just first 50', async () => {
      const config = loadConfig({ anthropicApiKey: 'sk-test', reflectionThreshold: 1 })
      const engine = new ReflectionEngine(sqlite, lance as any, embeddings, config)

      // Insert 60 events (more than the old 50 limit)
      const events: MemoryEvent[] = []
      for (let i = 0; i < 60; i++) {
        events.push(insertEvent(sqlite, 0.5, `Event number ${i}`))
      }

      // Mock Anthropic client
      const mockClient = {
        messages: {
          create: vi.fn()
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Single question?' }],
            })
            .mockResolvedValueOnce({
              content: [{ type: 'text', text: 'Insight from all events' }],
            }),
        },
      }
      ;(engine as any).client = mockClient

      const reflections = await engine.reflect('test-agent', true)
      expect(reflections.length).toBe(1)

      // source_ids should include all 60 events, not truncated to 50
      expect(reflections[0].source_ids).toHaveLength(60)
    })
  })
})
