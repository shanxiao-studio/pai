import { describe, expect, it } from 'vitest'
import { shouldSubmitPromptOnKeyDown } from '../../../../src/renderer/components/project/PromptComposer'

describe('shouldSubmitPromptOnKeyDown', () => {
  it('submits on plain Enter', () => {
    expect(shouldSubmitPromptOnKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: {},
    })).toBe(true)
  })

  it('does not submit on Shift+Enter', () => {
    expect(shouldSubmitPromptOnKeyDown({
      key: 'Enter',
      shiftKey: true,
      nativeEvent: {},
    })).toBe(false)
  })

  it('does not submit while IME composition is active', () => {
    expect(shouldSubmitPromptOnKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: true },
    })).toBe(false)
  })

  it('does not submit on IME confirmation key events reported as keyCode 229', () => {
    expect(shouldSubmitPromptOnKeyDown({
      key: 'Enter',
      shiftKey: false,
      nativeEvent: { isComposing: false, keyCode: 229 },
    })).toBe(false)
  })
})
