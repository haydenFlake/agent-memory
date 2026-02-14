import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TransformersEmbeddingProvider } from './transformers-provider.js'
import { EmbeddingError } from '../core/errors.js'

// Mock the @huggingface/transformers module
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
}))

describe('TransformersEmbeddingProvider', () => {
  let provider: TransformersEmbeddingProvider

  beforeEach(async () => {
    provider = new TransformersEmbeddingProvider('test-model', 3)
    provider.reset()

    const { pipeline } = await import('@huggingface/transformers')
    vi.mocked(pipeline).mockReset()
  })

  describe('retry storm prevention', () => {
    it('caches rejection on pipeline load failure', async () => {
      const { pipeline } = await import('@huggingface/transformers')
      vi.mocked(pipeline).mockRejectedValue(new Error('Model not found'))

      // First call should fail
      await expect(provider.embed('hello')).rejects.toThrow(EmbeddingError)

      // Second call should fail with the same cached error without re-calling pipeline
      await expect(provider.embed('world')).rejects.toThrow(EmbeddingError)

      // pipeline should only be called once — the rejection is cached
      expect(pipeline).toHaveBeenCalledTimes(1)
    })
  })

  describe('reset()', () => {
    it('allows retrying after reset', async () => {
      const { pipeline } = await import('@huggingface/transformers')
      const mockPipe = vi.fn().mockResolvedValue({ tolist: () => [[1, 2, 3]] })

      // First: fail
      vi.mocked(pipeline).mockRejectedValueOnce(new Error('Model not found'))
      await expect(provider.embed('hello')).rejects.toThrow(EmbeddingError)

      // Reset clears the cached rejection
      provider.reset()

      // Second: succeed
      vi.mocked(pipeline).mockResolvedValueOnce(mockPipe)
      const result = await provider.embed('hello')
      expect(result).toEqual([1, 2, 3])
      expect(pipeline).toHaveBeenCalledTimes(2)
    })
  })

  describe('dimension check', () => {
    it('throws on dimension mismatch', async () => {
      const { pipeline } = await import('@huggingface/transformers')
      const mockPipe = vi.fn().mockResolvedValue({ tolist: () => [[1, 2, 3, 4]] })
      vi.mocked(pipeline).mockResolvedValueOnce(mockPipe)

      await expect(provider.embed('hello')).rejects.toThrow('dimension mismatch')
    })
  })

  describe('embedBatch', () => {
    it('returns empty array for empty input', async () => {
      const result = await provider.embedBatch([])
      expect(result).toEqual([])
    })

    it('embeds multiple texts', async () => {
      const { pipeline } = await import('@huggingface/transformers')
      const mockPipe = vi.fn().mockResolvedValue({ tolist: () => [[1, 2, 3]] })
      vi.mocked(pipeline).mockResolvedValueOnce(mockPipe)

      const result = await provider.embedBatch(['hello', 'world'])
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual([1, 2, 3])
      expect(result[1]).toEqual([1, 2, 3])
    })
  })

  describe('dimensions()', () => {
    it('returns configured dimensions', () => {
      expect(provider.dimensions()).toBe(3)

      const provider384 = new TransformersEmbeddingProvider('model', 384)
      expect(provider384.dimensions()).toBe(384)
    })
  })

  describe('successful load', () => {
    it('only loads pipeline once for multiple embed calls', async () => {
      const { pipeline } = await import('@huggingface/transformers')
      const mockPipe = vi.fn().mockResolvedValue({ tolist: () => [[1, 2, 3]] })
      vi.mocked(pipeline).mockResolvedValueOnce(mockPipe)

      await provider.embed('first')
      await provider.embed('second')

      // pipeline() should only be called once
      expect(pipeline).toHaveBeenCalledTimes(1)
      // But the pipe function should be called twice
      expect(mockPipe).toHaveBeenCalledTimes(2)
    })
  })
})
