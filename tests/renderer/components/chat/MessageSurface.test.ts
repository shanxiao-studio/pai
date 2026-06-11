import { describe, expect, it } from 'vitest'
import { normalizeStoredParts } from '../../../../src/renderer/components/chat/MessageSurface'

describe('normalizeStoredParts', () => {
  it('keeps stored attachment parts', () => {
    expect(normalizeStoredParts([
      { type: 'attachment', path: '/tmp/screenshot.png', name: 'screenshot.png', size: 2048, mimeType: 'image/png', kind: 'image' },
    ])).toEqual([
      { type: 'attachment', path: '/tmp/screenshot.png', name: 'screenshot.png', size: 2048, mimeType: 'image/png', kind: 'image' },
    ])
  })
})
