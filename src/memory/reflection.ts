import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../core/config.js'
import type { EmbeddingProvider, MemoryEvent, Reflection } from '../core/types.js'
import { generateId } from '../core/ulid.js'
import { logger } from '../utils/logger.js'
import type { LanceStorage } from '../storage/lance.js'
import type { SqliteStorage } from '../storage/sqlite.js'

export class ReflectionEngine {
  private sqlite: SqliteStorage
  private lance: LanceStorage
  private embeddings: EmbeddingProvider
  private client: Anthropic | null = null
  private threshold: number

  constructor(
    sqlite: SqliteStorage,
    lance: LanceStorage,
    embeddings: EmbeddingProvider,
    config: Config,
  ) {
    this.sqlite = sqlite
    this.lance = lance
    this.embeddings = embeddings
    this.threshold = config.reflectionThreshold

    if (config.anthropicApiKey) {
      this.client = new Anthropic({ apiKey: config.anthropicApiKey })
    }
  }

  get enabled(): boolean {
    return this.client !== null
  }

  async shouldReflect(agentId: string): Promise<boolean> {
    if (!this.client) return false
    const unreflected = this.sqlite.getUnreflectedEvents(agentId)
    const cumulativeImportance = unreflected.reduce((sum, e) => sum + e.importance * 10, 0)
    return cumulativeImportance >= this.threshold
  }

  async reflect(agentId: string, force: boolean = false): Promise<Reflection[]> {
    if (!this.client) {
      logger.warn('Reflection skipped: no Anthropic API key configured')
      return []
    }

    const unreflected = this.sqlite.getUnreflectedEvents(agentId)
    if (unreflected.length === 0) return []

    const cumulativeImportance = unreflected.reduce((sum, e) => sum + e.importance * 10, 0)
    if (!force && cumulativeImportance < this.threshold) {
      logger.debug(`Reflection threshold not met: ${cumulativeImportance.toFixed(1)} / ${this.threshold}`)
      return []
    }

    logger.info(`Running reflection on ${unreflected.length} events (importance: ${cumulativeImportance.toFixed(1)})`)

    const questions = await this.identifySalientQuestions(unreflected)
    const reflections: Reflection[] = []

    for (const question of questions) {
      const insight = await this.synthesizeInsight(question, unreflected)
      if (!insight) continue

      const now = new Date().toISOString()
      const reflection: Reflection = {
        id: generateId(),
        content: insight,
        source_ids: unreflected.map(e => e.id),
        importance: 0.7,
        depth: 1,
        created_at: now,
        accessed_at: null,
        access_count: 0,
      }

      this.sqlite.insertReflection(reflection)

      const vector = await this.embeddings.embed(insight)
      await this.lance.add(reflection.id, 'reflection', vector, insight, now)

      reflections.push(reflection)
    }

    this.sqlite.setState('last_reflection_at', new Date().toISOString())
    logger.info(`Generated ${reflections.length} reflections`)

    return reflections
  }

  private async identifySalientQuestions(events: MemoryEvent[]): Promise<string[]> {
    if (!this.client) return []

    const eventSummary = events
      .slice(0, 50)
      .map(e => `[${e.event_type}] ${e.content}`)
      .join('\n')

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `Given the following recent events from an AI agent's experience, identify the 3 most salient high-level questions or themes that emerge. These should be questions that synthesizing an answer to would provide useful higher-level insights.

Events:
${eventSummary}

Respond with exactly 3 questions, one per line, no numbering or bullets.`,
          },
        ],
      })

      const text = response.content[0].type === 'text' ? response.content[0].text : ''
      return text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .slice(0, 3)
    } catch (err) {
      logger.error('Failed to identify salient questions', err)
      return []
    }
  }

  private async synthesizeInsight(question: string, events: MemoryEvent[]): Promise<string | null> {
    if (!this.client) return null

    const relevantEvents = events.slice(0, 30)
    const evidence = relevantEvents
      .map((e, i) => `[${i + 1}] ${e.content}`)
      .join('\n')

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Based on the following evidence, provide a concise insight that answers or addresses this question: "${question}"

Evidence:
${evidence}

Provide a single paragraph insight that synthesizes the evidence into a higher-level understanding. Be specific and cite evidence numbers in brackets.`,
          },
        ],
      })

      const text = response.content[0].type === 'text' ? response.content[0].text.trim() : ''
      return text || null
    } catch (err) {
      logger.error('Failed to synthesize insight', err)
      return null
    }
  }
}
