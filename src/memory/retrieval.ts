import type { Config } from '../core/config.js'
import type { EmbeddingProvider, Entity, MemoryEvent, RecallResult, Reflection, ScoredMemory } from '../core/types.js'
import type { LanceStorage } from '../storage/lance.js'
import type { SqliteStorage } from '../storage/sqlite.js'
import { logger } from '../utils/logger.js'
import { clamp } from '../utils/validation.js'

export class RetrievalEngine {
  private sqlite: SqliteStorage
  private lance: LanceStorage
  private embeddings: EmbeddingProvider
  private config: Config

  constructor(
    sqlite: SqliteStorage,
    lance: LanceStorage,
    embeddings: EmbeddingProvider,
    config: Config,
  ) {
    this.sqlite = sqlite
    this.lance = lance
    this.embeddings = embeddings
    this.config = config
  }

  async recall(params: {
    query: string
    limit?: number
    include_core?: boolean
    agent_id?: string
    touch?: boolean
  }): Promise<RecallResult> {
    const limit = params.limit ?? 20
    const includeCoreMemory = params.include_core ?? true
    const shouldTouch = params.touch ?? true

    const queryVector = await this.embeddings.embed(params.query)
    const now = new Date()

    // 3x buffer: recall applies heavier filtering (agent_id, scoring cutoff) than direct search
    const vectorResults = await this.lance.search(queryVector, limit * 3)

    // Batch-fetch all memories by type to avoid N+1 queries
    const eventIds = vectorResults.filter(r => r.memory_type === 'event').map(r => r.memory_id)
    const entityIds = vectorResults.filter(r => r.memory_type === 'entity').map(r => r.memory_id)
    const reflectionIds = vectorResults.filter(r => r.memory_type === 'reflection').map(r => r.memory_id)

    const events = this.sqlite.getEventsByIds(eventIds)
    const entities = this.sqlite.getEntitiesByIds(entityIds)
    const reflections = this.sqlite.getReflectionsByIds(reflectionIds)

    const scoredMemories: ScoredMemory[] = []

    for (const result of vectorResults) {
      const memory = this.resolveMemoryFromMaps(result.memory_id, result.memory_type, events, entities, reflections)
      if (!memory) {
        logger.warn(`Vector record has no matching SQLite record: ${result.memory_type}:${result.memory_id}`)
        continue
      }

      if (params.agent_id && result.memory_type === 'event') {
        const event = events.get(result.memory_id)
        if (event && event.agent_id !== params.agent_id) continue
      }

      // 1 - distance/2 maps L2 distance [0,2] to relevance [0,1]
      const relevance = Math.max(0, Math.min(1, 1 - result.distance / 2))
      const recency = this.calculateRecency(memory.accessed_at ?? memory.created_at, now)
      const importance = clamp(memory.importance, 0, 1)

      // Scoring formula is a weighted sum, not a product
      const score =
        this.config.weightRecency * recency +
        this.config.weightImportance * importance +
        this.config.weightRelevance * relevance

      scoredMemories.push({
        id: result.memory_id,
        source: result.memory_type,
        content: memory.content,
        score,
        recency_score: recency,
        importance_score: importance,
        relevance_score: relevance,
        created_at: memory.created_at,
        metadata: memory.metadata,
      })

      if (shouldTouch) {
        this.touchMemory(result.memory_id, result.memory_type)
      }
    }

    scoredMemories.sort((a, b) => b.score - a.score)
    const topMemories = scoredMemories.slice(0, limit)

    const coreMemory = includeCoreMemory ? this.sqlite.getCoreMemory() : []

    return {
      core_memory: coreMemory,
      memories: topMemories,
      total_searched: vectorResults.length,
    }
  }

  private calculateRecency(lastAccessedAt: string, now: Date): number {
    const lastAccessed = new Date(lastAccessedAt)
    const hoursSince = (now.getTime() - lastAccessed.getTime()) / 3600000
    return Math.pow(this.config.decayRate, Math.max(0, hoursSince))
  }

  private resolveMemoryFromMaps(
    id: string,
    type: 'event' | 'entity' | 'reflection',
    events: Map<string, MemoryEvent>,
    entities: Map<string, Entity>,
    reflections: Map<string, Reflection>,
  ): { content: string; importance: number; created_at: string; accessed_at: string | null; metadata?: Record<string, unknown> } | null {
    switch (type) {
      case 'event': {
        const event = events.get(id)
        if (!event) return null
        return {
          content: event.content,
          importance: event.importance,
          created_at: event.created_at,
          accessed_at: event.accessed_at,
          metadata: { event_type: event.event_type, entities: event.entities, ...event.metadata },
        }
      }
      case 'entity': {
        const entity = entities.get(id)
        if (!entity) return null
        const content = [
          `${entity.name} (${entity.entity_type})`,
          entity.summary,
          ...entity.observations.map(o => `- ${o}`),
        ].filter(Boolean).join('\n')
        return {
          content,
          importance: entity.importance,
          created_at: entity.created_at,
          accessed_at: entity.accessed_at,
        }
      }
      case 'reflection': {
        const reflection = reflections.get(id)
        if (!reflection) return null
        return {
          content: reflection.content,
          importance: reflection.importance,
          created_at: reflection.created_at,
          accessed_at: reflection.accessed_at,
        }
      }
      default:
        return null
    }
  }

  // Updates accessed_at on recall — creates intentional reinforcement: frequently recalled memories stay fresh
  private touchMemory(id: string, type: 'event' | 'entity' | 'reflection'): void {
    switch (type) {
      case 'event':
        this.sqlite.touchEvent(id)
        break
      case 'entity':
        this.sqlite.touchEntity(id)
        break
      case 'reflection':
        this.sqlite.touchReflection(id)
        break
    }
  }
}
