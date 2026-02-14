import * as lancedb from '@lancedb/lancedb'
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { Config } from '../core/config.js'
import { StorageError } from '../core/errors.js'
import { isValidUlid } from '../utils/validation.js'

interface VectorRecord {
  [key: string]: unknown
  vector: number[]
  memory_id: string
  memory_type: 'event' | 'entity' | 'reflection'
  content: string
  created_at: string
}

export interface VectorSearchResult {
  memory_id: string
  memory_type: 'event' | 'entity' | 'reflection'
  content: string
  created_at: string
  distance: number
}

export class LanceStorage {
  private db!: lancedb.Connection
  private table: lancedb.Table | null = null
  private dimensions: number
  private ready: Promise<void>

  constructor(config: Config) {
    this.dimensions = config.embeddingDimensions
    const lanceDir = join(config.dataDir, 'lancedb')
    mkdirSync(lanceDir, { recursive: true })
    this.ready = this.init(lanceDir)
  }

  private async init(dataDir: string): Promise<void> {
    this.db = await lancedb.connect(dataDir)
    const tableNames = await this.db.tableNames()
    if (tableNames.includes('memories')) {
      this.table = await this.db.openTable('memories')
    }
  }

  private async ensureTable(): Promise<lancedb.Table> {
    await this.ready
    if (!this.table) {
      const emptyRecord: VectorRecord = {
        vector: new Array(this.dimensions).fill(0),
        memory_id: '__init__',
        memory_type: 'event',
        content: '',
        created_at: new Date().toISOString(),
      }
      this.table = await this.db.createTable('memories', [emptyRecord])
      await this.table.delete('memory_id = "__init__"')
    }
    return this.table
  }

  async add(
    memoryId: string,
    memoryType: 'event' | 'entity' | 'reflection',
    vector: number[],
    content: string,
    createdAt: string,
  ): Promise<void> {
    if (!isValidUlid(memoryId)) {
      throw new StorageError(`Invalid memory ID format: ${memoryId}`)
    }
    const table = await this.ensureTable()
    const record: VectorRecord = {
      vector,
      memory_id: memoryId,
      memory_type: memoryType,
      content,
      created_at: createdAt,
    }
    await table.add([record])
  }

  async addBatch(records: Array<{
    memoryId: string
    memoryType: 'event' | 'entity' | 'reflection'
    vector: number[]
    content: string
    createdAt: string
  }>): Promise<void> {
    if (records.length === 0) return
    for (const r of records) {
      if (!isValidUlid(r.memoryId)) {
        throw new StorageError(`Invalid memory ID format: ${r.memoryId}`)
      }
    }
    const table = await this.ensureTable()
    const vectorRecords: VectorRecord[] = records.map(r => ({
      vector: r.vector,
      memory_id: r.memoryId,
      memory_type: r.memoryType,
      content: r.content,
      created_at: r.createdAt,
    }))
    await table.add(vectorRecords)
  }

  async search(
    queryVector: number[],
    limit: number = 20,
    memoryType?: 'event' | 'entity' | 'reflection',
  ): Promise<VectorSearchResult[]> {
    const table = await this.ensureTable()
    let query = table.search(queryVector).limit(limit)

    if (memoryType) {
      const allowed = ['event', 'entity', 'reflection'] as const
      if (!allowed.includes(memoryType)) {
        throw new Error(`Invalid memory_type: ${memoryType}`)
      }
      query = query.where(`memory_type = '${memoryType}'`)
    }

    const results = await query.toArray()

    return results.map(row => ({
      memory_id: row.memory_id as string,
      memory_type: row.memory_type as 'event' | 'entity' | 'reflection',
      content: row.content as string,
      created_at: row.created_at as string,
      distance: (row._distance as number) ?? 0,
    }))
  }

  async delete(memoryId: string): Promise<void> {
    if (!isValidUlid(memoryId)) {
      throw new StorageError(`Invalid memory ID format: ${memoryId}`)
    }
    const table = await this.ensureTable()
    await table.delete(`memory_id = "${memoryId}"`)
  }

  async count(): Promise<number> {
    await this.ready
    if (!this.table) return 0
    return await this.table.countRows()
  }
}
