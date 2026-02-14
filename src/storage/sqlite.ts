import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { Config } from '../core/config.js'
import { stateKeys } from '../core/constants.js'
import { StorageError } from '../core/errors.js'
import type {
  CoreMemoryBlock,
  Entity,
  MemoryEvent,
  MemoryStats,
  Reflection,
  Relation,
  TaskContextEntry,
} from '../core/types.js'
import { logger } from '../utils/logger.js'

// TODO: Add transaction support. Currently relies on WAL mode + embed-first pattern to minimize inconsistency windows.
export class SqliteStorage {
  private db: Database.Database

  constructor(config: Config) {
    const dbPath = join(config.dataDir, 'memory.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('wal_autocheckpoint = 1000')
    this.migrate()
  }

  static inMemory(): SqliteStorage {
    const storage = Object.create(SqliteStorage.prototype) as SqliteStorage
    storage.db = new Database(':memory:')
    storage.db.pragma('foreign_keys = ON')
    storage.migrate()
    return storage
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.5,
        entities TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        accessed_at TEXT,
        access_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_events_agent_time ON events(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_importance ON events(importance);

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        content,
        content=events,
        content_rowid=rowid
      );

      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
        DELETE FROM events_fts WHERE rowid = old.rowid;
      END;

      CREATE TABLE IF NOT EXISTS core_memory (
        id TEXT PRIMARY KEY,
        block_type TEXT NOT NULL,
        block_key TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(block_type, block_key)
      );

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        summary TEXT,
        observations TEXT DEFAULT '[]',
        importance REAL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accessed_at TEXT,
        access_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        from_entity TEXT NOT NULL REFERENCES entities(id),
        to_entity TEXT NOT NULL REFERENCES entities(id),
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        valid_from TEXT NOT NULL,
        valid_until TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_entity);
      CREATE INDEX IF NOT EXISTS idx_relations_type ON relations(relation_type);

      CREATE TABLE IF NOT EXISTS reflections (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_ids TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL,
        depth INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        accessed_at TEXT,
        access_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_reflections_importance ON reflections(importance);
      CREATE INDEX IF NOT EXISTS idx_reflections_depth ON reflections(depth);

      CREATE TABLE IF NOT EXISTS task_context (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        phase TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL DEFAULT 0.6,
        created_at TEXT NOT NULL,
        accessed_at TEXT,
        access_count INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_task_context_agent_task ON task_context(agent_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_task_context_task ON task_context(task_id);
      CREATE INDEX IF NOT EXISTS idx_task_context_phase ON task_context(phase);

      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    const existing = this.db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined
    if (!existing) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
    }
  }

  // --- Events ---

  insertEvent(event: MemoryEvent): void {
    this.db.prepare(`
      INSERT INTO events (id, agent_id, event_type, content, importance, entities, metadata, created_at, accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.agent_id,
      event.event_type,
      event.content,
      event.importance,
      JSON.stringify(event.entities),
      JSON.stringify(event.metadata),
      event.created_at,
      event.accessed_at,
      event.access_count,
    )
  }

  getEvent(id: string): MemoryEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToEvent(row) : null
  }

  searchEventsFts(query: string, limit: number = 20): MemoryEvent[] {
    try {
      const rows = this.db.prepare(`
        SELECT e.* FROM events e
        JOIN events_fts fts ON e.rowid = fts.rowid
        WHERE events_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit) as Record<string, unknown>[]
      return rows.map(r => this.rowToEvent(r))
    } catch (err) {
      logger.warn('FTS5 query failed, returning empty results', { query, error: err })
      return []
    }
  }

  getEventsByTimeRange(
    agentId: string,
    start: string,
    end: string,
    eventType?: string,
    limit: number = 50,
  ): MemoryEvent[] {
    let sql = 'SELECT * FROM events WHERE agent_id = ? AND created_at >= ? AND created_at <= ?'
    const params: unknown[] = [agentId, start, end]

    if (eventType) {
      sql += ' AND event_type = ?'
      params.push(eventType)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(r => this.rowToEvent(r))
  }

  getRecentEvents(agentId: string, limit: number = 100): MemoryEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM events WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(agentId, limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToEvent(r))
  }

  getUnreflectedEvents(agentId: string, limit: number = 500): MemoryEvent[] {
    const lastReflectedAt = this.getState(stateKeys.lastReflectedAt(agentId))
    let sql = 'SELECT * FROM events WHERE agent_id = ?'
    const params: unknown[] = [agentId]
    if (lastReflectedAt) {
      sql += ' AND created_at > ?'
      params.push(lastReflectedAt)
    }
    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)
    return this.db.prepare(sql).all(...params).map(r => this.rowToEvent(r as Record<string, unknown>))
  }

  getEventsByIds(ids: string[]): Map<string, MemoryEvent> {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM events WHERE id IN (${placeholders})`,
    ).all(...ids) as Record<string, unknown>[]
    const map = new Map<string, MemoryEvent>()
    for (const row of rows) {
      const event = this.rowToEvent(row)
      map.set(event.id, event)
    }
    return map
  }

  touchEvent(id: string): void {
    this.db.prepare(`
      UPDATE events SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?
    `).run(id)
  }

  deleteEvent(id: string): void {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id)
  }

  getEventCount(agentId?: string): number {
    if (agentId) {
      return (this.db.prepare('SELECT COUNT(*) as c FROM events WHERE agent_id = ?').get(agentId) as { c: number }).c
    }
    return (this.db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c
  }

  // --- Core Memory ---

  upsertCoreMemory(block: CoreMemoryBlock): void {
    this.db.prepare(`
      INSERT INTO core_memory (id, block_type, block_key, content, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(block_type, block_key)
      DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at
    `).run(block.id, block.block_type, block.block_key, block.content, block.updated_at)
  }

  getCoreMemory(blockType?: string): CoreMemoryBlock[] {
    let sql = 'SELECT * FROM core_memory'
    const params: unknown[] = []
    if (blockType) {
      sql += ' WHERE block_type = ?'
      params.push(blockType)
    }
    sql += ' ORDER BY block_type, block_key'
    const rows = this.db.prepare(sql).all(...params) as CoreMemoryBlock[]
    return rows
  }

  getCoreMemoryBlock(blockType: string, blockKey: string): CoreMemoryBlock | null {
    const row = this.db.prepare(
      'SELECT * FROM core_memory WHERE block_type = ? AND block_key = ?',
    ).get(blockType, blockKey) as CoreMemoryBlock | undefined
    return row ?? null
  }

  deleteCoreMemory(blockType: string, blockKey: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM core_memory WHERE block_type = ? AND block_key = ?',
    ).run(blockType, blockKey)
    return result.changes > 0
  }

  // --- Entities ---

  upsertEntity(entity: Entity): void {
    this.db.prepare(`
      INSERT INTO entities (id, name, entity_type, summary, observations, importance, created_at, updated_at, accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name)
      DO UPDATE SET
        entity_type = excluded.entity_type,
        summary = COALESCE(excluded.summary, entities.summary),
        observations = excluded.observations,
        importance = excluded.importance,
        updated_at = excluded.updated_at,
        accessed_at = entities.accessed_at,
        access_count = entities.access_count
    `).run(
      entity.id,
      entity.name,
      entity.entity_type,
      entity.summary,
      JSON.stringify(entity.observations),
      entity.importance,
      entity.created_at,
      entity.updated_at,
      entity.accessed_at,
      entity.access_count,
    )
  }

  getEntity(name: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE name = ? COLLATE NOCASE LIMIT 1').get(name) as Record<string, unknown> | undefined
    return row ? this.rowToEntity(row) : null
  }

  getEntityById(id: string): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToEntity(row) : null
  }

  getAllEntities(entityType?: string): Entity[] {
    let sql = 'SELECT * FROM entities'
    const params: unknown[] = []
    if (entityType) {
      sql += ' WHERE entity_type = ?'
      params.push(entityType)
    }
    sql += ' ORDER BY updated_at DESC'
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(r => this.rowToEntity(r))
  }

  getEntitiesByIds(ids: string[]): Map<string, Entity> {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM entities WHERE id IN (${placeholders})`,
    ).all(...ids) as Record<string, unknown>[]
    const map = new Map<string, Entity>()
    for (const row of rows) {
      const entity = this.rowToEntity(row)
      map.set(entity.id, entity)
    }
    return map
  }

  touchEntity(id: string): void {
    this.db.prepare(`
      UPDATE entities SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?
    `).run(id)
  }

  getEntityCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }).c
  }

  // --- Relations ---

  insertRelation(relation: Relation): void {
    try {
      this.db.prepare(`
        INSERT INTO relations (id, from_entity, to_entity, relation_type, weight, valid_from, valid_until, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        relation.id,
        relation.from_entity,
        relation.to_entity,
        relation.relation_type,
        relation.weight,
        relation.valid_from,
        relation.valid_until,
        JSON.stringify(relation.metadata),
        relation.created_at,
      )
    } catch (err) {
      if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
        throw new StorageError('Cannot create relation: entity not found', err)
      }
      throw err
    }
  }

  invalidateRelation(fromEntity: string, toEntity: string, relationType: string, validUntil: string): void {
    this.db.prepare(`
      UPDATE relations SET valid_until = ?
      WHERE from_entity = ? AND to_entity = ? AND relation_type = ? AND valid_until IS NULL
    `).run(validUntil, fromEntity, toEntity, relationType)
  }

  getRelationsFor(entityId: string, activeOnly: boolean = true): Relation[] {
    let sql = 'SELECT * FROM relations WHERE (from_entity = ? OR to_entity = ?)'
    const params: unknown[] = [entityId, entityId]
    if (activeOnly) {
      sql += ' AND valid_until IS NULL'
    }
    sql += ' ORDER BY created_at DESC'
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    return rows.map(r => this.rowToRelation(r))
  }

  getRelationCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM relations').get() as { c: number }).c
  }

  // --- Reflections ---

  insertReflection(reflection: Reflection): void {
    this.db.prepare(`
      INSERT INTO reflections (id, content, source_ids, importance, depth, created_at, accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reflection.id,
      reflection.content,
      JSON.stringify(reflection.source_ids),
      reflection.importance,
      reflection.depth,
      reflection.created_at,
      reflection.accessed_at,
      reflection.access_count,
    )
  }

  getReflections(limit: number = 50): Reflection[] {
    const rows = this.db.prepare(
      'SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as Record<string, unknown>[]
    return rows.map(r => this.rowToReflection(r))
  }

  getReflectionById(id: string): Reflection | null {
    const row = this.db.prepare('SELECT * FROM reflections WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.rowToReflection(row) : null
  }

  getReflectionsByIds(ids: string[]): Map<string, Reflection> {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM reflections WHERE id IN (${placeholders})`,
    ).all(...ids) as Record<string, unknown>[]
    const map = new Map<string, Reflection>()
    for (const row of rows) {
      const reflection = this.rowToReflection(row)
      map.set(reflection.id, reflection)
    }
    return map
  }

  touchReflection(id: string): void {
    this.db.prepare(`
      UPDATE reflections SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?
    `).run(id)
  }

  getReflectionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM reflections').get() as { c: number }).c
  }

  // --- Task Context ---

  insertTaskContext(entry: TaskContextEntry): void {
    this.db.prepare(`
      INSERT INTO task_context (id, agent_id, task_id, title, phase, content, importance, created_at, accessed_at, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.agent_id,
      entry.task_id,
      entry.title,
      entry.phase,
      entry.content,
      entry.importance,
      entry.created_at,
      entry.accessed_at,
      entry.access_count,
    )
  }

  getTaskContextByTaskId(agentId: string, taskId: string): TaskContextEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM task_context WHERE agent_id = ? AND task_id = ? ORDER BY created_at ASC',
    ).all(agentId, taskId) as Record<string, unknown>[]
    return rows.map(r => this.rowToTaskContext(r))
  }

  getTaskContextsByIds(ids: string[]): Map<string, TaskContextEntry> {
    if (ids.length === 0) return new Map()
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT * FROM task_context WHERE id IN (${placeholders})`,
    ).all(...ids) as Record<string, unknown>[]
    const map = new Map<string, TaskContextEntry>()
    for (const row of rows) {
      const entry = this.rowToTaskContext(row)
      map.set(entry.id, entry)
    }
    return map
  }

  touchTaskContext(id: string): void {
    this.db.prepare(`
      UPDATE task_context SET accessed_at = datetime('now'), access_count = access_count + 1 WHERE id = ?
    `).run(id)
  }

  getTaskContextCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM task_context').get() as { c: number }).c
  }

  // --- State ---

  setState(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run(key, value)
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  // --- Stats ---

  getStats(): MemoryStats {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM events) as event_count,
        (SELECT COUNT(*) FROM entities) as entity_count,
        (SELECT COUNT(*) FROM relations) as relation_count,
        (SELECT COUNT(*) FROM reflections) as reflection_count,
        (SELECT COUNT(*) FROM task_context) as task_context_count,
        (SELECT COUNT(*) FROM core_memory) as core_blocks,
        (SELECT created_at FROM events ORDER BY created_at ASC LIMIT 1) as oldest_event,
        (SELECT created_at FROM events ORDER BY created_at DESC LIMIT 1) as newest_event
    `).get() as {
      event_count: number
      entity_count: number
      relation_count: number
      reflection_count: number
      task_context_count: number
      core_blocks: number
      oldest_event: string | null
      newest_event: string | null
    }

    return {
      event_count: row.event_count,
      entity_count: row.entity_count,
      relation_count: row.relation_count,
      reflection_count: row.reflection_count,
      task_context_count: row.task_context_count,
      core_memory_blocks: row.core_blocks,
      last_reflection_at: this.getState(stateKeys.lastReflectionAt),
      last_consolidation_at: this.getState(stateKeys.lastConsolidationAt),
      oldest_event: row.oldest_event ?? null,
      newest_event: row.newest_event ?? null,
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }

  // --- Row Converters ---

  private safeJsonParse<T>(value: unknown, fallback: T): T {
    if (typeof value !== 'string' || !value) return fallback
    try {
      return JSON.parse(value) as T
    } catch (err) {
      logger.warn('JSON parse failed in row converter, using fallback', { value: String(value).slice(0, 100), error: err })
      return fallback
    }
  }

  private rowToEvent(row: Record<string, unknown>): MemoryEvent {
    return {
      id: row.id as string,
      agent_id: row.agent_id as string,
      event_type: row.event_type as MemoryEvent['event_type'],
      content: row.content as string,
      importance: row.importance as number,
      entities: this.safeJsonParse<string[]>(row.entities, []),
      metadata: this.safeJsonParse<Record<string, unknown>>(row.metadata, {}),
      created_at: row.created_at as string,
      accessed_at: (row.accessed_at as string) || null,
      access_count: (row.access_count as number) || 0,
    }
  }

  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      id: row.id as string,
      name: row.name as string,
      entity_type: row.entity_type as Entity['entity_type'],
      summary: (row.summary as string) || null,
      observations: this.safeJsonParse<string[]>(row.observations, []),
      importance: row.importance as number,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      accessed_at: (row.accessed_at as string) || null,
      access_count: (row.access_count as number) || 0,
    }
  }

  private rowToRelation(row: Record<string, unknown>): Relation {
    return {
      id: row.id as string,
      from_entity: row.from_entity as string,
      to_entity: row.to_entity as string,
      relation_type: row.relation_type as string,
      weight: row.weight as number,
      valid_from: row.valid_from as string,
      valid_until: (row.valid_until as string) || null,
      metadata: this.safeJsonParse<Record<string, unknown>>(row.metadata, {}),
      created_at: row.created_at as string,
    }
  }

  private rowToReflection(row: Record<string, unknown>): Reflection {
    return {
      id: row.id as string,
      content: row.content as string,
      source_ids: this.safeJsonParse<string[]>(row.source_ids, []),
      importance: row.importance as number,
      depth: (row.depth as number) || 1,
      created_at: row.created_at as string,
      accessed_at: (row.accessed_at as string) || null,
      access_count: (row.access_count as number) || 0,
    }
  }

  private rowToTaskContext(row: Record<string, unknown>): TaskContextEntry {
    return {
      id: row.id as string,
      agent_id: row.agent_id as string,
      task_id: row.task_id as string,
      title: row.title as string,
      phase: row.phase as TaskContextEntry['phase'],
      content: row.content as string,
      importance: row.importance as number,
      created_at: row.created_at as string,
      accessed_at: (row.accessed_at as string) || null,
      access_count: (row.access_count as number) || 0,
    }
  }
}
