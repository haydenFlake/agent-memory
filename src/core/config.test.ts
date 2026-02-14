import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns sensible defaults when no env vars are set', () => {
    delete process.env.DATA_DIR
    delete process.env.DECAY_RATE
    delete process.env.ANTHROPIC_API_KEY

    const config = loadConfig()
    expect(config.decayRate).toBe(0.995)
    expect(config.reflectionThreshold).toBe(150)
    expect(config.weightRecency).toBe(0.4)
    expect(config.weightImportance).toBe(0.3)
    expect(config.weightRelevance).toBe(0.3)
    expect(config.embeddingModel).toBe('Xenova/all-MiniLM-L6-v2')
    expect(config.embeddingDimensions).toBe(384)
    expect(config.anthropicApiKey).toBeNull()
    expect(config.logLevel).toBe('info')
  })

  it('reads values from environment variables', () => {
    process.env.DECAY_RATE = '0.99'
    process.env.WEIGHT_RECENCY = '0.5'
    process.env.LOG_LEVEL = 'debug'

    const config = loadConfig()
    expect(config.decayRate).toBe(0.99)
    expect(config.weightRecency).toBe(0.5)
    expect(config.logLevel).toBe('debug')
  })

  it('applies overrides but ignores undefined values', () => {
    const config = loadConfig({
      decayRate: 0.9,
      dataDir: undefined,
    })
    expect(config.decayRate).toBe(0.9)
    expect(config.dataDir).toBeTruthy()
  })

  it('handles invalid env values gracefully', () => {
    process.env.DECAY_RATE = 'not-a-number'
    process.env.EMBEDDING_DIMENSIONS = 'invalid'

    const config = loadConfig()
    expect(config.decayRate).toBe(0.995)
    expect(config.embeddingDimensions).toBe(384)
  })
})
