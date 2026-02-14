import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    expect(config.reflectionThreshold).toBe(15)
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

  it('throws on decayRate out of (0, 1) range', () => {
    expect(() => loadConfig({ decayRate: 0 })).toThrow('decayRate must be in (0, 1)')
    expect(() => loadConfig({ decayRate: 1 })).toThrow('decayRate must be in (0, 1)')
    expect(() => loadConfig({ decayRate: 1.5 })).toThrow('decayRate must be in (0, 1)')
    expect(() => loadConfig({ decayRate: -0.1 })).toThrow('decayRate must be in (0, 1)')
  })

  it('throws on embeddingDimensions <= 0', () => {
    expect(() => loadConfig({ embeddingDimensions: 0 })).toThrow('embeddingDimensions must be > 0')
    expect(() => loadConfig({ embeddingDimensions: -1 })).toThrow('embeddingDimensions must be > 0')
  })

  it('throws on negative weights', () => {
    expect(() => loadConfig({ weightRecency: -1 })).toThrow('weightRecency must be >= 0')
    expect(() => loadConfig({ weightImportance: -0.1 })).toThrow('weightImportance must be >= 0')
    expect(() => loadConfig({ weightRelevance: -5 })).toThrow('weightRelevance must be >= 0')
  })

  it('throws on mergeSimilarityThreshold out of [0, 1]', () => {
    expect(() => loadConfig({ mergeSimilarityThreshold: -0.1 })).toThrow('mergeSimilarityThreshold must be in [0, 1]')
    expect(() => loadConfig({ mergeSimilarityThreshold: 1.1 })).toThrow('mergeSimilarityThreshold must be in [0, 1]')
  })

  it('throws on pruneAgeDays <= 0', () => {
    expect(() => loadConfig({ pruneAgeDays: 0 })).toThrow('pruneAgeDays must be > 0')
  })

  it('throws on consolidationInterval <= 0', () => {
    expect(() => loadConfig({ consolidationInterval: 0 })).toThrow('consolidationInterval must be > 0')
  })

  it('collects multiple validation errors', () => {
    expect(() => loadConfig({ decayRate: 2, embeddingDimensions: 0, weightRecency: -1 })).toThrow('Invalid configuration')
  })

  it('throws on invalid logLevel', () => {
    expect(() => loadConfig({ logLevel: 'verbose' })).toThrow('logLevel must be one of')
    expect(() => loadConfig({ logLevel: 'WARN' })).toThrow('logLevel must be one of')
  })

  it('accepts valid logLevels', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(() => loadConfig({ logLevel: level })).not.toThrow()
    }
  })

  it('empty env string falls back to default', () => {
    process.env.EMBEDDING_MODEL = ''
    process.env.LOG_LEVEL = ''

    const config = loadConfig()
    expect(config.embeddingModel).toBe('Xenova/all-MiniLM-L6-v2')
    expect(config.logLevel).toBe('info')
  })

  it('throws on empty dataDir', () => {
    expect(() => loadConfig({ dataDir: '' })).toThrow('dataDir must be a non-empty path')
  })

  it('throws on dataDir with null bytes', () => {
    expect(() => loadConfig({ dataDir: '/some/path\0bad' })).toThrow('null bytes')
  })

  it('warns when weights do not sum to 1.0', () => {
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    loadConfig({ weightRecency: 0.5, weightImportance: 0.5, weightRelevance: 0.5 })
    expect(warnSpy).toHaveBeenCalled()
    const callArgs = warnSpy.mock.calls.flat().join(' ')
    expect(callArgs).toContain('weights sum to')
    warnSpy.mockRestore()
  })
})
