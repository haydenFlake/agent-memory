import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '../core/config.js'
import { logger } from '../utils/logger.js'

export class ImportanceScorer {
  private client: Anthropic | null = null

  constructor(config: Config) {
    if (config.anthropicApiKey) {
      this.client = new Anthropic({ apiKey: config.anthropicApiKey })
    }
  }

  get enabled(): boolean {
    return this.client !== null
  }

  async score(content: string): Promise<number> {
    if (!this.client) return 0.5

    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: `Rate the importance of this memory on a scale of 1 to 10, where 1 is completely mundane (e.g., routine greeting) and 10 is critically important (e.g., major decision, key deadline, important relationship change). Respond with ONLY a single integer.

Memory: "${content}"`,
          },
        ],
      })

      const text = response.content[0].type === 'text' ? response.content[0].text.trim() : ''
      const rating = parseInt(text, 10)
      if (isNaN(rating) || rating < 1 || rating > 10) return 0.5
      return rating / 10
    } catch (err) {
      logger.warn('Importance scoring failed, using default', err)
      return 0.5
    }
  }

  async scoreBatch(contents: string[]): Promise<number[]> {
    return Promise.all(contents.map(c => this.score(c)))
  }
}
