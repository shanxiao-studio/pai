import { describe, expect, it } from 'vitest'
import { createChatAttachment, filterChatAttachments, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE } from '../../../src/main/core/attachments'

describe('chat attachments', () => {
  it('rejects duplicate and oversized attachments', () => {
    const existing = [createChatAttachment({ path: '/tmp/a.png', name: 'a.png', size: 100 })]
    const result = filterChatAttachments([
      createChatAttachment({ path: '/tmp/a.png', name: 'a.png', size: 100 }),
      createChatAttachment({ path: '/tmp/b.mov', name: 'b.mov', size: MAX_ATTACHMENT_BYTES + 1 }),
      createChatAttachment({ path: '/tmp/c.txt', name: 'c.txt', size: 100 }),
    ], existing)

    expect(result.accepted.map((item) => item.path)).toEqual(['/tmp/c.txt'])
    expect(result.rejected.map((item) => item.reason)).toEqual(['duplicate', 'too-large'])
  })

  it('rejects attachments over the per-message limit', () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, index) =>
      createChatAttachment({ path: `/tmp/${index}.txt`, name: `${index}.txt`, size: 1 }),
    )

    const result = filterChatAttachments([
      createChatAttachment({ path: '/tmp/extra.txt', name: 'extra.txt', size: 1 }),
    ], existing)

    expect(result.accepted).toEqual([])
    expect(result.rejected).toEqual([
      { path: '/tmp/extra.txt', name: 'extra.txt', size: 1, reason: 'too-many' },
    ])
  })
})
