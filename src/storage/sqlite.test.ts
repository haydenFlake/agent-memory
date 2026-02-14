import { describe, it, expect, beforeEach } from 'vitest'
import { SqliteStorage } from './sqlite.js'
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
  })
})
