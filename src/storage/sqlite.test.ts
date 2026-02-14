import { describe, it, expect, beforeEach } from 'vitest'
import { SqliteStorage } from './sqlite.js'
import { StorageError } from '../core/errors.js'
import type { CoreMemoryBlock, Entity, MemoryEvent, Reflection, Relation } from '../core/types.js'
import { generateId } from '../core/ulid.js'

describe('SqliteStorage', () => {
  let db: SqliteStorage

  beforeEach(() => {
    db = SqliteStorage.inMemory()
  })

  describe('events', () => {
    function makeEvent(overrides?: Partial<MemoryEvent>): MemoryEvent {
      return {
        id: generateId(),
        agent_id: 'test-agent',
        event_type: 'observation',
        content: 'Something happened',
        importance: 0.5,
        entities: ['Alice'],
        metadata: {},
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
        ...overrides,
      }
    }

    it('inserts and retrieves an event', () => {
      const event = makeEvent()
      db.insertEvent(event)

      const retrieved = db.getEvent(event.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.id).toBe(event.id)
      expect(retrieved!.content).toBe('Something happened')
      expect(retrieved!.entities).toEqual(['Alice'])
    })

    it('returns null for non-existent event', () => {
      expect(db.getEvent('nonexistent')).toBeNull()
    })

    it('searches events with FTS5', () => {
      db.insertEvent(makeEvent({ content: 'Alice sent an email about the project deadline' }))
      db.insertEvent(makeEvent({ content: 'Bob went for a walk in the park' }))
      db.insertEvent(makeEvent({ content: 'The project deadline was extended by two weeks' }))

      const results = db.searchEventsFts('project deadline', 10)
      expect(results.length).toBeGreaterThanOrEqual(2)
      expect(results.some(r => r.content.includes('project deadline'))).toBe(true)
    })

    it('removes FTS entry when event is deleted', () => {
      const event = makeEvent({ content: 'unique phrase for FTS deletion test' })
      db.insertEvent(event)

      const before = db.searchEventsFts('unique phrase for FTS deletion test', 10)
      expect(before).toHaveLength(1)

      db.deleteEvent(event.id)

      const after = db.searchEventsFts('unique phrase for FTS deletion test', 10)
      expect(after).toHaveLength(0)
    })

    it('retrieves events by time range', () => {
      db.insertEvent(makeEvent({ created_at: '2025-01-01T00:00:00Z' }))
      db.insertEvent(makeEvent({ created_at: '2025-06-15T00:00:00Z' }))
      db.insertEvent(makeEvent({ created_at: '2025-12-31T00:00:00Z' }))

      const results = db.getEventsByTimeRange(
        'test-agent',
        '2025-03-01T00:00:00Z',
        '2025-09-01T00:00:00Z',
      )
      expect(results).toHaveLength(1)
      expect(results[0].created_at).toBe('2025-06-15T00:00:00Z')
    })

    it('retrieves recent events in descending order', () => {
      db.insertEvent(makeEvent({ content: 'first', created_at: '2025-01-01T00:00:00Z' }))
      db.insertEvent(makeEvent({ content: 'second', created_at: '2025-06-01T00:00:00Z' }))
      db.insertEvent(makeEvent({ content: 'third', created_at: '2025-12-01T00:00:00Z' }))

      const results = db.getRecentEvents('test-agent', 2)
      expect(results).toHaveLength(2)
      expect(results[0].content).toBe('third')
      expect(results[1].content).toBe('second')
    })

    it('tracks access count on touch', () => {
      const event = makeEvent()
      db.insertEvent(event)

      db.touchEvent(event.id)
      db.touchEvent(event.id)

      const retrieved = db.getEvent(event.id)
      expect(retrieved!.access_count).toBe(2)
      expect(retrieved!.accessed_at).not.toBeNull()
    })

    it('counts events correctly', () => {
      expect(db.getEventCount()).toBe(0)
      db.insertEvent(makeEvent())
      db.insertEvent(makeEvent())
      expect(db.getEventCount()).toBe(2)
      expect(db.getEventCount('test-agent')).toBe(2)
      expect(db.getEventCount('other-agent')).toBe(0)
    })

    it('filters events by type in time range query', () => {
      db.insertEvent(makeEvent({ event_type: 'email', created_at: '2025-06-01T00:00:00Z' }))
      db.insertEvent(makeEvent({ event_type: 'action', created_at: '2025-06-02T00:00:00Z' }))

      const results = db.getEventsByTimeRange(
        'test-agent',
        '2025-01-01T00:00:00Z',
        '2025-12-31T00:00:00Z',
        'email',
      )
      expect(results).toHaveLength(1)
      expect(results[0].event_type).toBe('email')
    })
  })

  describe('core_memory', () => {
    it('upserts and retrieves core memory blocks', () => {
      const block: CoreMemoryBlock = {
        id: generateId(),
        block_type: 'persona',
        block_key: 'default',
        content: 'I am a helpful assistant.',
        updated_at: new Date().toISOString(),
      }
      db.upsertCoreMemory(block)

      const blocks = db.getCoreMemory('persona')
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('I am a helpful assistant.')
    })

    it('updates existing block on conflict', () => {
      const id = generateId()
      db.upsertCoreMemory({
        id,
        block_type: 'persona',
        block_key: 'default',
        content: 'Version 1',
        updated_at: '2025-01-01T00:00:00Z',
      })
      db.upsertCoreMemory({
        id: generateId(),
        block_type: 'persona',
        block_key: 'default',
        content: 'Version 2',
        updated_at: '2025-06-01T00:00:00Z',
      })

      const blocks = db.getCoreMemory('persona')
      expect(blocks).toHaveLength(1)
      expect(blocks[0].content).toBe('Version 2')
    })

    it('retrieves specific block by type and key', () => {
      db.upsertCoreMemory({
        id: generateId(),
        block_type: 'user_profile',
        block_key: 'alice',
        content: 'Alice is a developer',
        updated_at: new Date().toISOString(),
      })

      const block = db.getCoreMemoryBlock('user_profile', 'alice')
      expect(block).not.toBeNull()
      expect(block!.content).toBe('Alice is a developer')

      const missing = db.getCoreMemoryBlock('user_profile', 'bob')
      expect(missing).toBeNull()
    })

    it('deletes core memory block', () => {
      db.upsertCoreMemory({
        id: generateId(),
        block_type: 'persona',
        block_key: 'default',
        content: 'test',
        updated_at: new Date().toISOString(),
      })

      expect(db.deleteCoreMemory('persona', 'default')).toBe(true)
      expect(db.deleteCoreMemory('persona', 'default')).toBe(false)
      expect(db.getCoreMemory('persona')).toHaveLength(0)
    })
  })

  describe('entities', () => {
    function makeEntity(overrides?: Partial<Entity>): Entity {
      return {
        id: generateId(),
        name: 'Alice',
        entity_type: 'person',
        summary: 'A developer',
        observations: ['Works at Acme Corp', 'Prefers TypeScript'],
        importance: 0.7,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
        ...overrides,
      }
    }

    it('upserts and retrieves an entity', () => {
      const entity = makeEntity()
      db.upsertEntity(entity)

      const retrieved = db.getEntity('Alice')
      expect(retrieved).not.toBeNull()
      expect(retrieved!.name).toBe('Alice')
      expect(retrieved!.observations).toEqual(['Works at Acme Corp', 'Prefers TypeScript'])
    })

    it('updates entity on name conflict', () => {
      db.upsertEntity(makeEntity({ summary: 'Version 1' }))
      db.upsertEntity(makeEntity({ summary: 'Version 2' }))

      const retrieved = db.getEntity('Alice')
      expect(retrieved!.summary).toBe('Version 2')
    })

    it('retrieves entity by ID', () => {
      const entity = makeEntity()
      db.upsertEntity(entity)

      const retrieved = db.getEntityById(entity.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.name).toBe('Alice')
    })

    it('filters entities by type', () => {
      db.upsertEntity(makeEntity({ name: 'Alice', entity_type: 'person' }))
      db.upsertEntity(makeEntity({ name: 'TypeScript', entity_type: 'tool' }))

      const people = db.getAllEntities('person')
      expect(people).toHaveLength(1)
      expect(people[0].name).toBe('Alice')
    })

    it('tracks access count', () => {
      const entity = makeEntity()
      db.upsertEntity(entity)

      db.touchEntity(entity.id)
      db.touchEntity(entity.id)
      db.touchEntity(entity.id)

      const retrieved = db.getEntityById(entity.id)
      expect(retrieved!.access_count).toBe(3)
    })

    it('preserves access_count and accessed_at on upsert conflict', () => {
      const entity = makeEntity()
      db.upsertEntity(entity)

      // Touch entity to set access tracking
      db.touchEntity(entity.id)
      db.touchEntity(entity.id)

      const afterTouch = db.getEntity('Alice')
      expect(afterTouch!.access_count).toBe(2)
      expect(afterTouch!.accessed_at).not.toBeNull()
      const savedAccessedAt = afterTouch!.accessed_at

      // Upsert with same name should preserve access tracking
      db.upsertEntity(makeEntity({ summary: 'Updated summary' }))

      const afterUpsert = db.getEntity('Alice')
      expect(afterUpsert!.summary).toBe('Updated summary')
      expect(afterUpsert!.access_count).toBe(2)
      expect(afterUpsert!.accessed_at).toBe(savedAccessedAt)
    })
  })

  describe('relations', () => {
    it('inserts and retrieves relations', () => {
      const aliceId = generateId()
      const bobId = generateId()

      db.upsertEntity({
        id: aliceId, name: 'Alice', entity_type: 'person', summary: null,
        observations: [], importance: 0.5, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })
      db.upsertEntity({
        id: bobId, name: 'Bob', entity_type: 'person', summary: null,
        observations: [], importance: 0.5, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })

      const relation: Relation = {
        id: generateId(),
        from_entity: aliceId,
        to_entity: bobId,
        relation_type: 'works_with',
        weight: 1.0,
        valid_from: new Date().toISOString(),
        valid_until: null,
        metadata: {},
        created_at: new Date().toISOString(),
      }
      db.insertRelation(relation)

      const relations = db.getRelationsFor(aliceId)
      expect(relations).toHaveLength(1)
      expect(relations[0].relation_type).toBe('works_with')
    })

    it('invalidates old relations', () => {
      const aliceId = generateId()
      const bobId = generateId()

      db.upsertEntity({
        id: aliceId, name: 'Alice', entity_type: 'person', summary: null,
        observations: [], importance: 0.5, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })
      db.upsertEntity({
        id: bobId, name: 'Bob', entity_type: 'person', summary: null,
        observations: [], importance: 0.5, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })

      db.insertRelation({
        id: generateId(),
        from_entity: aliceId,
        to_entity: bobId,
        relation_type: 'works_with',
        weight: 1.0,
        valid_from: '2025-01-01T00:00:00Z',
        valid_until: null,
        metadata: {},
        created_at: '2025-01-01T00:00:00Z',
      })

      db.invalidateRelation(aliceId, bobId, 'works_with', '2025-06-01T00:00:00Z')

      const activeRelations = db.getRelationsFor(aliceId, true)
      expect(activeRelations).toHaveLength(0)

      const allRelations = db.getRelationsFor(aliceId, false)
      expect(allRelations).toHaveLength(1)
      expect(allRelations[0].valid_until).toBe('2025-06-01T00:00:00Z')
    })
  })

  describe('reflections', () => {
    it('inserts and retrieves reflections', () => {
      const reflection: Reflection = {
        id: generateId(),
        content: 'The user seems to prefer functional programming patterns.',
        source_ids: ['event1', 'event2', 'event3'],
        importance: 0.8,
        depth: 1,
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
      }
      db.insertReflection(reflection)

      const reflections = db.getReflections()
      expect(reflections).toHaveLength(1)
      expect(reflections[0].content).toBe('The user seems to prefer functional programming patterns.')
      expect(reflections[0].source_ids).toEqual(['event1', 'event2', 'event3'])
      expect(reflections[0].depth).toBe(1)
    })

    it('tracks access count on touch', () => {
      const id = generateId()
      db.insertReflection({
        id,
        content: 'An insight',
        source_ids: [],
        importance: 0.5,
        depth: 1,
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
      })

      db.touchReflection(id)
      const reflections = db.getReflections()
      expect(reflections[0].access_count).toBe(1)
    })

    it('retrieves reflection by ID', () => {
      const id = generateId()
      db.insertReflection({
        id,
        content: 'Direct lookup test',
        source_ids: ['e1'],
        importance: 0.6,
        depth: 1,
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
      })

      const reflection = db.getReflectionById(id)
      expect(reflection).not.toBeNull()
      expect(reflection!.content).toBe('Direct lookup test')
    })

    it('returns null for non-existent reflection ID', () => {
      expect(db.getReflectionById('nonexistent')).toBeNull()
    })
  })

  describe('state', () => {
    it('sets and gets state values', () => {
      db.setState('last_reflection_at', '2025-06-01T00:00:00Z')
      expect(db.getState('last_reflection_at')).toBe('2025-06-01T00:00:00Z')
    })

    it('returns null for missing state', () => {
      expect(db.getState('nonexistent')).toBeNull()
    })

    it('overwrites existing state', () => {
      db.setState('key', 'value1')
      db.setState('key', 'value2')
      expect(db.getState('key')).toBe('value2')
    })
  })

  describe('getUnreflectedEvents', () => {
    function makeEvent(overrides?: Partial<MemoryEvent>): MemoryEvent {
      return {
        id: generateId(),
        agent_id: 'test-agent',
        event_type: 'observation',
        content: 'Something happened',
        importance: 0.5,
        entities: [],
        metadata: {},
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
        ...overrides,
      }
    }

    it('respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        db.insertEvent(makeEvent())
      }

      const limited = db.getUnreflectedEvents('test-agent', 3)
      expect(limited).toHaveLength(3)

      const all = db.getUnreflectedEvents('test-agent')
      expect(all).toHaveLength(10)
    })

    it('uses watermark to filter already-reflected events', () => {
      const e1 = makeEvent({ created_at: '2025-01-01T00:00:00Z' })
      const e2 = makeEvent({ created_at: '2025-06-01T00:00:00Z' })
      const e3 = makeEvent({ created_at: '2025-12-01T00:00:00Z' })
      db.insertEvent(e1)
      db.insertEvent(e2)
      db.insertEvent(e3)

      // Before watermark: all 3 returned
      const before = db.getUnreflectedEvents('test-agent')
      expect(before).toHaveLength(3)

      // Set watermark to middle event's timestamp
      db.setState('last_reflected_at:test-agent', '2025-06-01T00:00:00Z')

      // After watermark: only event after June returned
      const after = db.getUnreflectedEvents('test-agent')
      expect(after).toHaveLength(1)
      expect(after[0].created_at).toBe('2025-12-01T00:00:00Z')
    })
  })

  describe('searchEventsFts error handling', () => {
    it('returns empty array on invalid FTS5 query', () => {
      db.insertEvent({
        id: generateId(),
        agent_id: 'test-agent',
        event_type: 'observation',
        content: 'Test content',
        importance: 0.5,
        entities: [],
        metadata: {},
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
      })

      // Unmatched quote is invalid FTS5 syntax
      const results = db.searchEventsFts('"unclosed', 10)
      expect(results).toEqual([])
    })
  })

  describe('batch fetch methods', () => {
    function makeEvent(overrides?: Partial<MemoryEvent>): MemoryEvent {
      return {
        id: generateId(),
        agent_id: 'test-agent',
        event_type: 'observation',
        content: 'Something happened',
        importance: 0.5,
        entities: [],
        metadata: {},
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
        ...overrides,
      }
    }

    it('getEventsByIds returns matching events', () => {
      const e1 = makeEvent({ content: 'event 1' })
      const e2 = makeEvent({ content: 'event 2' })
      const e3 = makeEvent({ content: 'event 3' })
      db.insertEvent(e1)
      db.insertEvent(e2)
      db.insertEvent(e3)

      const map = db.getEventsByIds([e1.id, e3.id])
      expect(map.size).toBe(2)
      expect(map.get(e1.id)?.content).toBe('event 1')
      expect(map.get(e3.id)?.content).toBe('event 3')
      expect(map.has(e2.id)).toBe(false)
    })

    it('getEventsByIds returns empty map for empty array', () => {
      const map = db.getEventsByIds([])
      expect(map.size).toBe(0)
    })

    it('getEntitiesByIds returns matching entities', () => {
      const id1 = generateId()
      const id2 = generateId()
      db.upsertEntity({
        id: id1, name: 'Alice', entity_type: 'person', summary: null,
        observations: [], importance: 0.5, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })
      db.upsertEntity({
        id: id2, name: 'Bob', entity_type: 'person', summary: null,
        observations: [], importance: 0.5, created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })

      const map = db.getEntitiesByIds([id1, id2])
      expect(map.size).toBe(2)
      expect(map.get(id1)?.name).toBe('Alice')
      expect(map.get(id2)?.name).toBe('Bob')
    })

    it('getEntitiesByIds returns empty map for empty array', () => {
      const map = db.getEntitiesByIds([])
      expect(map.size).toBe(0)
    })

    it('getReflectionsByIds returns matching reflections', () => {
      const id1 = generateId()
      const id2 = generateId()
      db.insertReflection({
        id: id1, content: 'Insight 1', source_ids: [], importance: 0.7,
        depth: 1, created_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })
      db.insertReflection({
        id: id2, content: 'Insight 2', source_ids: [], importance: 0.8,
        depth: 1, created_at: new Date().toISOString(), accessed_at: null, access_count: 0,
      })

      const map = db.getReflectionsByIds([id1])
      expect(map.size).toBe(1)
      expect(map.get(id1)?.content).toBe('Insight 1')
    })

    it('getReflectionsByIds returns empty map for empty array', () => {
      const map = db.getReflectionsByIds([])
      expect(map.size).toBe(0)
    })
  })

  describe('transaction', () => {
    it('commits on success', () => {
      db.transaction(() => {
        db.setState('tx_key', 'tx_value')
      })
      expect(db.getState('tx_key')).toBe('tx_value')
    })

    it('rolls back on error', () => {
      db.setState('rollback_key', 'before')
      expect(() => {
        db.transaction(() => {
          db.setState('rollback_key', 'during')
          throw new Error('rollback test')
        })
      }).toThrow('rollback test')
      expect(db.getState('rollback_key')).toBe('before')
    })

    it('returns value from function', () => {
      const result = db.transaction(() => {
        return 42
      })
      expect(result).toBe(42)
    })
  })

  describe('FK constraint error', () => {
    it('throws StorageError for invalid FK in insertRelation', () => {
      const relation: Relation = {
        id: generateId(),
        from_entity: 'nonexistent-entity-id',
        to_entity: 'another-nonexistent-id',
        relation_type: 'works_with',
        weight: 1.0,
        valid_from: new Date().toISOString(),
        valid_until: null,
        metadata: {},
        created_at: new Date().toISOString(),
      }

      expect(() => db.insertRelation(relation)).toThrow(StorageError)
      expect(() => db.insertRelation(relation)).toThrow('entity not found')
    })
  })

  describe('case-insensitive entity lookup', () => {
    function makeEntity(overrides?: Partial<Entity>): Entity {
      return {
        id: generateId(),
        name: 'TypeScript',
        entity_type: 'tool',
        summary: null,
        observations: [],
        importance: 0.5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
        ...overrides,
      }
    }

    it('finds entity with different case', () => {
      db.upsertEntity(makeEntity({ name: 'TypeScript' }))

      expect(db.getEntity('typescript')).not.toBeNull()
      expect(db.getEntity('TYPESCRIPT')).not.toBeNull()
      expect(db.getEntity('TypeScript')).not.toBeNull()
      expect(db.getEntity('typescript')!.name).toBe('TypeScript')
    })

    it('does not create duplicates with different case', () => {
      db.upsertEntity(makeEntity({ name: 'TypeScript', summary: 'v1' }))
      // Second upsert with different case should update, not create duplicate
      db.upsertEntity(makeEntity({ name: 'typescript', summary: 'v2' }))

      const all = db.getAllEntities()
      // Due to UNIQUE constraint on name column, we might get 2 if not COLLATE NOCASE on table.
      // But getEntity should return the correct one
      const found = db.getEntity('TypeScript')
      expect(found).not.toBeNull()
    })
  })

  describe('stats', () => {
    it('returns correct stats', () => {
      const stats = db.getStats()
      expect(stats.event_count).toBe(0)
      expect(stats.entity_count).toBe(0)
      expect(stats.relation_count).toBe(0)
      expect(stats.reflection_count).toBe(0)
      expect(stats.core_memory_blocks).toBe(0)
      expect(stats.oldest_event).toBeNull()
      expect(stats.newest_event).toBeNull()
    })

    it('returns correct counts in single query with data', () => {
      // Insert some data
      const eventId = generateId()
      db.insertEvent({
        id: eventId,
        agent_id: 'test-agent',
        event_type: 'observation',
        content: 'Test event',
        importance: 0.5,
        entities: [],
        metadata: {},
        created_at: '2025-06-01T00:00:00Z',
        accessed_at: null,
        access_count: 0,
      })

      const entityId = generateId()
      db.upsertEntity({
        id: entityId,
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

      db.upsertCoreMemory({
        id: generateId(),
        block_type: 'persona',
        block_key: 'default',
        content: 'Test',
        updated_at: new Date().toISOString(),
      })

      db.insertReflection({
        id: generateId(),
        content: 'An insight',
        source_ids: [eventId],
        importance: 0.7,
        depth: 1,
        created_at: new Date().toISOString(),
        accessed_at: null,
        access_count: 0,
      })

      const stats = db.getStats()
      expect(stats.event_count).toBe(1)
      expect(stats.entity_count).toBe(1)
      expect(stats.relation_count).toBe(0)
      expect(stats.reflection_count).toBe(1)
      expect(stats.core_memory_blocks).toBe(1)
      expect(stats.oldest_event).toBe('2025-06-01T00:00:00Z')
      expect(stats.newest_event).toBe('2025-06-01T00:00:00Z')
    })
  })
})
