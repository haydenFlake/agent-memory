import { describe, it, expect } from 'vitest'
import { ImportanceScorer } from './importance.js'
import { loadConfig } from '../core/config.js'

describe('ImportanceScorer', () => {
  it('returns 0.5 when no API key is configured', async () => {
    const config = loadConfig({ anthropicApiKey: null })
    const scorer = new ImportanceScorer(config)

    expect(scorer.enabled).toBe(false)
    expect(await scorer.score('Critical business decision')).toBe(0.5)
  })

  it('reports enabled when API key is present', () => {
    const config = loadConfig({ anthropicApiKey: 'sk-test-fake-key' })
    const scorer = new ImportanceScorer(config)
    expect(scorer.enabled).toBe(true)
  })

  it('scoreBatch returns default scores without API key', async () => {
    const config = loadConfig({ anthropicApiKey: null })
    const scorer = new ImportanceScorer(config)

    const scores = await scorer.scoreBatch(['event 1', 'event 2', 'event 3'])
    expect(scores).toEqual([0.5, 0.5, 0.5])
  })

  it('scoreBatch returns correct number of scores', async () => {
    const config = loadConfig({ anthropicApiKey: null })
    const scorer = new ImportanceScorer(config)

    const scores = await scorer.scoreBatch([])
    expect(scores).toEqual([])
  })
})
