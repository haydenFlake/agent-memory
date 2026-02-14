import { describe, it, expect, beforeEach } from 'vitest'
import { SemanticMemory } from './semantic.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider } from '../core/types.js'

class MockEmbeddingProvider implements EmbeddingProvider {
  private callCount = 0

  async embed(text: string): Promise<number[]> {
    this.callCount++
    const hash = Array.from(text).reduce((a, c) => a + c.charCodeAt(0), 0)
    return Array.from({ length: 384 }, (_, i) => Math.sin(hash + i * 0.1))
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)))
  }

  dimensions(): number {
    return 384
  }
}

// Mock LanceStorage that stores in memory
class MockLanceStorage {
  private records: Array<{ memory_id: string; memory_type: string; vector: number[]; content: string; created_at: string }> = []

  async add(memoryId: string, memoryType: string, vector: number[], content: string, createdAt: string): Promise<void> {
    this.records.push({ memory_id: memoryId, memory_type: memoryType, vector, content, created_at: createdAt })
  }

  async delete(memoryId: string): Promise<void> {
    this.records = this.records.filter(r => r.memory_id !== memoryId)
  }

  async search(queryVector: number[], limit: number, memoryType?: string) {
    let filtered = this.records
    if (memoryType) {
      filtered = filtered.filter(r => r.memory_type === memoryType)
    }
    return filtered.slice(0, limit).map(r => ({
      memory_id: r.memory_id,
      memory_type: r.memory_type,
      content: r.content,
      created_at: r.created_at,
      distance: 0.1,
    }))
  }

  async count(): Promise<number> {
    return this.records.length
  }
}

describe('SemanticMemory', () => {
  let sqlite: SqliteStorage
  let lance: MockLanceStorage
  let embeddings: MockEmbeddingProvider
  let semantic: SemanticMemory
  let config: ReturnType<typeof loadConfig>

  beforeEach(() => {
    sqlite = SqliteStorage.inMemory()
    lance = new MockLanceStorage()
    embeddings = new MockEmbeddingProvider()
    config = loadConfig()
    semantic = new SemanticMemory(sqlite, lance as any, embeddings, config)
  })

  describe('core memory', () => {
    it('creates and retrieves a persona block', () => {
      semantic.updateCoreMemory({
        block_type: 'persona',
        block_key: 'default',
        operation: 'replace',
        content: 'I am a helpful coding assistant.',
      })

      const blocks = semantic.getCoreMemory('persona')
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('I am a helpful coding assistant.')
    })

    it('appends to existing block', () => {
      semantic.updateCoreMemory({
        block_type: 'persona',
        block_key: 'default',
        operation: 'replace',
        content: 'Line 1',
      })
      semantic.updateCoreMemory({
        block_type: 'persona',
        block_key: 'default',
        operation: 'append',
        content: 'Line 2',
      })

      const blocks = semantic.getCoreMemory('persona')
      expect(blocks[0].content).toBe('Line 1\nLine 2')
    })

    it('removes a block', () => {
      semantic.updateCoreMemory({
        block_type: 'user_profile',
        block_key: 'alice',
        operation: 'replace',
        content: 'Alice info',
      })

      semantic.updateCoreMemory({
        block_type: 'user_profile',
        block_key: 'alice',
        operation: 'remove',
        content: '',
      })

      expect(semantic.getCoreMemory('user_profile')).toHaveLength(0)
    })

    it('truncates content at max chars on append', () => {
      const longContent = 'x'.repeat(5001)
      semantic.updateCoreMemory({
        block_type: 'persona',
        block_key: 'default',
        operation: 'replace',
        content: longContent,
      })

      const blocks = semantic.getCoreMemory('persona')
      expect(blocks[0].content.length).toBeLessThanOrEqual(5000)
    })

    it('append truncation preserves the beginning, not the tail', () => {
      const beginning = 'BEGINNING_MARKER'
      semantic.updateCoreMemory({
        block_type: 'persona',
        block_key: 'default',
        operation: 'replace',
        content: beginning,
      })

      // Append enough to exceed the 5000 char limit
      const longAppend = 'y'.repeat(5000)
      semantic.updateCoreMemory({
        block_type: 'persona',
        block_key: 'default',
        operation: 'append',
        content: longAppend,
      })

      const blocks = semantic.getCoreMemory('persona')
      expect(blocks[0].content.startsWith(beginning)).toBe(true)
      expect(blocks[0].content.length).toBeLessThanOrEqual(5000)
    })
  })

  describe('entities', () => {
    it('creates a new entity', async () => {
      const entity = await semantic.updateEntity({
        name: 'Alice',
        entity_type: 'person',
        observations: ['Works at Acme Corp'],
        summary: 'A developer',
      })

      expect(entity.name).toBe('Alice')
      expect(entity.entity_type).toBe('person')
      expect(entity.observations).toEqual(['Works at Acme Corp'])
    })

    it('merges observations on update', async () => {
      await semantic.updateEntity({
        name: 'Alice',
        entity_type: 'person',
        observations: ['Fact 1'],
      })

      const updated = await semantic.updateEntity({
        name: 'Alice',
        entity_type: 'person',
        observations: ['Fact 2'],
      })

      expect(updated.observations).toEqual(['Fact 1', 'Fact 2'])
    })

    it('deduplicates observations', async () => {
      await semantic.updateEntity({
        name: 'Alice',
        entity_type: 'person',
        observations: ['Fact 1'],
      })

      const updated = await semantic.updateEntity({
        name: 'Alice',
        entity_type: 'person',
        observations: ['Fact 1', 'Fact 2'],
      })

      expect(updated.observations).toEqual(['Fact 1', 'Fact 2'])
    })

    it('retrieves entity with access tracking', () => {
      sqlite.upsertEntity({
        id: 'test-id',
        name: 'TestEntity',
        entity_type: 'concept',
        summary: null,
        observations: [],
        importance: 0.5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
      })

      const entity = semantic.getEntity('TestEntity')
      expect(entity).not.toBeNull()
      // Access count should have been bumped
      const updated = sqlite.getEntity('TestEntity')
      expect(updated!.access_count).toBe(1)
    })
  })

  describe('relations', () => {
    it('creates a relation between entities', async () => {
      await semantic.updateEntity({ name: 'Alice', entity_type: 'person' })
      await semantic.updateEntity({ name: 'Acme Corp', entity_type: 'organization' })

      const relation = semantic.createRelation({
        from_entity: 'Alice',
        to_entity: 'Acme Corp',
        relation_type: 'works_at',
      })

      expect(relation.relation_type).toBe('works_at')
      expect(relation.valid_until).toBeNull()
    })

    it('throws when entity does not exist', async () => {
      await semantic.updateEntity({ name: 'Alice', entity_type: 'person' })

      expect(() => {
        semantic.createRelation({
          from_entity: 'Alice',
          to_entity: 'NonExistent',
          relation_type: 'knows',
        })
      }).toThrow('Entity not found')
    })

    it('invalidates old relations when creating new ones of same type', async () => {
      await semantic.updateEntity({ name: 'Alice', entity_type: 'person' })
      await semantic.updateEntity({ name: 'Acme', entity_type: 'organization' })

      semantic.createRelation({
        from_entity: 'Alice',
        to_entity: 'Acme',
        relation_type: 'works_at',
      })

      // Create same type of relation again
      semantic.createRelation({
        from_entity: 'Alice',
        to_entity: 'Acme',
        relation_type: 'works_at',
      })

      const activeRelations = semantic.getRelationsFor('Alice', true)
      expect(activeRelations).toHaveLength(1)

      const allRelations = semantic.getRelationsFor('Alice', false)
      expect(allRelations).toHaveLength(2)
    })
  })

  describe('search', () => {
    it('searches knowledge graph', async () => {
      await semantic.updateEntity({
        name: 'TypeScript',
        entity_type: 'tool',
        observations: ['A typed superset of JavaScript'],
        summary: 'Programming language',
      })

      const results = await semantic.searchKnowledge({ query: 'programming language' })
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results[0].name).toBe('TypeScript')
    })
  })
})
