import type { Config } from '../core/config.js'
import type { EmbeddingProvider } from '../core/types.js'
import { logger } from '../utils/logger.js'
import { ConsolidationEngine } from '../memory/consolidation.js'
import { ReflectionEngine } from '../memory/reflection.js'
import type { LanceStorage } from '../storage/lance.js'
import type { SqliteStorage } from '../storage/sqlite.js'

const REFLECTION_CHECK_INTERVAL = 5 * 60 * 1000 // 5 minutes
const DEFAULT_AGENT_ID = 'default'

export class BackgroundScheduler {
  private reflectionTimer: ReturnType<typeof setInterval> | null = null
  private consolidationTimer: ReturnType<typeof setInterval> | null = null
  private reflection: ReflectionEngine
  private consolidation: ConsolidationEngine
  private config: Config
  private running = false

  constructor(
    sqlite: SqliteStorage,
    lance: LanceStorage,
    embeddings: EmbeddingProvider,
    config: Config,
  ) {
    this.reflection = new ReflectionEngine(sqlite, lance, embeddings, config)
    this.consolidation = new ConsolidationEngine(sqlite, lance, embeddings, config)
    this.config = config
  }

  start(): void {
    if (this.running) return
    this.running = true

    if (this.reflection.enabled) {
      this.reflectionTimer = setInterval(() => {
        this.checkReflection().catch(err =>
          logger.error('Background reflection check failed', err),
        )
      }, REFLECTION_CHECK_INTERVAL)
      logger.info(`Background reflection check scheduled every ${REFLECTION_CHECK_INTERVAL / 1000}s`)
    }

    if (this.config.consolidationInterval > 0) {
      this.consolidationTimer = setInterval(() => {
        this.runConsolidation().catch(err =>
          logger.error('Background consolidation failed', err),
        )
      }, this.config.consolidationInterval)
      logger.info(`Background consolidation scheduled every ${this.config.consolidationInterval / 1000}s`)
    }
  }

  stop(): void {
    if (this.reflectionTimer) {
      clearInterval(this.reflectionTimer)
      this.reflectionTimer = null
    }
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer)
      this.consolidationTimer = null
    }
    this.running = false
    logger.info('Background scheduler stopped')
  }

  get isRunning(): boolean {
    return this.running
  }

  async checkReflection(): Promise<void> {
    if (!this.reflection.enabled) return

    const shouldReflect = await this.reflection.shouldReflect(DEFAULT_AGENT_ID)
    if (shouldReflect) {
      logger.info('Background: importance threshold reached, triggering reflection')
      await this.reflection.reflect(DEFAULT_AGENT_ID)
    }
  }

  async runConsolidation(): Promise<void> {
    logger.info('Background: running scheduled consolidation')
    await this.consolidation.consolidate()
  }
}
