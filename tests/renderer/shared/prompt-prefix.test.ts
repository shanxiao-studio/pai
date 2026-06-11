import { describe, expect, it } from 'vitest'
import { applyPromptSuggestion, filterPromptSuggestions, findPromptPrefixToken, type PromptSuggestion } from '../../../src/renderer/shared/prompt-prefix'

describe('prompt prefix helpers', () => {
  it('finds a prefix token before the cursor', () => {
    expect(findPromptPrefixToken('please use $git', 15)).toEqual({
      prefix: '$',
      query: 'git',
      start: 11,
      end: 15,
    })
  })

  it('does not match prefixes in the middle of a token', () => {
    expect(findPromptPrefixToken('email@example.com', 7)).toBeNull()
  })

  it('applies a suggestion at the active token', () => {
    const token = findPromptPrefixToken('open @src', 9)
    expect(token).not.toBeNull()
    expect(applyPromptSuggestion('open @src', token!, '@src/main.ts')).toEqual({
      value: 'open @src/main.ts',
      cursor: 17,
    })
  })

  it('filters suggestions by prefix and query', () => {
    const items: PromptSuggestion[] = [
      { id: 'skill', prefix: '$', label: '$git-commit', value: '$git-commit' },
      { id: 'cmd', prefix: '/', label: '/review', value: '/review' },
    ]

    expect(filterPromptSuggestions(items, findPromptPrefixToken('$git', 4))).toEqual([items[0]])
  })
})
