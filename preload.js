const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pet", {
  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  commentate: (args) => ipcRenderer.invoke("commentate", args),
  proactive: (args) => ipcRenderer.invoke("proactive", args),
  getConfig: () => ipcRenderer.invoke("get-config"),
  setConfig: (patch) => ipcRenderer.invoke("set-config", patch),
  testKey: (key) => ipcRenderer.invoke("test-key", key),
  setIgnoreMouse: (ignore) => ipcRenderer.send("set-ignore-mouse", ignore),
  toggleClickThrough: () => ipcRenderer.send("toggle-click-through"),
  onClickThroughChanged: (handler) => ipcRenderer.on("click-through-changed", (_, value) => handler(value)),
  onToggleRunning: (handler) => ipcRenderer.on("toggle-running", handler),
  onRecalled: (handler) => ipcRenderer.on("recalled", handler),
  quit: () => ipcRenderer.send("quit-app"),
});
