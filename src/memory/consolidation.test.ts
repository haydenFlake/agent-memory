import { describe, it, expect, beforeEach } from 'vitest'
import { ConsolidationEngine } from './consolidation.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider, Entity } from '../core/types.js'
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
  records: Array<{ memory_id: string }> = []
  async add(memoryId: string): Promise<void> {
    this.records.push({ memory_id: memoryId })
  }
  async delete(memoryId: string): Promise<void> {
    this.records = this.records.filter(r => r.memory_id !== memoryId)
  }
  async search() { return [] }
  async count() { return this.records.length }
}

function insertEntity(sqlite: SqliteStorage, name: string, observations: string[], daysOld: number = 0): Entity {
  const date = new Date()
  date.setDate(date.getDate() - daysOld)
  const entity: Entity = {
    id: generateId(),
    name,
    entity_type: 'concept',
    summary: null,
    observations,
    importance: 0.5,
    created_at: date.toISOString(),
    updated_at: date.toISOString(),
    accessed_at: null,
    access_count: 0,
  }
  sqlite.upsertEntity(entity)
  return entity
}

describe('ConsolidationEngine', () => {
  let sqlite: SqliteStorage
  let lance: MockLance
  let embeddings: MockEmbeddings
  let engine: ConsolidationEngine

  beforeEach(() => {
    sqlite = SqliteStorage.inMemory()
    lance = new MockLance()
    embeddings = new MockEmbeddings()
    const config = loadConfig({ anthropicApiKey: null })
    engine = new ConsolidationEngine(sqlite, lance as any, embeddings, config)
  })

  it('returns zeros when no entities exist', async () => {
    const result = await engine.consolidate()
    expect(result.entities_updated).toBe(0)
    expect(result.observations_pruned).toBe(0)
    expect(result.summaries_refreshed).toBe(0)
  })

  it('prunes observations above 20', async () => {
    const obs = Array.from({ length: 25 }, (_, i) => `Observation ${i}`)
    insertEntity(sqlite, 'TestEntity', obs)

    const result = await engine.consolidate()
    expect(result.observations_pruned).toBe(5)
    expect(result.entities_updated).toBe(1)

    const entity = sqlite.getEntity('TestEntity')
    expect(entity!.observations).toHaveLength(20)
    // Should keep the last 20 (most recent)
    expect(entity!.observations[0]).toBe('Observation 5')
  })

  it('skips entities with 20 or fewer observations', async () => {
    insertEntity(sqlite, 'Small', ['obs1', 'obs2', 'obs3'])

    const result = await engine.consolidate()
    expect(result.entities_updated).toBe(0)
    expect(result.observations_pruned).toBe(0)
  })

  it('sets last_consolidation_at state', async () => {
    await engine.consolidate()
    const state = sqlite.getState('last_consolidation_at')
    expect(state).not.toBeNull()
  })

  it('handles lance failure gracefully', async () => {
    const obs = Array.from({ length: 25 }, (_, i) => `Obs ${i}`)
    insertEntity(sqlite, 'TestEntity', obs)
    embeddings.shouldFail = true

    // Should not throw despite lance error
    const result = await engine.consolidate()
    expect(result.entities_updated).toBe(1)
    expect(result.observations_pruned).toBe(5)

    // SQLite should still be updated
    const entity = sqlite.getEntity('TestEntity')
    expect(entity!.observations).toHaveLength(20)
  })
})
