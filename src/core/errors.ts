export class AgentMemoryError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
    this.name = 'AgentMemoryError'
  }
}

export class StorageError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'STORAGE_ERROR')
    this.name = 'StorageError'
  }
}

export class EmbeddingError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'EMBEDDING_ERROR')
    this.name = 'EmbeddingError'
  }
}

export class RetrievalError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'RETRIEVAL_ERROR')
    this.name = 'RetrievalError'
  }
}

export class ReflectionError extends AgentMemoryError {
  constructor(message: string) {
    super(message, 'REFLECTION_ERROR')
    this.name = 'ReflectionError'
  }
}
