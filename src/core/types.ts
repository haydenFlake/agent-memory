export interface MemoryEvent {
  id: string
  agent_id: string
  event_type: EventType
  content: string
  importance: number
  entities: string[]
  metadata: Record<string, unknown>
  created_at: string
  accessed_at: string | null
  access_count: number
}

export type EventType =
  | 'message'
  | 'email'
  | 'action'
  | 'decision'
  | 'observation'
  | 'communication'
  | 'file_change'
  | 'error'
  | 'milestone'

export interface CoreMemoryBlock {
  id: string
  block_type: 'persona' | 'user_profile'
  block_key: string
  content: string
  updated_at: string
}

export interface Entity {
  id: string
  name: string
  entity_type: EntityType
  summary: string | null
  observations: string[]
  importance: number
  created_at: string
  updated_at: string
  accessed_at: string | null
  access_count: number
}

export type EntityType =
  | 'person'
  | 'project'
  | 'concept'
  | 'preference'
  | 'tool'
  | 'organization'
  | 'location'
  | 'topic'

export interface Relation {
  id: string
  from_entity: string
  to_entity: string
  relation_type: string
  weight: number
  valid_from: string
  valid_until: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export interface Reflection {
  id: string
  content: string
  source_ids: string[]
  importance: number
  depth: number
  created_at: string
  accessed_at: string | null
  access_count: number
}

export type TaskPhase = 'start' | 'in_progress' | 'completed' | 'blocked'

export interface TaskContextEntry {
  id: string
  agent_id: string
  task_id: string
  title: string
  phase: TaskPhase
  content: string
  importance: number
  created_at: string
  accessed_at: string | null
  access_count: number
}

export interface ScoredMemory {
  id: string
  source: 'event' | 'entity' | 'reflection' | 'task'
  content: string
  score: number
  recency_score: number
  importance_score: number
  relevance_score: number
  created_at: string
  metadata?: Record<string, unknown>
}

export interface RecallResult {
  core_memory: CoreMemoryBlock[]
  memories: ScoredMemory[]
  total_searched: number
}

export interface TimeRange {
  start: string
  end: string
}

export interface MemoryStats {
  event_count: number
  entity_count: number
  relation_count: number
  reflection_count: number
  task_context_count: number
  core_memory_blocks: number
  last_reflection_at: string | null
  last_consolidation_at: string | null
  oldest_event: string | null
  newest_event: string | null
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  dimensions(): number
}
