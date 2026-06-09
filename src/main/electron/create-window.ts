import { BrowserWindow } from 'electron'
import { join } from 'path'

export function createMainWindow(distRoot: string, devServerUrl?: string) {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: true,
    webPreferences: {
      preload: join(distRoot, 'preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Pai',
  })

  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
  } else {
    mainWindow.loadFile(join(distRoot, 'renderer/index.html'))
  }

  mainWindow.maximize()
  return mainWindow
}
