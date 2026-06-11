export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 10

export function buildPromptWithAttachments(prompt: string, attachments: ChatAttachment[]) {
  const trimmed = prompt.trim()
  if (attachments.length === 0) return trimmed

  const header = trimmed || 'Please review the attached files.'
  const lines = attachments.map((attachment) => (
    `- ${attachment.name}: ${attachment.path} (${formatBytes(attachment.size)})`
  ))
  return `${header}\n\nAttachments:\n${lines.join('\n')}`
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${formatNumber(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${formatNumber(mb)} MB`
  return `${formatNumber(mb / 1024)} GB`
}

export function formatRejectedAttachments(rejected: RejectedAttachment[]) {
  if (rejected.length === 0) return ''
  const tooLarge = rejected.filter((item) => item.reason === 'too-large').length
  const tooMany = rejected.filter((item) => item.reason === 'too-many').length
  const duplicate = rejected.filter((item) => item.reason === 'duplicate').length
  const parts = [
    tooLarge ? `${tooLarge} over ${formatBytes(MAX_ATTACHMENT_BYTES)}` : '',
    tooMany ? `${tooMany} over the ${MAX_ATTACHMENTS_PER_MESSAGE} file limit` : '',
    duplicate ? `${duplicate} already attached` : '',
  ].filter(Boolean)
  return `Skipped ${rejected.length} file${rejected.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
}

function formatNumber(value: number) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}
