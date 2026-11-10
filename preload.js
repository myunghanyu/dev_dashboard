const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  history: (since, until) => ipcRenderer.invoke('history', since, until),
  categories: () => ipcRenderer.invoke('categories'),
  setCategory: (repo, cat) => ipcRenderer.invoke('setCategory', repo, cat),
  ticket: (action, arg) => ipcRenderer.invoke('ticket', action, arg),
  onClaude: cb => ipcRenderer.on('claude', (_, id, item) => cb(id, item)),
  release: repo => ipcRenderer.invoke('release', repo),
  releaseCreate: arg => ipcRenderer.invoke('releaseCreate', arg),
  usage: () => ipcRenderer.invoke('usage'),
  budget: () => ipcRenderer.invoke('budget'),
  setBudget: b => ipcRenderer.invoke('setBudget', b),
  status: () => ipcRenderer.invoke('status'),
  actions: slugs => ipcRenderer.invoke('actions', slugs),
  summarize: prompt => ipcRenderer.invoke('summarize', prompt),
  export: (commits, label) => ipcRenderer.invoke('export', commits, label),
})
