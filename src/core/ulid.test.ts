import { describe, it, expect } from 'vitest'
import { generateId, generateIdAt } from './ulid.js'

describe('ULID generation', () => {
  it('generates unique IDs', () => {
    const id1 = generateId()
    const id2 = generateId()
    expect(id1).not.toBe(id2)
    expect(id1).toHaveLength(26)
  })

  it('generates time-sortable IDs', () => {
    const id1 = generateIdAt(1000000)
    const id2 = generateIdAt(2000000)
    expect(id1 < id2).toBe(true)
  })
})
