import { ulid } from 'ulid'

export function generateId(): string {
  return ulid()
}

export function generateIdAt(timestamp: number): string {
  return ulid(timestamp)
}
