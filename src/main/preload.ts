import { contextBridge, ipcRenderer } from 'electron'
import type { Bridge, Notice } from '../shared/api'

const bridge: Bridge = {
  call: (method, input) => ipcRenderer.invoke('tsmanager:call', method, input),
  onNotice: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, notice: Notice) => callback(notice)
    ipcRenderer.on('tsmanager:notice', listener)
    return () => ipcRenderer.removeListener('tsmanager:notice', listener)
  },
}
contextBridge.exposeInMainWorld('tsmanager', bridge)
