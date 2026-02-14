import type { EmbeddingProvider } from '../core/types.js'
import { EmbeddingError } from '../core/errors.js'

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  private model: string
  private dims: number
  private pipeline: unknown | null = null
  private loading: Promise<void> | null = null

  constructor(model: string = 'Xenova/all-MiniLM-L6-v2', dimensions: number = 384) {
    this.model = model
    this.dims = dimensions
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return
    if (!this.loading) {
      this.loading = this._doLoad()
    }
    await this.loading
  }

  private async _doLoad(): Promise<void> {
    try {
      const { pipeline } = await import('@huggingface/transformers')
      this.pipeline = await pipeline('feature-extraction', this.model, {
        dtype: 'fp32',
      })
    } catch (err) {
      throw new EmbeddingError(`Failed to load embedding model ${this.model}: ${err}`)
    }
  }

  reset(): void {
    this.pipeline = null
    this.loading = null
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureLoaded()
    const pipe = this.pipeline as (input: string, options: { pooling: string; normalize: boolean }) => Promise<{ tolist: () => number[][] }>
    const output = await pipe(text, { pooling: 'mean', normalize: true })
    const embedding = output.tolist()[0]
    if (embedding.length !== this.dims) {
      throw new EmbeddingError(
        `Embedding dimension mismatch: expected ${this.dims}, got ${embedding.length}`,
      )
    }
    return embedding
  }

  // Sequential batches are optimal for local models — parallel calls contend for the same model weights
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []

    const results: number[][] = []
    const batchSize = 32
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const embeddings = await Promise.all(batch.map(t => this.embed(t)))
      results.push(...embeddings)
    }
    return results
  }

  dimensions(): number {
    return this.dims
  }
}
