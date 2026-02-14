import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../core/config.js'
import { stateKeys } from '../core/constants.js'
import type { EmbeddingProvider, Entity } from '../core/types.js'
import { logger } from '../utils/logger.js'
import type { LanceStorage } from '../storage/lance.js'
import type { SqliteStorage } from '../storage/sqlite.js'

export class ConsolidationEngine {
  private sqlite: SqliteStorage
  private lance: LanceStorage
  private embeddings: EmbeddingProvider
  private client: Anthropic | null = null
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

    if (config.anthropicApiKey) {
      this.client = new Anthropic({ apiKey: config.anthropicApiKey })
    }
  }

  async consolidate(maxAgeDays?: number): Promise<{
    entities_updated: number
    observations_pruned: number
    summaries_refreshed: number
  }> {
    const pruneAge = maxAgeDays ?? this.config.pruneAgeDays
    logger.info(`Running consolidation (prune age: ${pruneAge} days)`)

    let entitiesUpdated = 0
    let observationsPruned = 0
    let summariesRefreshed = 0

    const entities = this.sqlite.getAllEntities()
    // TODO: Age-based pruning not yet implemented — currently pruning is observation count-based (>20)

    for (const entity of entities) {
      let changed = false

      if (entity.observations.length > 20) {
        const kept = entity.observations.slice(-20)
        observationsPruned += entity.observations.length - kept.length
        entity.observations = kept
        changed = true
      }

      if (this.client && (changed || !entity.summary || this.isStale(entity))) {
        const newSummary = await this.refreshSummary(entity)
        if (newSummary) {
          entity.summary = newSummary
          summariesRefreshed++
          changed = true
        }
      }

      if (changed) {
        const textForEmbedding = [
          entity.name,
          entity.summary ?? '',
          ...entity.observations,
        ].join(' ')
        const vector = await this.embeddings.embed(textForEmbedding)

        this.sqlite.upsertEntity({
          ...entity,
          updated_at: new Date().toISOString(),
        })

        try {
          await this.lance.delete(entity.id)
          await this.lance.add(entity.id, 'entity', vector, textForEmbedding, new Date().toISOString())
        } catch (err) {
          logger.warn(`Failed to update vector for entity ${entity.name}, sqlite updated but vector may be stale`, err)
        }

        entitiesUpdated++
      }
    }

    this.sqlite.setState(stateKeys.lastConsolidationAt, new Date().toISOString())

    const result = {
      entities_updated: entitiesUpdated,
      observations_pruned: observationsPruned,
      summaries_refreshed: summariesRefreshed,
    }

    logger.info('Consolidation complete', result)
    return result
  }

  // updated_at refreshes when observations change, so staleness reflects content freshness
  private isStale(entity: Entity): boolean {
    if (!entity.updated_at) return true
    const updated = new Date(entity.updated_at)
    const daysSinceUpdate = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24)
    return daysSinceUpdate > 7
  }

  private async refreshSummary(entity: Entity): Promise<string | null> {
    if (!this.client) return null

    const relations = this.sqlite.getRelationsFor(entity.id)
    const topRelations = relations.slice(0, 10)

    const entityIds = new Set<string>()
    for (const r of topRelations) {
      entityIds.add(r.from_entity)
      entityIds.add(r.to_entity)
    }
    const entityMap = new Map<string, Entity>()
    for (const id of entityIds) {
      const e = this.sqlite.getEntityById(id)
      if (e) entityMap.set(id, e)
    }

    const relContext = topRelations.map(r => {
      const from = entityMap.get(r.from_entity)
      const to = entityMap.get(r.to_entity)
      return `${from?.name ?? r.from_entity} --[${r.relation_type}]--> ${to?.name ?? r.to_entity}`
    }).join('\n')

    const observations = entity.observations.slice(-15).map(o => `- ${o}`).join('\n')

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Summarize what is known about "${entity.name}" (${entity.entity_type}) in 1-2 sentences.

Observations:
${observations}

${relContext ? `Relationships:\n${relContext}` : ''}

Be concise and factual.`,
          },
        ],
      })

      const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
      return text || null
    } catch (err) {
      logger.warn(`Failed to refresh summary for ${entity.name}`, err)
      return null
    }
  }
}
