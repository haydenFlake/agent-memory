import { describe, it, expect } from 'vitest'
import { isValidUlid, clamp } from './validation.js'
import { generateId } from '../core/ulid.js'

describe('isValidUlid', () => {
  it('accepts valid ULIDs from generateId', () => {
    expect(isValidUlid(generateId())).toBe(true)
    expect(isValidUlid(generateId())).toBe(true)
  })

  it('accepts uppercase ULIDs', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true)
  })

  it('accepts lowercase ULIDs', () => {
    expect(isValidUlid('01arz3ndektsv4rrffq69g5fav')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidUlid('')).toBe(false)
  })

  it('rejects too-short strings', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FA')).toBe(false)
  })

  it('rejects too-long strings', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5FAVX')).toBe(false)
  })

  it('rejects SQL injection attempts', () => {
    expect(isValidUlid('" OR 1=1 --')).toBe(false)
    expect(isValidUlid("'; DROP TABLE memories; --")).toBe(false)
  })

  it('rejects strings with special characters', () => {
    expect(isValidUlid('01ARZ3NDEKTSV4RRFFQ69G5F!!')).toBe(false)
  })
})

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5)
  })

  it('clamps to min', () => {
    expect(clamp(-1, 0, 1)).toBe(0)
  })

  it('clamps to max', () => {
    expect(clamp(2, 0, 1)).toBe(1)
  })

  it('returns min when value equals min', () => {
    expect(clamp(0, 0, 1)).toBe(0)
  })

  it('returns max when value equals max', () => {
    expect(clamp(1, 0, 1)).toBe(1)
  })
})
