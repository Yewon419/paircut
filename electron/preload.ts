import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { CutdeskApi, ExportEvent } from '../shared/api';

const MEDIA_SCHEME = 'media';

const api: CutdeskApi = {
  isTest: () => ipcRenderer.invoke('app:isTest'),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  probeMedia: (paths) => ipcRenderer.invoke('media:probe', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  mediaUrl: (path) => `${MEDIA_SCHEME}://local/${encodeURIComponent(path)}`,
  saveProject: (project, path) => ipcRenderer.invoke('project:save', project, path),
  openProject: () => ipcRenderer.invoke('project:open'),
  pickExportPath: () => ipcRenderer.invoke('export:pickPath'),
  startExport: (project, options) => ipcRenderer.invoke('export:start', project, options),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: ExportEvent) => listener(event);
    ipcRenderer.on('export:event', handler);
    return () => ipcRenderer.removeListener('export:event', handler);
  },
  showInFolder: (path) => ipcRenderer.invoke('shell:showItem', path),
};

contextBridge.exposeInMainWorld('api', api);
