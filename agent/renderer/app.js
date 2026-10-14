/**
 * SafePrint Agent renderer. Runs sandboxed: no Node, no network — every
 * privileged operation goes through the `agent` bridge (see preload.cjs),
 * and the session token never enters this process.
 */
import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);
const screens = {
  setup: $("setup-screen"),
  counter: $("counter-screen"),
  waiting: $("waiting-screen"),
  connect: $("connect-screen"),
  viewer: $("viewer-screen"),
  done: $("done-screen"),
};

let attemptsLeft = 2;
let counterInfo = { registered: false };
let selectedJob = null;
let jobsTimer = null;

function show(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  if (name === "counter") startJobsPolling();
  else stopJobsPolling();
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message || "";
  el.hidden = !message;
}

// ---------------------------------------------------------------------------
// Counter: QR, job queue, OTP-only entry
// ---------------------------------------------------------------------------
function renderCounter() {
  $("counter-name").textContent = counterInfo.name;
  $("counter-area").textContent = counterInfo.area || "";
  $("counter-code").textContent = counterInfo.shopCode;
  const qr = $("counter-qr");
  qr.textContent = "";
  // SVG text comes from our own main process (qrcode lib), parsed — not
  // innerHTML'd — and only the <svg> element is adopted.
  const svg = new DOMParser().parseFromString(counterInfo.qrSvg || "", "image/svg+xml").documentElement;
  if (svg && svg.nodeName === "svg") qr.appendChild(document.importNode(svg, true));
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderJobs(jobs) {
  const list = $("job-list");
  list.textContent = "";
  $("jobs-empty").hidden = jobs.length > 0;
  if (selectedJob && !jobs.some((j) => j.shareCode === selectedJob)) selectedJob = null;
  for (const job of jobs) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "job" + (job.shareCode === selectedJob ? " selected" : "");
    const name = document.createElement("span");
    name.className = "job-name";
    name.textContent = job.fileName;
    const meta = document.createElement("span");
    meta.className = "job-meta";
    meta.textContent =
      `${timeOf(job.createdAt)} · SP·${job.shareCode}` +
      (job.status === "awaiting_approval" ? " · waiting for customer" : "");
    btn.append(name, meta);
    btn.addEventListener("click", () => {
      selectedJob = job.shareCode;
      $("job-otp-input").value = "";
      renderJobs(jobs);
      $("job-otp-input").focus();
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  $("job-otp").hidden = !selectedJob;
}

async function loadJobs() {
  const result = await window.agent.jobs();
  if (result.unregistered) {
    counterInfo = { registered: false };
    showError("setup-error", result.error);
    show("setup");
    return;
  }
  if (!result.ok) {
    showError("jobs-error", result.error);
  } else {
    showError("jobs-error", "");
    renderJobs(result.jobs);
  }
  if (!screens.counter.hidden) jobsTimer = setTimeout(loadJobs, 3000);
}

function startJobsPolling() {
  stopJobsPolling();
  void loadJobs();
}
function stopJobsPolling() {
  if (jobsTimer) clearTimeout(jobsTimer);
  jobsTimer = null;
}

function home() {
  show(counterInfo.registered ? "counter" : "connect");
}

// ---------------------------------------------------------------------------
// Lockdown: same posture as the web viewer, even though the agent window
// already blocks capture at the OS level.
// ---------------------------------------------------------------------------
for (const evt of ["contextmenu", "dragstart", "copy", "cut"]) {
  document.addEventListener(evt, (e) => e.preventDefault());
}

// ---------------------------------------------------------------------------
// Document rendering.
// No watermark: the agent prints straight to a physical printer with no
// Save-as-PDF path, so copies can't escape the print step — the browser
// portal, which can't control the print dialog, keeps the watermark instead.
// ---------------------------------------------------------------------------
async function renderDocument(bytes, mimeType) {
  const stack = $("stack");
  stack.textContent = "";

  if (mimeType.includes("pdf")) {
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      stack.appendChild(canvas);
    }
  } else {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    bitmap.close();
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
  $("printer-note").textContent = note + " · this print is logged to the session audit trail.";
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
  let result = await window.agent.verify({ server, code, otp });
  if (!result.ok) return result;

  if (result.pendingApproval) {
    $("waiting-note").textContent =
      `Their phone shows “${result.shopName || "A shop"} wants to open your document”.`;
    show("waiting");
    result = await window.agent.awaitApproval();
    if (!result.ok) return result;
  }

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
  showError("connect-error", "");
  $("verify-btn").disabled = true;
  try {
    const result = await verifyAndOpen($("server").value.trim(), $("code").value.trim(), $("otp").value.trim());
    if (!result.ok) {
      show("connect");
      showError("connect-error", result.error);
    }
  } finally {
    $("verify-btn").disabled = false;
  }
});

$("job-open-btn").addEventListener("click", async () => {
  if (!selectedJob) return;
  showError("counter-error", "");
  $("job-open-btn").disabled = true;
  try {
    const result = await verifyAndOpen("", selectedJob, $("job-otp-input").value.trim());
    if (!result.ok) {
      show("counter");
      showError("counter-error", result.error);
    }
  } finally {
    $("job-open-btn").disabled = false;
  }
});
$("job-otp-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("job-open-btn").click();
});

$("setup-btn").addEventListener("click", async () => {
  showError("setup-error", "");
  $("setup-btn").disabled = true;
  try {
    const result = await window.agent.registerCounter({
      server: $("setup-server").value.trim(),
      name: $("setup-name").value.trim(),
      area: $("setup-area").value.trim(),
    });
    if (!result.ok) {
      showError("setup-error", result.error);
      return;
    }
    counterInfo = result;
    renderCounter();
    show("counter");
  } finally {
    $("setup-btn").disabled = false;
  }
});

$("setup-skip").addEventListener("click", () => show("connect"));
$("manual-btn").addEventListener("click", () => {
  $("server").value = counterInfo.server || $("server").value;
  show("connect");
});
$("connect-back").addEventListener("click", () => show(counterInfo.registered ? "counter" : "setup"));
$("forget-btn").addEventListener("click", async () => {
  await window.agent.forgetCounter();
  counterInfo = { registered: false };
  show("setup");
});
$("waiting-cancel").addEventListener("click", () => window.agent.cancelApproval());

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
  selectedJob = null;
  home();
});

// ---------------------------------------------------------------------------
// Selftest: drive the full flow headlessly and report machine-readable state.
// ---------------------------------------------------------------------------
(async () => {
  const cfg = await window.agent.launchConfig();
  if (cfg.server) {
    $("server").value = cfg.server;
    $("setup-server").value = cfg.server;
  }
  if (cfg.selftest) {
    show("connect");
  } else {
    counterInfo = await window.agent.counterInfo();
    if (counterInfo.registered) {
      renderCounter();
      show("counter");
    } else {
      show("setup");
    }
    return;
  }

  const report = { ok: false, steps: {} };
  try {
    // Regression check: the confirm modal must be invisible until a print
    // happens. A class display rule once overrode [hidden] and the dead
    // modal blocked the whole UI from launch.
    const modalDisplay = getComputedStyle($("confirm-modal")).display;
    report.steps.modalHiddenAtLaunch =
      modalDisplay === "none" ? "pass" : `FAIL — computed display: ${modalDisplay}`;

    const result = await verifyAndOpen(cfg.server, cfg.code, cfg.otp);
    report.steps.verify = result.ok ? "pass" : `fail: ${result.error}`;
    if (!result.ok) throw new Error(result.error);

    const canvases = document.querySelectorAll("#stack canvas");
    report.steps.render = canvases.length > 0 ? `pass (${canvases.length} page canvas)` : "fail";

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

    // Counter pairing: register, QR, job queue, forget.
    const reg = await window.agent.registerCounter({ server: cfg.server, name: "Selftest Counter", area: "" });
    report.steps.counterRegister =
      reg.ok && /^[A-Z2-9]{6}$/.test(reg.shopCode) ? "pass" : `fail: ${reg.error || "bad shop code"}`;
    report.steps.counterQr = (reg.qrSvg || "").includes("<svg") ? "pass" : "fail";
    const jobs = await window.agent.jobs();
    report.steps.counterJobs = jobs.ok && Array.isArray(jobs.jobs) ? "pass" : `fail: ${jobs.error}`;
    await window.agent.forgetCounter();
    report.steps.counterForget = (await window.agent.counterInfo()).registered ? "fail" : "pass";

    report.ok =
      report.steps.modalHiddenAtLaunch === "pass" &&
      report.steps.render.startsWith("pass") &&
      report.steps.spoofRejected === "pass" &&
      ["counterRegister", "counterQr", "counterJobs", "counterForget"].every((k) => report.steps[k] === "pass");
  } catch (err) {
    report.error = String(err && err.message ? err.message : err);
  }
  window.agent.selftestReport(report);
})();
