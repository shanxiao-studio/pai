import { describe, expect, it } from 'vitest'
import { buildPromptWithAttachments, formatRejectedAttachments } from '../../../src/renderer/shared/chat-attachments'

const attachment: ChatAttachment = {
  type: 'attachment',
  path: '/tmp/screenshot.png',
  name: 'screenshot.png',
  size: 2048,
  mimeType: 'image/png',
  kind: 'image',
}

describe('chat attachment prompt formatting', () => {
  it('appends attachment paths to the agent prompt', () => {
    expect(buildPromptWithAttachments('Please inspect this', [attachment])).toBe(
      'Please inspect this\n\nAttachments:\n- screenshot.png: /tmp/screenshot.png (2.0 KB)',
    )
  })

  it('uses a fallback prompt when only attachments are sent', () => {
    expect(buildPromptWithAttachments('', [attachment])).toContain('Please review the attached files.')
  })

  it('summarizes rejected attachments', () => {
    expect(formatRejectedAttachments([
      { path: '/tmp/large.zip', name: 'large.zip', size: 1, reason: 'too-large' },
      { path: '/tmp/extra.zip', name: 'extra.zip', size: 1, reason: 'too-many' },
    ])).toBe('Skipped 2 files: 1 over 25 MB, 1 over the 10 file limit.')
  })
})
