import { extname } from 'path'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 10

const IMAGE_EXTENSIONS = new Set(['.apng', '.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'])

export type ChatAttachment = {
  type: 'attachment'
  path: string
  name: string
  size: number
  mimeType?: string
  kind: 'image' | 'file'
}

export type RejectedAttachment = {
  path: string
  name: string
  size: number
  reason: 'duplicate' | 'too-large' | 'too-many'
}

export function createChatAttachment(input: { path: string; name: string; size: number; mimeType?: string }): ChatAttachment {
  return {
    type: 'attachment',
    path: input.path,
    name: input.name,
    size: input.size,
    mimeType: input.mimeType,
    kind: isImageAttachment(input.name, input.mimeType) ? 'image' : 'file',
  }
}

export function filterChatAttachments(
  candidates: ChatAttachment[],
  existing: ChatAttachment[] = [],
): { accepted: ChatAttachment[]; rejected: RejectedAttachment[] } {
  const accepted: ChatAttachment[] = []
  const rejected: RejectedAttachment[] = []
  const paths = new Set(existing.map((attachment) => attachment.path))

  for (const candidate of candidates) {
    if (paths.has(candidate.path)) {
      rejected.push(toRejectedAttachment(candidate, 'duplicate'))
      continue
    }

    if (candidate.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(toRejectedAttachment(candidate, 'too-large'))
      continue
    }

    if (existing.length + accepted.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejected.push(toRejectedAttachment(candidate, 'too-many'))
      continue
    }

    paths.add(candidate.path)
    accepted.push(candidate)
  }

  return { accepted, rejected }
}

function toRejectedAttachment(attachment: ChatAttachment, reason: RejectedAttachment['reason']): RejectedAttachment {
  return {
    path: attachment.path,
    name: attachment.name,
    size: attachment.size,
    reason,
  }
}

function isImageAttachment(name: string, mimeType?: string) {
  return mimeType?.startsWith('image/') || IMAGE_EXTENSIONS.has(extname(name).toLowerCase())
}
