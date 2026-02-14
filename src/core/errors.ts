export class AgentMemoryError extends Error {
  constructor(
    message: string,
    public code: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'AgentMemoryError'
    if (cause) this.cause = cause
  }
}

export class StorageError extends AgentMemoryError {
  constructor(message: string, cause?: unknown) {
    super(message, 'STORAGE_ERROR', cause)
    this.name = 'StorageError'
  }
}

export class EmbeddingError extends AgentMemoryError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EMBEDDING_ERROR', cause)
    this.name = 'EmbeddingError'
  }
}

export class RetrievalError extends AgentMemoryError {
  constructor(message: string, cause?: unknown) {
    super(message, 'RETRIEVAL_ERROR', cause)
    this.name = 'RetrievalError'
  }
}

export class ReflectionError extends AgentMemoryError {
  constructor(message: string, cause?: unknown) {
    super(message, 'REFLECTION_ERROR', cause)
    this.name = 'ReflectionError'
  }
}
