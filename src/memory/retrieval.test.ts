import { describe, it, expect, beforeEach } from 'vitest'
import { RetrievalEngine } from './retrieval.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider, MemoryEvent } from '../core/types.js'
import { generateId } from '../core/ulid.js'

class MockEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    const hash = Array.from(text).reduce((a, c) => a + c.charCodeAt(0), 0)
    return Array.from({ length: 384 }, (_, i) => Math.sin(hash + i * 0.1))
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)))
  }
  dimensions(): number { return 384 }
}

class MockLanceStorage {
  private records: Array<{ memory_id: string; memory_type: string; vector: number[]; content: string; created_at: string }> = []

  async add(memoryId: string, memoryType: string, vector: number[], content: string, createdAt: string): Promise<void> {
    this.records.push({ memory_id: memoryId, memory_type: memoryType, vector, content, created_at: createdAt })
  }

  async search(queryVector: number[], limit: number, memoryType?: string) {
    let filtered = this.records
    if (memoryType) {
      filtered = filtered.filter(r => r.memory_type === memoryType)
    }
    return filtered.slice(0, limit).map((r, i) => ({
      memory_id: r.memory_id,
      memory_type: r.memory_type as 'event' | 'entity' | 'reflection',
      content: r.content,
      created_at: r.created_at,
      distance: 0.1 + i * 0.05,
    }))
  }

  async delete(memoryId: string): Promise<void> {
    this.records = this.records.filter(r => r.memory_id !== memoryId)
  }

  async count(): Promise<number> { return this.records.length }
}

describe('RetrievalEngine', () => {
  let sqlite: SqliteStorage
  let lance: MockLanceStorage
  let embeddings: MockEmbeddingProvider
  let retrieval: RetrievalEngine

  beforeEach(() => {
    sqlite = SqliteStorage.inMemory()
    lance = new MockLanceStorage()
    embeddings = new MockEmbeddingProvider()
    const config = loadConfig()
    retrieval = new RetrievalEngine(sqlite, lance as any, embeddings, config)
  })

  it('returns empty results when nothing is stored', async () => {
    const result = await retrieval.recall({ query: 'test' })
    expect(result.memories).toHaveLength(0)
    expect(result.core_memory).toHaveLength(0)
  })

  it('includes core memory blocks when requested', async () => {
    sqlite.upsertCoreMemory({
      id: generateId(),
      block_type: 'persona',
      block_key: 'default',
      content: 'I am a test agent',
      updated_at: new Date().toISOString(),
    })

    const result = await retrieval.recall({ query: 'anything', include_core: true })
    expect(result.core_memory).toHaveLength(1)
    expect(result.core_memory[0].content).toBe('I am a test agent')
  })

  it('excludes core memory when not requested', async () => {
    sqlite.upsertCoreMemory({
      id: generateId(),
      block_type: 'persona',
      block_key: 'default',
      content: 'I am a test agent',
      updated_at: new Date().toISOString(),
    })

    const result = await retrieval.recall({ query: 'anything', include_core: false })
    expect(result.core_memory).toHaveLength(0)
  })

  it('retrieves and scores events', async () => {
    const eventId = generateId()
    const event: MemoryEvent = {
      id: eventId,
      agent_id: 'test-agent',
      event_type: 'observation',
      content: 'The user prefers dark mode',
      importance: 0.8,
      entities: [],
      metadata: {},
      created_at: new Date().toISOString(),
      accessed_at: new Date().toISOString(),
      access_count: 0,
    }
    sqlite.insertEvent(event)
    const vector = await embeddings.embed(event.content)
    await lance.add(eventId, 'event', vector, event.content, event.created_at)

    const result = await retrieval.recall({ query: 'dark mode preference' })
    expect(result.memories.length).toBeGreaterThanOrEqual(1)

    const memory = result.memories[0]
    expect(memory.source).toBe('event')
    expect(memory.score).toBeGreaterThan(0)
    expect(memory.recency_score).toBeGreaterThan(0)
    expect(memory.importance_score).toBe(0.8)
    expect(memory.relevance_score).toBeGreaterThan(0)
  })

  it('scores recent memories higher than old ones', async () => {
    const recentId = generateId()
    const oldId = generateId()
    const now = new Date()
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    sqlite.insertEvent({
      id: recentId,
      agent_id: 'test',
      event_type: 'observation',
      content: 'Recent event',
      importance: 0.5,
      entities: [],
      metadata: {},
      created_at: now.toISOString(),
      accessed_at: now.toISOString(),
      access_count: 0,
    })

    sqlite.insertEvent({
      id: oldId,
      agent_id: 'test',
      event_type: 'observation',
      content: 'Old event',
      importance: 0.5,
      entities: [],
      metadata: {},
      created_at: monthAgo.toISOString(),
      accessed_at: monthAgo.toISOString(),
      access_count: 0,
    })

    const recentVector = await embeddings.embed('Recent event')
    const oldVector = await embeddings.embed('Old event')
    await lance.add(recentId, 'event', recentVector, 'Recent event', now.toISOString())
    await lance.add(oldId, 'event', oldVector, 'Old event', monthAgo.toISOString())

    const result = await retrieval.recall({ query: 'event' })
    const recentMemory = result.memories.find(m => m.id === recentId)
    const oldMemory = result.memories.find(m => m.id === oldId)

    if (recentMemory && oldMemory) {
      expect(recentMemory.recency_score).toBeGreaterThan(oldMemory.recency_score)
    }
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      const id = generateId()
      sqlite.insertEvent({
        id,
        agent_id: 'test',
        event_type: 'observation',
        content: `Event ${i}`,
        importance: 0.5,
        entities: [],
        metadata: {},
        created_at: new Date().toISOString(),
        accessed_at: new Date().toISOString(),
        access_count: 0,
      })
      const vector = await embeddings.embed(`Event ${i}`)
      await lance.add(id, 'event', vector, `Event ${i}`, new Date().toISOString())
    }

    const result = await retrieval.recall({ query: 'event', limit: 3 })
    expect(result.memories.length).toBeLessThanOrEqual(3)
  })
})
