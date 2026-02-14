import { describe, it, expect } from 'vitest'
import { escapeXml } from './xml.js'

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b')
  })

  it('escapes less-than', () => {
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;')
  })

  it('escapes double quotes', () => {
    expect(escapeXml('say "hello"')).toBe('say &quot;hello&quot;')
  })

  it('escapes single quotes', () => {
    expect(escapeXml("it's")).toBe('it&apos;s')
  })

  it('escapes all special characters together', () => {
    expect(escapeXml('<a href="x&y">it\'s</a>')).toBe(
      '&lt;a href=&quot;x&amp;y&quot;&gt;it&apos;s&lt;/a&gt;',
    )
  })

  it('returns empty string unchanged', () => {
    expect(escapeXml('')).toBe('')
  })

  it('returns safe string unchanged', () => {
    expect(escapeXml('hello world 123')).toBe('hello world 123')
  })

  it('handles script injection attempt', () => {
    expect(escapeXml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    )
  })
})
