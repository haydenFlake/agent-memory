import type { Config } from '../core/config.js'
import type { EmbeddingProvider, EventType, MemoryEvent, TimeRange } from '../core/types.js'
import { generateId } from '../core/ulid.js'
import { logger } from '../utils/logger.js'
import { clamp } from '../utils/validation.js'
import type { LanceStorage } from '../storage/lance.js'
import type { SqliteStorage } from '../storage/sqlite.js'
import { ImportanceScorer } from './importance.js'

export class EpisodicMemory {
  private sqlite: SqliteStorage
  private lance: LanceStorage
  private embeddings: EmbeddingProvider
  private importance: ImportanceScorer

  constructor(
    sqlite: SqliteStorage,
    lance: LanceStorage,
    embeddings: EmbeddingProvider,
    config: Config,
  ) {
    this.sqlite = sqlite
    this.lance = lance
    this.embeddings = embeddings
    this.importance = new ImportanceScorer(config)
  }

  async recordEvent(params: {
    agent_id: string
    event_type: EventType
    content: string
    entities?: string[]
    metadata?: Record<string, unknown>
    importance?: number
  }): Promise<MemoryEvent> {
    const id = generateId()
    const now = new Date().toISOString()

    let importance = params.importance ?? 0.5
    if (params.importance === undefined && this.importance.enabled) {
      importance = await this.importance.score(params.content)
    }
    importance = clamp(importance, 0, 1)

    const event: MemoryEvent = {
      id,
      agent_id: params.agent_id,
      event_type: params.event_type,
      content: params.content,
      importance,
      entities: params.entities ?? [],
      metadata: params.metadata ?? {},
      created_at: now,
      accessed_at: null,
      access_count: 0,
    }

    this.sqlite.insertEvent(event)

    try {
      const vector = await this.embeddings.embed(params.content)
      await this.lance.add(id, 'event', vector, params.content, now)
    } catch (err) {
      this.sqlite.deleteEvent(id)
      throw err
    }

    return event
  }

  async searchEvents(params: {
    query: string
    agent_id?: string
    event_type?: EventType
    time_range?: TimeRange
    entities?: string[]
    limit?: number
  }): Promise<MemoryEvent[]> {
    const limit = params.limit ?? 20

    const queryVector = await this.embeddings.embed(params.query)
    const vectorResults = await this.lance.search(queryVector, limit * 2, 'event')
    const vectorIds = new Set(vectorResults.map(r => r.memory_id))

    const ftsResults = this.sqlite.searchEventsFts(params.query, limit)
    const ftsIds = new Set(ftsResults.map(r => r.id))

    const allIds = new Set([...vectorIds, ...ftsIds])
    const events: MemoryEvent[] = []

    for (const id of allIds) {
      const event = this.sqlite.getEvent(id)
      if (!event) continue

      if (params.agent_id && event.agent_id !== params.agent_id) continue
      if (params.event_type && event.event_type !== params.event_type) continue
      if (params.time_range) {
        if (event.created_at < params.time_range.start) continue
        if (event.created_at > params.time_range.end) continue
      }
      if (params.entities && params.entities.length > 0) {
        const hasEntity = params.entities.some(e =>
          event.entities.some(ee => ee.toLowerCase().includes(e.toLowerCase())),
        )
        if (!hasEntity) continue
      }

      this.sqlite.touchEvent(id)
      events.push(event)
    }

    events.sort((a, b) => {
      const aVector = vectorResults.find(r => r.memory_id === a.id)
      const bVector = vectorResults.find(r => r.memory_id === b.id)
      const aDist = aVector?.distance ?? Infinity
      const bDist = bVector?.distance ?? Infinity
      return aDist - bDist
    })

    return events.slice(0, limit)
  }

  getTimeline(params: {
    agent_id: string
    start: string
    end: string
    event_type?: EventType
    limit?: number
  }): MemoryEvent[] {
    return this.sqlite.getEventsByTimeRange(
      params.agent_id,
      params.start,
      params.end,
      params.event_type,
      params.limit ?? 50,
    )
  }

  getEvent(id: string): MemoryEvent | null {
    const event = this.sqlite.getEvent(id)
    if (event) {
      this.sqlite.touchEvent(id)
    }
    return event
  }

  getRecentEvents(agentId: string, limit: number = 100): MemoryEvent[] {
    return this.sqlite.getRecentEvents(agentId, limit)
  }

  getUnreflectedEvents(agentId: string): MemoryEvent[] {
    return this.sqlite.getUnreflectedEvents(agentId)
  }

  getEventCount(agentId?: string): number {
    return this.sqlite.getEventCount(agentId)
  }
}
