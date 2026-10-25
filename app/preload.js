'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The only door between the island's page and the app: state in, decisions out.
// Not `island`: the page's #island element already answers to that name on `window`.
contextBridge.exposeInMainWorld('claudeIsland', {
  onState: callback => ipcRenderer.on('island:state', (_event, state) => callback(state)),
  ready: () => ipcRenderer.send('island:ready'),
  hover: isOver => ipcRenderer.send('island:hover', Boolean(isOver)),
  decide: (id, decision, answers) => ipcRenderer.send('island:decide', { id, decision, answers }),
  setCompanion: change => ipcRenderer.send('island:companion', change),
  setTheme: theme => ipcRenderer.send('island:theme', theme),
  setAnchor: anchor => ipcRenderer.send('island:anchor', String(anchor)),
  openServer: port => ipcRenderer.send('island:open-server', Number(port)),
})
