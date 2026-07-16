/**
 * The complete API surface exposed to the sandboxed renderer. Note what is
 * absent: the viewer token, the server URL after connect, any filesystem or
 * shell access. The UI can ask for bytes and printer names — nothing else.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  launchConfig: () => ipcRenderer.invoke("launch-config"),
  verify: (args) => ipcRenderer.invoke("verify", args),
  fetchDoc: () => ipcRenderer.invoke("fetch-doc"),
  listPrinters: () => ipcRenderer.invoke("list-printers"),
  print: (args) => ipcRenderer.invoke("print", args),
  confirmPrint: () => ipcRenderer.invoke("confirm-print"),
  closeSession: () => ipcRenderer.invoke("close-session"),
  selftestReport: (report) => ipcRenderer.send("selftest-report", report),
});
