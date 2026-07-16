/**
 * SafePrint Agent — main process.
 *
 * Security model (what this closes vs. the browser portal):
 *  - Printing is SILENT and direct-to-device: webContents.print() with a
 *    deviceName never opens the OS print dialog, so "Save as PDF" and every
 *    other virtual destination simply never appears.
 *  - Only physical printers are offered: virtual/file printers (Microsoft
 *    Print to PDF, XPS, OneNote, CUPS-PDF, PDF24…) are filtered by
 *    name/driver heuristics before the renderer ever sees the list.
 *  - The viewer token never enters the renderer: all network calls happen
 *    here in the main process; the UI receives only document bytes and
 *    printer names. A compromised renderer cannot exfiltrate the session.
 *  - setContentProtection(true): the document window is excluded from
 *    screenshots/screen capture on Windows (SetWindowDisplayAffinity) and
 *    macOS (NSWindowSharingNone). No-op on Linux — documented limitation.
 *  - Decrypted bytes live only in memory; nothing is written to disk.
 *  - Renderer is sandboxed (contextIsolation, no nodeIntegration), all
 *    navigation/new windows/permission requests are denied, Ctrl/Cmd+P/S/C
 *    are intercepted, and there is no application menu to expose Print.
 */
const { app, BrowserWindow, Menu, ipcMain, protocol, session } = require("electron");
const path = require("path");
const fs = require("fs");

app.enableSandbox();
Menu.setApplicationMenu(null);

// ---------------------------------------------------------------------------
// CLI / selftest configuration
// ---------------------------------------------------------------------------
function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
}
const SELFTEST = process.argv.includes("--selftest");
const LAUNCH = {
  selftest: SELFTEST,
  server: argValue("server") || "",
  code: argValue("code") || "",
  otp: argValue("otp") || "",
};

// ---------------------------------------------------------------------------
// In-memory session state — the renderer never sees the token.
// ---------------------------------------------------------------------------
const state = {
  serverUrl: null,
  viewerToken: null,
  finished: false, // printed or closed
};

const CLIENT_HEADER = { "X-SafePrint-Client": `agent/${app.getVersion()}` };

async function api(pathname, { method = "GET", body, auth = false } = {}) {
  const headers = { ...CLIENT_HEADER };
  if (auth) headers.Authorization = `Bearer ${state.viewerToken}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(new URL(pathname, state.serverUrl), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

// ---------------------------------------------------------------------------
// Physical-printer filtering (pure module — unit-testable with plain Node)
// ---------------------------------------------------------------------------
const { splitPrinters } = require("./printer-filter.cjs");

// ---------------------------------------------------------------------------
// Best-effort session close so an abandoned window still destroys the file.
// ---------------------------------------------------------------------------
async function closeSessionBeacon() {
  if (!state.viewerToken || state.finished) return;
  state.finished = true;
  try {
    await Promise.race([
      api("/api/session-close", { method: "POST", body: { viewerToken: state.viewerToken } }),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch {
    /* server unreachable — TTL cleanup is the backstop */
  }
  state.viewerToken = null;
}

// ---------------------------------------------------------------------------
// IPC surface (the entire API available to the sandboxed renderer)
// ---------------------------------------------------------------------------
ipcMain.handle("launch-config", () => LAUNCH);

ipcMain.handle("verify", async (_e, { server, code, otp }) => {
  let base;
  try {
    base = new URL(server).origin;
  } catch {
    return { ok: false, error: "Enter a valid server URL (e.g. https://safeprint.example.com)." };
  }
  state.serverUrl = base;
  const res = await api("/api/verify-otp", {
    method: "POST",
    body: { shareCode: code, otp },
  }).catch(() => null);
  if (!res) return { ok: false, error: "Cannot reach the SafePrint server." };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || `Verification failed (${res.status}).` };

  state.viewerToken = data.viewerToken;
  state.finished = false;
  // Everything except the token is safe for the renderer.
  return {
    ok: true,
    fileName: data.fileName,
    mimeType: data.mimeType,
    expiresAt: data.expiresAt,
    printAttemptsLeft: data.printAttemptsLeft,
  };
});

ipcMain.handle("fetch-doc", async () => {
  if (!state.viewerToken) return { ok: false, error: "No active session." };
  const res = await api("/api/render", { auth: true }).catch(() => null);
  if (!res || !res.ok) return { ok: false, error: "Could not load the document." };
  const buf = Buffer.from(await res.arrayBuffer());
  // Structured clone delivers this as an ArrayBuffer to the renderer.
  return { ok: true, bytes: buf, mimeType: res.headers.get("content-type") || "" };
});

ipcMain.handle("list-printers", async (e) => {
  const printers = await e.sender.getPrintersAsync();
  return splitPrinters(printers);
});

ipcMain.handle("print", async (e, { printerName }) => {
  if (!state.viewerToken) return { ok: false, error: "No active session." };

  // Re-validate against the CURRENT printer list — the renderer's choice is
  // untrusted input; a spoofed name must still be a known physical device.
  const { physical } = splitPrinters(await e.sender.getPrintersAsync());
  if (!physical.some((p) => p.name === printerName)) {
    return { ok: false, error: "Selected printer is not an approved physical printer." };
  }

  const attempt = await api("/api/print-attempt", { method: "POST", auth: true }).catch(() => null);
  if (!attempt) return { ok: false, error: "Cannot reach the SafePrint server." };
  const attemptData = await attempt.json().catch(() => ({}));
  if (!attempt.ok) return { ok: false, error: attemptData.error || "Print not allowed." };

  const printed = await new Promise((resolve) => {
    // silent + deviceName = job goes straight to the spooler for that
    // device. The OS print dialog — and its Save-as-PDF — never opens.
    e.sender.print(
      { silent: true, deviceName: printerName, printBackground: true },
      (success, failureReason) => resolve({ success, failureReason })
    );
  });

  if (!printed.success) {
    return {
      ok: false,
      attemptsLeft: attemptData.attemptsLeft,
      error: `Print failed: ${printed.failureReason || "unknown error"}.`,
    };
  }
  return { ok: true, attemptsLeft: attemptData.attemptsLeft };
});

ipcMain.handle("confirm-print", async () => {
  const res = await api("/api/confirm-print", { method: "POST", auth: true }).catch(() => null);
  if (!res || !res.ok) return { ok: false, error: "Could not confirm the print." };
  state.finished = true;
  state.viewerToken = null;
  return { ok: true };
});

ipcMain.handle("close-session", async () => {
  await closeSessionBeacon();
  return { ok: true };
});

ipcMain.on("selftest-report", (_e, report) => {
  console.log("SELFTEST_RESULT " + JSON.stringify(report));
  app.exit(report.ok ? 0 : 1);
});

// ---------------------------------------------------------------------------
// App window
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: "safeprint-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    show: false,
    backgroundColor: "#f1e8d3",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });

  // Exclude the document window from screenshots / screen sharing
  // (Windows + macOS; no-op on Linux).
  win.setContentProtection(true);

  // Kill Ctrl/Cmd + P/S/C/X/A and PrintScreen inside the window.
  win.webContents.on("before-input-event", (event, input) => {
    const k = (input.key || "").toLowerCase();
    if ((input.control || input.meta) && ["p", "s", "c", "x", "a", "u"].includes(k)) {
      event.preventDefault();
    }
    if (k === "printscreen") event.preventDefault();
  });

  // No navigation, no popups, no permissions — the app is a single page.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.loadURL("safeprint-app://app/index.html");
  if (!SELFTEST) win.once("ready-to-show", () => win.show());
  return win;
}

app.whenReady().then(() => {
  protocol.handle("safeprint-app", (request) => {
    const url = new URL(request.url);
    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
    const file = path.join(__dirname, "renderer", rel);
    // Never serve outside the renderer directory.
    if (!file.startsWith(path.join(__dirname, "renderer"))) {
      return new Response("forbidden", { status: 403 });
    }
    const types = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
    };
    try {
      const body = fs.readFileSync(file);
      return new Response(body, {
        headers: { "Content-Type": types[path.extname(file)] || "application/octet-stream" },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  createWindow();
});

app.on("window-all-closed", async () => {
  await closeSessionBeacon();
  app.quit();
});

app.on("before-quit", () => {
  // fire-and-forget: destroy the server-side file if the shop just quits
  void closeSessionBeacon();
});
