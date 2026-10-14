/**
 * The complete API surface exposed to the sandboxed renderer. Note what is
 * absent: the viewer token, the counter's device key, any filesystem or
 * shell access. The UI can ask for bytes, printer names, the job queue and
 * the counter's public name/code/QR — nothing else.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  launchConfig: () => ipcRenderer.invoke("launch-config"),
  counterInfo: () => ipcRenderer.invoke("counter-info"),
  registerCounter: (args) => ipcRenderer.invoke("register-counter", args),
  forgetCounter: () => ipcRenderer.invoke("forget-counter"),
  jobs: () => ipcRenderer.invoke("jobs"),
  verify: (args) => ipcRenderer.invoke("verify", args),
  awaitApproval: () => ipcRenderer.invoke("await-approval"),
  cancelApproval: () => ipcRenderer.invoke("cancel-approval"),
  fetchDoc: () => ipcRenderer.invoke("fetch-doc"),
  listPrinters: () => ipcRenderer.invoke("list-printers"),
  print: (args) => ipcRenderer.invoke("print", args),
  confirmPrint: () => ipcRenderer.invoke("confirm-print"),
  closeSession: () => ipcRenderer.invoke("close-session"),
  selftestReport: (report) => ipcRenderer.send("selftest-report", report),
});
