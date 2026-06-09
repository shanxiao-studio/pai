import { dirname, resolve } from 'path'

const INTERNAL_WRITE_IGNORE_MS = 1000

export class InternalWriteTracker {
  private internalPathWrites = new Map<string, number>()

  mark(path: string) {
    const expiresAt = Date.now() + INTERNAL_WRITE_IGNORE_MS
    this.internalPathWrites.set(resolve(path), expiresAt)
    this.internalPathWrites.set(resolve(dirname(path)), expiresAt)
  }

  isInternal(path: string) {
    const now = Date.now()
    const resolvedPath = resolve(path)

    for (const [candidate, expiresAt] of this.internalPathWrites) {
      if (expiresAt <= now) {
        this.internalPathWrites.delete(candidate)
        continue
      }
      if (resolvedPath === candidate || resolvedPath.startsWith(`${candidate}/`)) return true
    }

    return false
  }
}
