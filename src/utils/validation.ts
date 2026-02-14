const ULID_REGEX = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i

export function isValidUlid(id: string): boolean {
  return typeof id === 'string' && ULID_REGEX.test(id)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
