export type PromptPrefix = '/' | '$' | '!' | '@'

export type PromptPrefixToken = {
  prefix: PromptPrefix
  query: string
  start: number
  end: number
}

const PREFIXES = new Set(['/','$','!','@'])

export function findPromptPrefixToken(value: string, cursor: number): PromptPrefixToken | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(^|\s)([\/$!@])([^\s]*)$/)
  if (!match) return null
  const prefix = match[2]
  if (!PREFIXES.has(prefix)) return null
  const token = `${prefix}${match[3] ?? ''}`
  const start = cursor - token.length
  return {
    prefix: prefix as PromptPrefix,
    query: match[3] ?? '',
    start,
    end: cursor,
  }
}

export function applyPromptSuggestion(value: string, token: PromptPrefixToken, insertText: string) {
  const nextValue = `${value.slice(0, token.start)}${insertText}${value.slice(token.end)}`
  const cursor = token.start + insertText.length
  return { value: nextValue, cursor }
}

export type PromptSuggestion = {
  id: string
  label: string
  value: string
  detail?: string
  description?: string
  prefix: PromptPrefix
}

export function filterPromptSuggestions(items: PromptSuggestion[], token: PromptPrefixToken | null) {
  if (!token) return []
  const query = token.query.toLowerCase()
  return items
    .filter((item) => item.prefix === token.prefix)
    .filter((item) => !query || item.label.toLowerCase().includes(query) || item.value.toLowerCase().includes(query))
    .slice(0, 8)
}
