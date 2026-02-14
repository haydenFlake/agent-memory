import { describe, it, expect } from 'vitest'
import {
  AgentMemoryError,
  StorageError,
  EmbeddingError,
  RetrievalError,
  ReflectionError,
} from './errors.js'

describe('Error classes', () => {
  describe('cause chaining', () => {
    it('StorageError preserves cause', () => {
      const original = new Error('disk full')
      const err = new StorageError('Failed to write', original)
      expect(err.message).toBe('Failed to write')
      expect(err.cause).toBe(original)
      expect(err.code).toBe('STORAGE_ERROR')
      expect(err.name).toBe('StorageError')
      expect(err).toBeInstanceOf(StorageError)
      expect(err).toBeInstanceOf(AgentMemoryError)
      expect(err).toBeInstanceOf(Error)
    })

    it('EmbeddingError preserves cause', () => {
      const original = new TypeError('model not loaded')
      const err = new EmbeddingError('Embedding failed', original)
      expect(err.message).toBe('Embedding failed')
      expect(err.cause).toBe(original)
      expect(err.code).toBe('EMBEDDING_ERROR')
    })

    it('RetrievalError preserves cause', () => {
      const original = new Error('vector search timeout')
      const err = new RetrievalError('Recall failed', original)
      expect(err.cause).toBe(original)
      expect(err.code).toBe('RETRIEVAL_ERROR')
    })

    it('ReflectionError preserves cause', () => {
      const original = new Error('API rate limit')
      const err = new ReflectionError('Reflection failed', original)
      expect(err.cause).toBe(original)
      expect(err.code).toBe('REFLECTION_ERROR')
    })

    it('cause is undefined when not provided', () => {
      const err = new StorageError('No cause')
      expect(err.cause).toBeUndefined()
    })

    it('works with non-Error causes', () => {
      const err = new StorageError('String cause', 'something went wrong')
      expect(err.cause).toBe('something went wrong')
    })
  })

  describe('instanceof chain (ES2022, no setPrototypeOf)', () => {
    it('StorageError is instance of all parent classes', () => {
      const err = new StorageError('test')
      expect(err).toBeInstanceOf(StorageError)
      expect(err).toBeInstanceOf(AgentMemoryError)
      expect(err).toBeInstanceOf(Error)
    })

    it('EmbeddingError is instance of all parent classes', () => {
      const err = new EmbeddingError('test')
      expect(err).toBeInstanceOf(EmbeddingError)
      expect(err).toBeInstanceOf(AgentMemoryError)
      expect(err).toBeInstanceOf(Error)
    })

    it('RetrievalError is instance of all parent classes', () => {
      const err = new RetrievalError('test')
      expect(err).toBeInstanceOf(RetrievalError)
      expect(err).toBeInstanceOf(AgentMemoryError)
      expect(err).toBeInstanceOf(Error)
    })

    it('ReflectionError is instance of all parent classes', () => {
      const err = new ReflectionError('test')
      expect(err).toBeInstanceOf(ReflectionError)
      expect(err).toBeInstanceOf(AgentMemoryError)
      expect(err).toBeInstanceOf(Error)
    })

    it('error names are correct', () => {
      expect(new StorageError('test').name).toBe('StorageError')
      expect(new EmbeddingError('test').name).toBe('EmbeddingError')
      expect(new RetrievalError('test').name).toBe('RetrievalError')
      expect(new ReflectionError('test').name).toBe('ReflectionError')
      expect(new AgentMemoryError('test', 'CODE').name).toBe('AgentMemoryError')
    })
  })
})
