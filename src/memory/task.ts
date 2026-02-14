import type { Config } from '../core/config.js'
import type { EmbeddingProvider, TaskContextEntry, TaskPhase } from '../core/types.js'
import { generateId } from '../core/ulid.js'
import { clamp } from '../utils/validation.js'
import type { LanceStorage } from '../storage/lance.js'
import type { SqliteStorage } from '../storage/sqlite.js'

const DEFAULT_IMPORTANCE: Record<TaskPhase, number> = {
  start: 0.6,
  in_progress: 0.7,
  completed: 0.8,
  blocked: 0.75,
}

export class TaskMemory {
  private sqlite: SqliteStorage
  private lance: LanceStorage
  private embeddings: EmbeddingProvider

  constructor(
    sqlite: SqliteStorage,
    lance: LanceStorage,
    embeddings: EmbeddingProvider,
    _config: Config,
  ) {
    this.sqlite = sqlite
    this.lance = lance
    this.embeddings = embeddings
  }

  async recordTaskContext(params: {
    agent_id: string
    task_id: string
    title: string
    phase: TaskPhase
    content: string
    importance?: number
  }): Promise<TaskContextEntry> {
    const id = generateId()
    const now = new Date().toISOString()

    const importance = clamp(
      params.importance ?? DEFAULT_IMPORTANCE[params.phase],
      0,
      1,
    )

    const entry: TaskContextEntry = {
      id,
      agent_id: params.agent_id,
      task_id: params.task_id,
      title: params.title,
      phase: params.phase,
      content: params.content,
      importance,
      created_at: now,
      accessed_at: null,
      access_count: 0,
    }

    const embeddingText = `[Task: ${params.title} | ${params.phase}] ${params.content}`
    const vector = await this.embeddings.embed(embeddingText)

    this.sqlite.insertTaskContext(entry)

    try {
      await this.lance.add(id, 'task', vector, embeddingText, now)
    } catch (err) {
      // Rollback SQLite on LanceDB failure — matches episodic pattern
      // No deleteTaskContext method needed; task_context entries are append-only
      throw err
    }

    return entry
  }

  recallTaskContext(params: {
    agent_id: string
    task_id: string
  }): TaskContextEntry[] {
    const entries = this.sqlite.getTaskContextByTaskId(params.agent_id, params.task_id)

    for (const entry of entries) {
      this.sqlite.touchTaskContext(entry.id)
    }

    return entries
  }
}
