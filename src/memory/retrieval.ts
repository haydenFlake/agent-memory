import type { Config } from '../core/config.js'
import type { EmbeddingProvider, RecallResult, ScoredMemory } from '../core/types.js'
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
  }): Promise<RecallResult> {
    const limit = params.limit ?? 20
    const includeCoreMemory = params.include_core ?? true

    const queryVector = await this.embeddings.embed(params.query)
    const now = new Date()

    const vectorResults = await this.lance.search(queryVector, limit * 3)

    const scoredMemories: ScoredMemory[] = []

    for (const result of vectorResults) {
      const memory = this.resolveMemory(result.memory_id, result.memory_type)
      if (!memory) {
        logger.warn(`Vector record has no matching SQLite record: ${result.memory_type}:${result.memory_id}`)
        continue
      }

      if (params.agent_id && result.memory_type === 'event') {
        const event = this.sqlite.getEvent(result.memory_id)
        if (event && event.agent_id !== params.agent_id) continue
      }

      const relevance = 1 - result.distance / 2
      const recency = this.calculateRecency(memory.accessed_at ?? memory.created_at, now)
      const importance = clamp(memory.importance, 0, 1)

      const score =
        this.config.weightRecency * recency +
        this.config.weightImportance * importance +
        this.config.weightRelevance * Math.max(0, relevance)

      scoredMemories.push({
        id: result.memory_id,
        source: result.memory_type,
        content: memory.content,
        score,
        recency_score: recency,
        importance_score: importance,
        relevance_score: Math.max(0, relevance),
        created_at: memory.created_at,
        metadata: memory.metadata,
      })

      this.touchMemory(result.memory_id, result.memory_type)
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

  private resolveMemory(
    id: string,
    type: 'event' | 'entity' | 'reflection',
  ): { content: string; importance: number; created_at: string; accessed_at: string | null; metadata?: Record<string, unknown> } | null {
    switch (type) {
      case 'event': {
        const event = this.sqlite.getEvent(id)
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
        const entity = this.sqlite.getEntityById(id)
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
        const reflection = this.sqlite.getReflectionById(id)
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
