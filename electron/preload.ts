import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { AgentEvent, AgentToolName } from '../shared/agentOps';
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
  startExport: (project, options, texts) => ipcRenderer.invoke('export:start', project, options, texts),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: ExportEvent) => listener(event);
    ipcRenderer.on('export:event', handler);
    return () => ipcRenderer.removeListener('export:event', handler);
  },
  showInFolder: (path) => ipcRenderer.invoke('shell:showItem', path),
  readTextFile: (path) => ipcRenderer.invoke('file:readText', path),
  openTextFile: (extensions, defaultPath) => ipcRenderer.invoke('file:openText', extensions, defaultPath),
  saveTextFile: (content, defaultName, extensions) => ipcRenderer.invoke('file:saveText', content, defaultName, extensions),
  agentAsk: (prompt, model) => ipcRenderer.invoke('agent:ask', prompt, model),
  agentStop: () => ipcRenderer.invoke('agent:stop'),
  agentReset: () => ipcRenderer.invoke('agent:reset'),
  onAgentEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: AgentEvent) => listener(event);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  onAgentCall: (serve) => {
    const handler = (_e: IpcRendererEvent, call: { id: number; name: AgentToolName; input: unknown }) => {
      void serve(call.name, call.input).then((result) => ipcRenderer.send('agent:reply', call.id, result));
    };
    ipcRenderer.on('agent:call', handler);
    return () => ipcRenderer.removeListener('agent:call', handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
