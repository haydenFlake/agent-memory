import { describe, it, expect, beforeEach } from 'vitest'
import { EpisodicMemory } from './episodic.js'
import { SqliteStorage } from '../storage/sqlite.js'
import { loadConfig } from '../core/config.js'
import type { EmbeddingProvider } from '../core/types.js'

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
  records: Array<{ memory_id: string; memory_type: string; vector: number[]; content: string; created_at: string }> = []

  async add(memoryId: string, memoryType: string, vector: number[], content: string, createdAt: string): Promise<void> {
    this.records.push({ memory_id: memoryId, memory_type: memoryType, vector, content, created_at: createdAt })
  }
  async search(queryVector: number[], limit: number, memoryType?: string) {
    let filtered = this.records
    if (memoryType) filtered = filtered.filter(r => r.memory_type === memoryType)
    return filtered.slice(0, limit).map((r, i) => ({
      memory_id: r.memory_id, memory_type: r.memory_type, content: r.content,
      created_at: r.created_at, distance: 0.1 + i * 0.05,
    }))
  }
  async delete(memoryId: string): Promise<void> {
    this.records = this.records.filter(r => r.memory_id !== memoryId)
  }
  async count(): Promise<number> { return this.records.length }
}

describe('EpisodicMemory', () => {
  let sqlite: SqliteStorage
  let lance: MockLance
  let embeddings: MockEmbeddings
  let episodic: EpisodicMemory

  beforeEach(() => {
    sqlite = SqliteStorage.inMemory()
    lance = new MockLance()
    embeddings = new MockEmbeddings()
    const config = loadConfig({ anthropicApiKey: null })
    episodic = new EpisodicMemory(sqlite, lance as any, embeddings, config)
  })

  describe('recordEvent', () => {
    it('creates an event with default importance', async () => {
      const event = await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'User prefers dark mode',
      })

      expect(event.id).toBeTruthy()
      expect(event.agent_id).toBe('agent-1')
      expect(event.event_type).toBe('observation')
      expect(event.content).toBe('User prefers dark mode')
      expect(event.importance).toBe(0.5)
      expect(event.entities).toEqual([])
    })

    it('respects manual importance override', async () => {
      const event = await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'decision',
        content: 'Critical decision made',
        importance: 0.95,
      })

      expect(event.importance).toBe(0.95)
    })

    it('stores entities and metadata', async () => {
      const event = await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'email',
        content: 'Sent follow-up email to Alice',
        entities: ['Alice', 'Project X'],
        metadata: { subject: 'Follow-up', priority: 'high' },
      })

      expect(event.entities).toEqual(['Alice', 'Project X'])
      expect(event.metadata).toEqual({ subject: 'Follow-up', priority: 'high' })
    })

    it('creates vector embedding in lance', async () => {
      await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Test content',
      })

      expect(lance.records).toHaveLength(1)
      expect(lance.records[0].memory_type).toBe('event')
    })

    it('rolls back sqlite on embedding failure', async () => {
      embeddings.shouldFail = true

      await expect(episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'This will fail',
      })).rejects.toThrow('Embedding failed')

      expect(sqlite.getEventCount()).toBe(0)
      expect(lance.records).toHaveLength(0)
    })
  })

  describe('searchEvents', () => {
    beforeEach(async () => {
      await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'email',
        content: 'Sent email about project deadline to Alice',
        entities: ['Alice', 'Project X'],
      })
      await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Bob mentioned he prefers Python over JavaScript',
        entities: ['Bob'],
      })
      await episodic.recordEvent({
        agent_id: 'agent-2',
        event_type: 'action',
        content: 'Deployed new version to production',
      })
    })

    it('searches by query', async () => {
      const results = await episodic.searchEvents({ query: 'project deadline' })
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('filters by agent_id', async () => {
      const results = await episodic.searchEvents({
        query: 'email',
        agent_id: 'agent-1',
      })
      for (const r of results) {
        expect(r.agent_id).toBe('agent-1')
      }
    })

    it('filters by event_type', async () => {
      const results = await episodic.searchEvents({
        query: 'email project',
        event_type: 'email',
      })
      for (const r of results) {
        expect(r.event_type).toBe('email')
      }
    })

    it('filters by entities', async () => {
      const results = await episodic.searchEvents({
        query: 'preferences',
        entities: ['Bob'],
      })
      for (const r of results) {
        expect(r.entities.some(e => e.includes('Bob'))).toBe(true)
      }
    })

    it('respects limit', async () => {
      const results = await episodic.searchEvents({
        query: 'anything',
        limit: 1,
      })
      expect(results.length).toBeLessThanOrEqual(1)
    })
  })

  describe('getTimeline', () => {
    it('returns events in time range', async () => {
      await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Event 1',
      })

      const now = new Date()
      const events = episodic.getTimeline({
        agent_id: 'agent-1',
        start: new Date(now.getTime() - 60000).toISOString(),
        end: new Date(now.getTime() + 60000).toISOString(),
      })
      expect(events).toHaveLength(1)
    })
  })

  describe('getEvent', () => {
    it('retrieves event and tracks access', async () => {
      const created = await episodic.recordEvent({
        agent_id: 'agent-1',
        event_type: 'observation',
        content: 'Test',
      })

      const retrieved = episodic.getEvent(created.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.content).toBe('Test')

      // Access should be tracked
      const updated = sqlite.getEvent(created.id)
      expect(updated!.access_count).toBe(1)
    })

    it('returns null for non-existent event', () => {
      expect(episodic.getEvent('nonexistent')).toBeNull()
    })
  })

  describe('getRecentEvents', () => {
    it('returns events in descending order', async () => {
      await episodic.recordEvent({ agent_id: 'a', event_type: 'observation', content: 'First' })
      await episodic.recordEvent({ agent_id: 'a', event_type: 'observation', content: 'Second' })

      const events = episodic.getRecentEvents('a', 10)
      expect(events).toHaveLength(2)
      expect(events[0].content).toBe('Second')
    })
  })

  describe('getEventCount', () => {
    it('counts events per agent', async () => {
      await episodic.recordEvent({ agent_id: 'a', event_type: 'observation', content: 'E1' })
      await episodic.recordEvent({ agent_id: 'a', event_type: 'observation', content: 'E2' })
      await episodic.recordEvent({ agent_id: 'b', event_type: 'observation', content: 'E3' })

      expect(episodic.getEventCount('a')).toBe(2)
      expect(episodic.getEventCount('b')).toBe(1)
      expect(episodic.getEventCount()).toBe(3)
    })
  })
})
