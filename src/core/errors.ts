export class AgentMemoryError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
    this.name = 'AgentMemoryError'
    Object.setPrototypeOf(this, AgentMemoryError.prototype)
  }
}

export class StorageError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'STORAGE_ERROR')
    this.name = 'StorageError'
    Object.setPrototypeOf(this, StorageError.prototype)
  }
}

export class EmbeddingError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'EMBEDDING_ERROR')
    this.name = 'EmbeddingError'
    Object.setPrototypeOf(this, EmbeddingError.prototype)
  }
}

export class RetrievalError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'RETRIEVAL_ERROR')
    this.name = 'RetrievalError'
    Object.setPrototypeOf(this, RetrievalError.prototype)
  }
}

export class ReflectionError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'REFLECTION_ERROR')
    this.name = 'ReflectionError'
    Object.setPrototypeOf(this, ReflectionError.prototype)
  }
}
