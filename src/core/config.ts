import { config as loadDotenv } from 'dotenv'
import { resolve } from 'path'
import type { LogLevel } from '../utils/logger.js'
import { logger } from '../utils/logger.js'

loadDotenv()

export interface Config {
  dataDir: string
  decayRate: number
  reflectionThreshold: number
  consolidationInterval: number
  mergeSimilarityThreshold: number
  pruneAgeDays: number
  weightRecency: number
  weightImportance: number
  weightRelevance: number
  embeddingModel: string
  embeddingDimensions: number
  anthropicApiKey: string | null
  logLevel: LogLevel
}

function envFloat(key: string, fallback: number): number {
  const val = process.env[key]
  if (val === undefined) return fallback
  const parsed = parseFloat(val)
  return isNaN(parsed) ? fallback : parsed
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key]
  if (val === undefined) return fallback
  const parsed = parseInt(val, 10)
  return isNaN(parsed) ? fallback : parsed
}

function envString(key: string, fallback: string): string {
  return process.env[key] || fallback
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const base: Config = {
    dataDir: resolve(envString('DATA_DIR', './data')),
    decayRate: envFloat('DECAY_RATE', 0.995),
    reflectionThreshold: envFloat('REFLECTION_THRESHOLD', 15),
    consolidationInterval: envInt('CONSOLIDATION_INTERVAL', 86400000),
    mergeSimilarityThreshold: envFloat('MERGE_SIMILARITY_THRESHOLD', 0.85),
    pruneAgeDays: envInt('PRUNE_AGE_DAYS', 90),
    weightRecency: envFloat('WEIGHT_RECENCY', 0.4),
    weightImportance: envFloat('WEIGHT_IMPORTANCE', 0.3),
    weightRelevance: envFloat('WEIGHT_RELEVANCE', 0.3),
    embeddingModel: envString('EMBEDDING_MODEL', 'Xenova/all-MiniLM-L6-v2'),
    embeddingDimensions: envInt('EMBEDDING_DIMENSIONS', 384),
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? null,
    logLevel: envString('LOG_LEVEL', 'info') as LogLevel,
  }

  if (overrides) {
    Object.assign(base, Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ))
  }

  validateConfig(base)
  return base
}

function validateConfig(config: Config): void {
  const errors: string[] = []

  if (!config.dataDir || config.dataDir.includes('\0')) {
    errors.push('dataDir must be a non-empty path without null bytes')
  }

  if (config.decayRate <= 0 || config.decayRate >= 1) {
    errors.push(`decayRate must be in (0, 1) exclusive, got ${config.decayRate}`)
  }
  if (config.weightRecency < 0) {
    errors.push(`weightRecency must be >= 0, got ${config.weightRecency}`)
  }
  if (config.weightImportance < 0) {
    errors.push(`weightImportance must be >= 0, got ${config.weightImportance}`)
  }
  if (config.weightRelevance < 0) {
    errors.push(`weightRelevance must be >= 0, got ${config.weightRelevance}`)
  }
  if (config.embeddingDimensions <= 0) {
    errors.push(`embeddingDimensions must be > 0, got ${config.embeddingDimensions}`)
  }
  if (config.reflectionThreshold < 0) {
    errors.push(`reflectionThreshold must be >= 0, got ${config.reflectionThreshold}`)
  }
  if (config.mergeSimilarityThreshold < 0 || config.mergeSimilarityThreshold > 1) {
    errors.push(`mergeSimilarityThreshold must be in [0, 1], got ${config.mergeSimilarityThreshold}`)
  }
  if (config.pruneAgeDays <= 0) {
    errors.push(`pruneAgeDays must be > 0, got ${config.pruneAgeDays}`)
  }
  if (config.consolidationInterval <= 0) {
    errors.push(`consolidationInterval must be > 0, got ${config.consolidationInterval}`)
  }
  const validLogLevels = ['debug', 'info', 'warn', 'error']
  if (!validLogLevels.includes(config.logLevel)) {
    errors.push(`logLevel must be one of ${validLogLevels.join(', ')}, got ${config.logLevel}`)
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`)
  }

  const weightSum = config.weightRecency + config.weightImportance + config.weightRelevance
  if (Math.abs(weightSum - 1.0) > 0.01) {
    logger.warn(`Retrieval weights sum to ${weightSum.toFixed(3)} instead of 1.0. Scores may not be normalized.`)
  }
}
