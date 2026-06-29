const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('agentRider', {
  platform: process.platform,
})
