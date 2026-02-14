import { describe, it, expect, beforeEach } from 'vitest'
import { LanceStorage } from './lance.js'
import { loadConfig } from '../core/config.js'
import { generateId } from '../core/ulid.js'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lance-test-'))
}

describe('LanceStorage', () => {
  let lance: LanceStorage

  beforeEach(() => {
    const config = loadConfig({ dataDir: makeTempDir() })
    lance = new LanceStorage(config)
  })

  it('adds and counts records', async () => {
    expect(await lance.count()).toBe(0)

    const id = generateId()
    const vector = Array.from({ length: 384 }, () => Math.random())
    await lance.add(id, 'event', vector, 'test content', new Date().toISOString())

    expect(await lance.count()).toBe(1)
  })

  it('searches with vector similarity (closest first)', async () => {
    // Create two vectors: one close to query, one far
    const baseVector = Array.from({ length: 384 }, () => 0.5)
    const closeVector = baseVector.map(v => v + 0.01)
    const farVector = baseVector.map(v => v + 0.5)

    const closeId = generateId()
    const farId = generateId()

    await lance.add(closeId, 'event', closeVector, 'close content', new Date().toISOString())
    await lance.add(farId, 'event', farVector, 'far content', new Date().toISOString())

    const results = await lance.search(baseVector, 10)
    expect(results.length).toBe(2)
    expect(results[0].memory_id).toBe(closeId)
    expect(results[0].distance).toBeLessThan(results[1].distance)
  })

  it('filters by memory_type', async () => {
    const vector = Array.from({ length: 384 }, () => Math.random())

    await lance.add(generateId(), 'event', vector, 'event content', new Date().toISOString())
    await lance.add(generateId(), 'entity', vector, 'entity content', new Date().toISOString())
    await lance.add(generateId(), 'reflection', vector, 'reflection content', new Date().toISOString())

    const events = await lance.search(vector, 10, 'event')
    expect(events.every(r => r.memory_type === 'event')).toBe(true)
    expect(events).toHaveLength(1)

    const entities = await lance.search(vector, 10, 'entity')
    expect(entities.every(r => r.memory_type === 'entity')).toBe(true)
    expect(entities).toHaveLength(1)
  })

  it('deletes records', async () => {
    const id = generateId()
    const vector = Array.from({ length: 384 }, () => Math.random())
    await lance.add(id, 'event', vector, 'to delete', new Date().toISOString())

    expect(await lance.count()).toBe(1)

    await lance.delete(id)
    expect(await lance.count()).toBe(0)
  })

  it('handles batch additions', async () => {
    const records = Array.from({ length: 5 }, () => ({
      memoryId: generateId(),
      memoryType: 'event' as const,
      vector: Array.from({ length: 384 }, () => Math.random()),
      content: 'batch item',
      createdAt: new Date().toISOString(),
    }))

    await lance.addBatch(records)
    expect(await lance.count()).toBe(5)
  })

  it('rejects wrong vector dimensions in add()', async () => {
    const wrongVector = Array.from({ length: 128 }, () => 0)
    await expect(
      lance.add(generateId(), 'event', wrongVector, 'test', new Date().toISOString()),
    ).rejects.toThrow('Vector dimension mismatch: expected 384, got 128')
  })

  it('rejects wrong vector dimensions in addBatch()', async () => {
    const records = [{
      memoryId: generateId(),
      memoryType: 'event' as const,
      vector: Array.from({ length: 10 }, () => 0),
      content: 'test',
      createdAt: new Date().toISOString(),
    }]
    await expect(lance.addBatch(records)).rejects.toThrow('Vector dimension mismatch')
  })

  it('rejects invalid ULID', async () => {
    const vector = Array.from({ length: 384 }, () => 0)
    await expect(
      lance.add('not-a-ulid', 'event', vector, 'test', new Date().toISOString()),
    ).rejects.toThrow('Invalid memory ID format')
  })

  it('concurrent ensureTable calls do not race', async () => {
    const vector = Array.from({ length: 384 }, () => Math.random())

    // Fire 3 adds concurrently — all need ensureTable
    await Promise.all([
      lance.add(generateId(), 'event', vector, 'concurrent 1', new Date().toISOString()),
      lance.add(generateId(), 'event', vector, 'concurrent 2', new Date().toISOString()),
      lance.add(generateId(), 'event', vector, 'concurrent 3', new Date().toISOString()),
    ])

    expect(await lance.count()).toBe(3)
  })
})
