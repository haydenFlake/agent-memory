import type { Config } from '../../core/config.js'
import { TransformersEmbeddingProvider } from '../../embeddings/transformers-provider.js'
import { BackgroundScheduler } from '../../background/scheduler.js'
import { startMcpServer } from '../../mcp/server.js'
import { LanceStorage } from '../../storage/lance.js'
import { SqliteStorage } from '../../storage/sqlite.js'
import { logger } from '../../utils/logger.js'

export async function runServe(config: Config): Promise<void> {
  logger.info('Starting Agent Memory MCP server...')

  const sqlite = new SqliteStorage(config)
  const lance = new LanceStorage(config)
  const embeddings = new TransformersEmbeddingProvider(
    config.embeddingModel,
    config.embeddingDimensions,
  )

  logger.info(`Data directory: ${config.dataDir}`)
  logger.info(`Embedding model: ${config.embeddingModel}`)
  logger.info(`LLM features: ${config.anthropicApiKey ? 'enabled' : 'disabled (no API key)'}`)

  const scheduler = new BackgroundScheduler(sqlite, lance, embeddings, config)
  scheduler.start()

  process.on('SIGINT', () => {
    scheduler.stop()
    sqlite.close()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    scheduler.stop()
    sqlite.close()
    process.exit(0)
  })

  await startMcpServer(sqlite, lance, embeddings, config)
}
