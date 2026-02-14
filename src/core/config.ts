import { config as loadDotenv } from 'dotenv'
import { resolve } from 'path'

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
  logLevel: string
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
  return process.env[key] ?? fallback
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const base: Config = {
    dataDir: resolve(envString('DATA_DIR', './data')),
    decayRate: envFloat('DECAY_RATE', 0.995),
    reflectionThreshold: envFloat('REFLECTION_THRESHOLD', 150),
    consolidationInterval: envInt('CONSOLIDATION_INTERVAL', 86400000),
    mergeSimilarityThreshold: envFloat('MERGE_SIMILARITY_THRESHOLD', 0.85),
    pruneAgeDays: envInt('PRUNE_AGE_DAYS', 90),
    weightRecency: envFloat('WEIGHT_RECENCY', 0.4),
    weightImportance: envFloat('WEIGHT_IMPORTANCE', 0.3),
    weightRelevance: envFloat('WEIGHT_RELEVANCE', 0.3),
    embeddingModel: envString('EMBEDDING_MODEL', 'Xenova/all-MiniLM-L6-v2'),
    embeddingDimensions: envInt('EMBEDDING_DIMENSIONS', 384),
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? null,
    logLevel: envString('LOG_LEVEL', 'info'),
  }

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        ;(base as unknown as Record<string, unknown>)[key] = value
      }
    }
  }

  return base
}
