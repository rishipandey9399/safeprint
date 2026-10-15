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
 *  - Decrypted bytes live only in memory; nothing is written to disk. The
 *    only file the agent writes is its counter identity (userData/counter.json:
 *    server URL, shop code, device key) — never document data.
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
// The selftest registers a throwaway counter — keep it away from a real
// counter.json by giving the run its own userData directory.
if (SELFTEST) {
  app.setPath("userData", path.join(require("os").tmpdir(), `safeprint-selftest-${process.pid}`));
}
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

// ---------------------------------------------------------------------------
// Counter identity: a registered shop's device key. Lives only in the main
// process (and userData/counter.json); the renderer sees name + code only.
// ---------------------------------------------------------------------------
let counter = null; // { server, deviceKey, shopCode, name, area }

function counterFile() {
  return path.join(app.getPath("userData"), "counter.json");
}
// Why a saved counter couldn't be used (shown on the setup screen).
let counterNotice = "";

function loadCounter() {
  try {
    const c = JSON.parse(fs.readFileSync(counterFile(), "utf8"));
    if (c && c.server && !parseServer(c.server)) {
      counterNotice =
        `This counter was set up with an insecure address (${c.server}). ` +
        "Set it up again with the server's https:// address.";
      return null;
    }
    if (c && parseServer(c.server) && /^[a-f0-9]{64}$/.test(c.deviceKey) && c.shopCode) return c;
  } catch {
    /* not registered yet */
  }
  return null;
}
function saveCounter(c) {
  counterNotice = "";
  if (c) fs.writeFileSync(counterFile(), JSON.stringify(c), { mode: 0o600 });
  else fs.rmSync(counterFile(), { force: true });
  counter = c;
}

async function publicCounterInfo() {
  if (!counter) return { registered: false, notice: counterNotice };
  const pairUrl = `${counter.server}/?shop=${counter.shopCode}`;
  const qrSvg = await QRCode.toString(pairUrl, {
    type: "svg",
    margin: 1,
    color: { dark: "#26211a", light: "#fffdf7" },
  }).catch(() => "");
  return {
    registered: true,
    server: counter.server,
    shopCode: counter.shopCode,
    name: counter.name,
    area: counter.area,
    pairUrl,
    qrSvg,
  };
}

// The device key, viewer token and document bytes travel to this server, so
// it must be HTTPS. Plain HTTP is allowed only for a server on this machine.
function parseServer(server) {
  try {
    const url = new URL(server);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function api(pathname, { method = "GET", body, auth = false } = {}) {
  const headers = { ...CLIENT_HEADER };
  if (auth) headers.Authorization = `Bearer ${state.viewerToken}`;
  // Paired sessions only open from the counter they were paired with.
  if (counter && counter.server === state.serverUrl) headers["X-SafePrint-Shop-Key"] = counter.deviceKey;
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
const QRCode = require("qrcode");

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

ipcMain.handle("counter-info", () => publicCounterInfo());

ipcMain.handle("register-counter", async (_e, { server, name, area }) => {
  const base = parseServer(server);
  if (!base) return { ok: false, error: "Enter the server's https:// address (e.g. https://safeprint.example.com)." };
  const res = await fetch(new URL("/api/shops/register", base), {
    method: "POST",
    headers: { ...CLIENT_HEADER, "Content-Type": "application/json" },
    body: JSON.stringify({ name, area }),
  }).catch(() => null);
  if (!res) return { ok: false, error: "Cannot reach the SafePrint server." };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || `Setup failed (${res.status}).` };
  saveCounter({ server: base, deviceKey: data.deviceKey, shopCode: data.shopCode, name: data.name, area: data.area });
  return { ok: true, ...(await publicCounterInfo()) };
});

ipcMain.handle("forget-counter", () => {
  saveCounter(null);
  return { ok: true };
});

ipcMain.handle("jobs", async () => {
  if (!counter) return { ok: false, error: "Counter not set up." };
  const res = await fetch(new URL("/api/shops/jobs", counter.server), {
    headers: { ...CLIENT_HEADER, "X-SafePrint-Shop-Key": counter.deviceKey },
  }).catch(() => null);
  if (!res) return { ok: false, error: "Cannot reach the SafePrint server — retrying…" };
  if (res.status === 401) {
    saveCounter(null);
    return { ok: false, unregistered: true, error: "This counter is no longer registered. Set it up again." };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error || `Could not load jobs (${res.status}).` };
  // Share codes + file names only; nothing secret crosses to the renderer.
  return { ok: true, jobs: data.jobs };
});

// Waits (in the main process, token never leaves) for the customer's Allow.
ipcMain.handle("await-approval", async () => {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (state.viewerToken && Date.now() < deadline) {
    const res = await api("/api/approval-status", { auth: true }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (data.state === "approved") {
      return {
        ok: true,
        fileName: data.fileName,
        mimeType: data.mimeType,
        expiresAt: data.expiresAt,
        printAttemptsLeft: data.printAttemptsLeft,
      };
    }
    if (data.state === "denied") {
      state.viewerToken = null;
      return {
        ok: false,
        error: "The customer did not allow access (denied or timed out). Ask them for a new OTP.",
      };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  state.viewerToken = null;
  return { ok: false, error: "Stopped waiting for the customer." };
});

ipcMain.handle("cancel-approval", () => {
  // Dropping the token is enough: it is useless until approved, and an
  // unanswered request times out server-side.
  state.viewerToken = null;
  return { ok: true };
});

ipcMain.handle("verify", async (_e, { server, code, otp }) => {
  const base = counter && !server ? counter.server : parseServer(server);
  if (!base) {
    return { ok: false, error: "Enter the server's https:// address (e.g. https://safeprint.example.com)." };
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
  if (data.pendingApproval) {
    return { ok: true, pendingApproval: true, shopName: data.shopName || null };
  }
  // Everything except the token is safe for the renderer.
  return {
    ok: true,
    pendingApproval: false,
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

const PRINT_PAPERS = new Set(["A4", "Letter", "Legal"]);

ipcMain.handle("print", async (e, { printerName, layout, pageMm, paper, landscape }) => {
  if (!state.viewerToken) return { ok: false, error: "No active session." };

  // Re-validate against the CURRENT printer list — the renderer's choice is
  // untrusted input; a spoofed name must still be a known physical device.
  const { physical } = splitPrinters(await e.sender.getPrintersAsync());
  if (!physical.some((p) => p.name === printerName)) {
    return { ok: false, error: "Selected printer is not an approved physical printer." };
  }

  // Layout is logged server-side (the server re-validates it); the paper
  // size and orientation become the silent print job's page setup.
  const body = Array.isArray(layout) && layout.length <= 500 ? { layout, pageMm } : undefined;
  const attempt = await api("/api/print-attempt", { method: "POST", auth: true, body }).catch(() => null);
  if (!attempt) return { ok: false, error: "Cannot reach the SafePrint server." };
  const attemptData = await attempt.json().catch(() => ({}));
  if (!attempt.ok) return { ok: false, error: attemptData.error || "Print not allowed." };

  const printed = await new Promise((resolve) => {
    // silent + deviceName = job goes straight to the spooler for that
    // device. The OS print dialog — and its Save-as-PDF — never opens.
    e.sender.print(
      {
        silent: true,
        deviceName: printerName,
        printBackground: true,
        // One sheet orientation per job; the renderer turns pages that run
        // the other way, so they print full-size instead of shrunk.
        landscape: landscape === true,
        ...(PRINT_PAPERS.has(paper) ? { pageSize: paper, margins: { marginType: "none" } } : {}),
      },
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
  counter = loadCounter();
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
