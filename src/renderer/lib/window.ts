import { electronClient } from '@/shared/api/electron-client'

export function minimizeWindow() {
  void electronClient?.minimizeWindow()
}

export function closeWindow() {
  void electronClient?.closeWindow()
}

export function toggleMaximize() {
  void electronClient?.toggleMaximize()
}
