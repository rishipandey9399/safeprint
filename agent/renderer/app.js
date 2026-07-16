/**
 * SafePrint Agent renderer. Runs sandboxed: no Node, no network — every
 * privileged operation goes through the `agent` bridge (see preload.cjs),
 * and the session token never enters this process.
 */
import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const screens = { connect: $("connect-screen"), viewer: $("viewer-screen"), done: $("done-screen") };

let shareCode = "";
let attemptsLeft = 2;

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

// ---------------------------------------------------------------------------
// Lockdown: same posture as the web viewer, even though the agent window
// already blocks capture at the OS level.
// ---------------------------------------------------------------------------
for (const evt of ["contextmenu", "dragstart", "copy", "cut"]) {
  document.addEventListener(evt, (e) => e.preventDefault());
}

// ---------------------------------------------------------------------------
// Watermark — identical construction to the web viewer, so any copy that
// somehow escapes (photo of the screen, paper) stays session-traceable.
// ---------------------------------------------------------------------------
function applyWatermark(canvas, label, footer) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  ctx.save();
  const fontSize = Math.max(18, Math.round(w / 26));
  ctx.font = `700 ${fontSize}px "Courier New", monospace`;
  ctx.fillStyle = "rgba(178, 62, 29, 0.13)";
  ctx.textAlign = "center";
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 6);
  const stepX = ctx.measureText(label).width + fontSize * 3;
  const stepY = fontSize * 5;
  let row = 0;
  for (let y = -h; y < h; y += stepY, row++) {
    const offset = (row % 2) * (stepX / 2);
    for (let x = -w - offset; x < w; x += stepX) {
      ctx.fillText(label, x + offset, y);
    }
  }
  ctx.restore();

  ctx.save();
  const footSize = Math.max(11, Math.round(w / 72));
  ctx.font = `${footSize}px "Courier New", monospace`;
  ctx.fillStyle = "rgba(38, 33, 26, 0.78)";
  ctx.textAlign = "center";
  ctx.fillText(footer, w / 2, h - footSize * 0.9);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Document rendering
// ---------------------------------------------------------------------------
async function renderDocument(bytes, mimeType) {
  const stack = $("stack");
  stack.textContent = "";

  const label = `SAFEPRINT · SP-${shareCode} · AGENT`;
  const footer = `Printed via SafePrint Agent · SP-${shareCode} · ${new Date().toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  })} · single authorised copy — duplication prohibited`;

  if (mimeType.includes("pdf")) {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      applyWatermark(canvas, label, footer);
      stack.appendChild(canvas);
    }
  } else {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
    applyWatermark(canvas, label, footer);
    stack.appendChild(canvas);
  }
}

function wipeCanvases() {
  for (const c of document.querySelectorAll("#stack canvas")) {
    c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    c.remove();
  }
}

async function refreshPrinters() {
  const { physical, filtered } = await window.agent.listPrinters();
  const select = $("printer-select");
  select.textContent = "";
  for (const p of physical) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.displayName;
    select.appendChild(opt);
  }
  $("print-btn").disabled = physical.length === 0;
  const note =
    physical.length === 0
      ? "No physical printer found. Connect a printer — virtual destinations (Save as PDF, XPS…) are not allowed."
      : `${physical.length} physical printer(s) available` +
        (filtered.length ? ` · ${filtered.length} virtual destination(s) blocked` : "");
  $("printer-note").textContent =
    note + ` · every copy carries the watermark SP-${shareCode} and is logged.`;
  return { physical, filtered };
}

function finish(kind, message) {
  wipeCanvases();
  $("done-stamp").className = `stamp ${kind}`;
  $("done-stamp").textContent = kind === "printed" ? "PRINTED · COPY DESTROYED" : "SESSION CLOSED";
  $("done-title").textContent = kind === "printed" ? "Printed & destroyed" : "Session closed";
  $("done-message").textContent = message;
  show("done");
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------
async function verifyAndOpen(server, code, otp) {
  const result = await window.agent.verify({ server, code, otp });
  if (!result.ok) return result;

  shareCode = code.toUpperCase();
  attemptsLeft = result.printAttemptsLeft;
  $("doc-name").textContent = result.fileName;
  $("attempts-note").textContent = `Physical print only · ${attemptsLeft} print(s) left`;

  const doc = await window.agent.fetchDoc();
  if (!doc.ok) return doc;

  show("viewer");
  await renderDocument(doc.bytes, doc.mimeType || result.mimeType);
  await refreshPrinters();
  return { ok: true };
}

$("verify-btn").addEventListener("click", async () => {
  const err = $("connect-error");
  err.hidden = true;
  $("verify-btn").disabled = true;
  try {
    const result = await verifyAndOpen($("server").value.trim(), $("code").value.trim(), $("otp").value.trim());
    if (!result.ok) {
      err.textContent = result.error;
      err.hidden = false;
    }
  } finally {
    $("verify-btn").disabled = false;
  }
});

$("print-btn").addEventListener("click", async () => {
  const verr = $("viewer-error");
  verr.hidden = true;
  $("print-btn").disabled = true;
  try {
    const result = await window.agent.print({ printerName: $("printer-select").value });
    if (!result.ok) {
      verr.textContent = result.error;
      verr.hidden = false;
      if (typeof result.attemptsLeft === "number") attemptsLeft = result.attemptsLeft;
      return;
    }
    attemptsLeft = result.attemptsLeft;
    $("attempts-note").textContent = `Physical print only · ${attemptsLeft} print(s) left`;
    $("confirm-hint").textContent =
      `Confirming permanently deletes the customer's file. ${attemptsLeft} attempt(s) left if it failed.`;
    $("confirm-modal").hidden = false;
  } finally {
    $("print-btn").disabled = false;
  }
});

$("confirm-yes").addEventListener("click", async () => {
  $("confirm-modal").hidden = true;
  const result = await window.agent.confirmPrint();
  if (result.ok) {
    finish("printed", "The document was printed and has been permanently deleted from SafePrint.");
  } else {
    const verr = $("viewer-error");
    verr.textContent = result.error;
    verr.hidden = false;
  }
});

$("confirm-no").addEventListener("click", async () => {
  $("confirm-modal").hidden = true;
  if (attemptsLeft <= 0) {
    await window.agent.closeSession();
    finish("ended", "Print attempts exhausted. The session is closed and the file deleted.");
  }
});

$("close-btn").addEventListener("click", async () => {
  await window.agent.closeSession();
  finish("ended", "Session closed. The customer's file has been permanently deleted.");
});

$("again-btn").addEventListener("click", () => {
  $("code").value = "";
  $("otp").value = "";
  show("connect");
});

// ---------------------------------------------------------------------------
// Selftest: drive the full flow headlessly and report machine-readable state.
// ---------------------------------------------------------------------------
(async () => {
  const cfg = await window.agent.launchConfig();
  if (cfg.server) $("server").value = cfg.server;
  if (!cfg.selftest) return;

  const report = { ok: false, steps: {} };
  try {
    const result = await verifyAndOpen(cfg.server, cfg.code, cfg.otp);
    report.steps.verify = result.ok ? "pass" : `fail: ${result.error}`;
    if (!result.ok) throw new Error(result.error);

    const canvases = document.querySelectorAll("#stack canvas");
    report.steps.render = canvases.length > 0 ? `pass (${canvases.length} page canvas)` : "fail";

    // Prove the watermark is baked into the printable pixels.
    const c = canvases[0];
    const ctx = c.getContext("2d");
    const mid = ctx.getImageData(0, Math.floor(c.height / 2) - 50, c.width, 100).data;
    let tinted = 0;
    for (let i = 0; i < mid.length; i += 4) {
      if (mid[i] > 220 && mid[i + 2] < 235 && mid[i] - mid[i + 2] > 12) tinted++;
    }
    report.steps.watermark = tinted > 500 ? `pass (${tinted} tinted px)` : `fail (${tinted})`;

    const { physical, filtered } = await refreshPrinters();
    report.steps.printers = {
      physical: physical.map((p) => p.name),
      blockedVirtual: filtered.map((p) => p.name),
    };

    // Spoofed-printer guard: a virtual/unknown device must be rejected.
    const spoof = await window.agent.print({ printerName: "Microsoft Print to PDF" });
    report.steps.spoofRejected = spoof.ok === false ? "pass" : "FAIL — virtual printer accepted";

    await window.agent.closeSession();
    report.steps.sessionClose = "pass";
    report.ok =
      report.steps.render.startsWith("pass") &&
      report.steps.watermark.startsWith("pass") &&
      report.steps.spoofRejected === "pass";
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }
  window.agent.selftestReport(report);
})();
