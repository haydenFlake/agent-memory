import type { Config } from '../core/config.js'
import type {
  CoreMemoryBlock,
  EmbeddingProvider,
  Entity,
  EntityType,
  Relation,
} from '../core/types.js'
import { generateId } from '../core/ulid.js'
import type { LanceStorage } from '../storage/lance.js'
import type { SqliteStorage } from '../storage/sqlite.js'

const CORE_MEMORY_MAX_CHARS = 5000

export class SemanticMemory {
  private sqlite: SqliteStorage
  private lance: LanceStorage
  private embeddings: EmbeddingProvider

  constructor(
    sqlite: SqliteStorage,
    lance: LanceStorage,
    embeddings: EmbeddingProvider,
    _config: Config,
  ) {
    this.sqlite = sqlite
    this.lance = lance
    this.embeddings = embeddings
  }

  // --- Core Memory Blocks ---

  updateCoreMemory(params: {
    block_type: 'persona' | 'user_profile'
    block_key: string
    operation: 'append' | 'replace' | 'remove'
    content: string
  }): CoreMemoryBlock {
    const now = new Date().toISOString()
    const existing = this.sqlite.getCoreMemoryBlock(params.block_type, params.block_key)

    let newContent: string

    switch (params.operation) {
      case 'append': {
        const current = existing?.content ?? ''
        newContent = current ? `${current}\n${params.content}` : params.content
        if (newContent.length > CORE_MEMORY_MAX_CHARS) {
          newContent = newContent.slice(0, CORE_MEMORY_MAX_CHARS)
        }
        break
      }
      case 'replace':
        newContent = params.content.slice(0, CORE_MEMORY_MAX_CHARS)
        break
      case 'remove':
        if (!existing) {
          return { id: '', block_type: params.block_type, block_key: params.block_key, content: '', updated_at: now }
        }
        this.sqlite.deleteCoreMemory(params.block_type, params.block_key)
        return { ...existing, content: '', updated_at: now }
      default:
        throw new Error(`Unknown operation: ${params.operation}`)
    }

    const block: CoreMemoryBlock = {
      id: existing?.id ?? generateId(),
      block_type: params.block_type,
      block_key: params.block_key,
      content: newContent,
      updated_at: now,
    }

    this.sqlite.upsertCoreMemory(block)
    return block
  }

  getCoreMemory(blockType?: string): CoreMemoryBlock[] {
    return this.sqlite.getCoreMemory(blockType)
  }

  // --- Entities ---

  async updateEntity(params: {
    name: string
    entity_type: EntityType
    observations?: string[]
    summary?: string
    importance?: number
  }): Promise<Entity> {
    const now = new Date().toISOString()

    const entity = this.sqlite.transaction(() => {
      const existing = this.sqlite.getEntity(params.name)

      const mergedObservations = existing
        ? [...existing.observations, ...(params.observations ?? [])]
        : params.observations ?? []

      const uniqueObservations = [...new Set(mergedObservations)]

      const ent: Entity = {
        id: existing?.id ?? generateId(),
        name: params.name,
        entity_type: params.entity_type,
        summary: params.summary ?? existing?.summary ?? null,
        observations: uniqueObservations,
        importance: params.importance ?? existing?.importance ?? 0.5,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        accessed_at: existing?.accessed_at ?? null,
        access_count: existing?.access_count ?? 0,
      }

      this.sqlite.upsertEntity(ent)
      return ent
    })

    const textForEmbedding = [
      entity.name,
      entity.summary ?? '',
      ...entity.observations,
    ].join(' ')
    const vector = await this.embeddings.embed(textForEmbedding)

    await this.lance.delete(entity.id)
    await this.lance.add(entity.id, 'entity', vector, textForEmbedding, now)

    return entity
  }

  getEntity(name: string): Entity | null {
    const entity = this.sqlite.getEntity(name)
    if (entity) {
      this.sqlite.touchEntity(entity.id)
    }
    return entity
  }

  getAllEntities(entityType?: string): Entity[] {
    return this.sqlite.getAllEntities(entityType)
  }

  // --- Relations ---

  createRelation(params: {
    from_entity: string
    to_entity: string
    relation_type: string
    metadata?: Record<string, unknown>
  }): Relation {
    const now = new Date().toISOString()

    const fromEntity = this.sqlite.getEntity(params.from_entity)
    const toEntity = this.sqlite.getEntity(params.to_entity)

    if (!fromEntity || !toEntity) {
      throw new Error(
        `Entity not found: ${!fromEntity ? params.from_entity : params.to_entity}`,
      )
    }

    this.sqlite.invalidateRelation(
      fromEntity.id,
      toEntity.id,
      params.relation_type,
      now,
    )

    const relation: Relation = {
      id: generateId(),
      from_entity: fromEntity.id,
      to_entity: toEntity.id,
      relation_type: params.relation_type,
      weight: 1.0,
      valid_from: now,
      valid_until: null,
      metadata: params.metadata ?? {},
      created_at: now,
    }

    this.sqlite.insertRelation(relation)
    return relation
  }

  getRelationsFor(entityName: string, activeOnly: boolean = true): Relation[] {
    const entity = this.sqlite.getEntity(entityName)
    if (!entity) return []
    return this.sqlite.getRelationsFor(entity.id, activeOnly)
  }

  // --- Search ---

  async searchKnowledge(params: {
    query: string
    entity_type?: EntityType
    limit?: number
  }): Promise<Entity[]> {
    const limit = params.limit ?? 10

    const queryVector = await this.embeddings.embed(params.query)
    // Search uses distance-only ranking. For weighted scoring, use RetrievalEngine.recall().
    const vectorResults = await this.lance.search(queryVector, limit * 2, 'entity')

    const entities: Entity[] = []
    for (const result of vectorResults) {
      const entity = this.sqlite.getEntityById(result.memory_id)
      if (!entity) continue
      if (params.entity_type && entity.entity_type !== params.entity_type) continue
      this.sqlite.touchEntity(entity.id)
      entities.push(entity)
      if (entities.length >= limit) break
    }

    return entities
  }
}
