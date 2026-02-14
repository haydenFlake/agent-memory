import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { logger } from '../../utils/logger.js'

export function runInit(dataDir: string): void {
  const resolved = resolve(dataDir)

  if (existsSync(resolved)) {
    logger.info(`Data directory already exists: ${resolved}`)
  } else {
    mkdirSync(resolved, { recursive: true })
    logger.info(`Created data directory: ${resolved}`)
  }

  const lanceDir = resolve(resolved, 'lancedb')
  if (!existsSync(lanceDir)) {
    mkdirSync(lanceDir, { recursive: true })
  }

  logger.info('Agent Memory initialized successfully')
  logger.info('Start the MCP server with: agent-memory serve')
}
