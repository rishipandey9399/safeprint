"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import RubberStamp from "./RubberStamp";
import { renderPages, wipe, type RenderedPage } from "@/lib/pdfRender";
import {
  composePage,
  defaultAdjust,
  isDefault,
  isOffPaper,
  MAX_SCALE,
  rotatedSize,
  type Adjust,
  type Paper,
} from "@/lib/pageAdjust";
import type { EditedPage } from "./ImageEditor";

// Editors load only when a customer has allowed an edit.
const ImageEditor = dynamic(() => import("./ImageEditor"), { ssr: false });
const WordEditor = dynamic(() => import("./WordEditor"), { ssr: false });

export interface VerifiedSession {
  viewerToken: string;
  fileName: string;
  mimeType: string;
  expiresAt: string;
  printAttemptsLeft: number;
  wordEditable?: boolean;
  editRoundsLeft?: number;
}

interface Props {
  session: VerifiedSession;
  /** Session share code — baked into the watermark so any copy is traceable. */
  shareCode: string;
  onEnded: (outcome: "printed" | "ended", message: string) => void;
}

type EditStatus = "none" | "requested" | "editing" | "pending_review";
type EditOutcome = "approved" | "rejected" | "denied" | "timeout" | "cancelled" | null;
interface EditInfo {
  editStatus: EditStatus;
  editKind: "word" | "image" | null;
  editLastOutcome: EditOutcome;
  editRoundsLeft: number;
  wordEditable: boolean;
  editRequestExpiresAt: string | null;
  onlyofficeUrl?: string;
  editor?: object;
}
// What the shop's screen is doing about editing.
type EditPhase = null | "choose" | "requesting" | "image" | "word" | "saving" | "review";

const OUTCOME_TEXT: Record<Exclude<EditOutcome, null>, string> = {
  approved: "The customer approved the edit — this is the version that will print.",
  rejected: "The customer rejected the edit — the earlier version will print.",
  denied: "The customer declined editing.",
  timeout: "The customer didn't answer in time — ask them to watch their phone and try again.",
  cancelled: "Edit discarded.",
};

const PAPERS: { value: Paper; label: string }[] = [
  { value: "auto", label: "Original size" },
  { value: "A4", label: "A4" },
  { value: "Letter", label: "Letter" },
  { value: "Legal", label: "Legal" },
];

/**
 * The native print dialog's "Save as PDF" destination cannot be removed by a
 * web page, so instead every canvas pixel carries a session-coded watermark:
 * a faint diagonal tile across the document plus a footer line. Whatever
 * leaves the dialog — paper or PDF — is a marked, traceable copy rather than
 * a clean original, and the print attempt is already in the audit log.
 */
function applyWatermark(canvas: HTMLCanvasElement, label: string, footer: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;

  // Diagonal tiled label, light enough to keep the document readable.
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

  // Footer strip: solid, small, inside the bottom margin.
  ctx.save();
  const footSize = Math.max(11, Math.round(w / 72));
  ctx.font = `${footSize}px "Courier New", monospace`;
  ctx.fillStyle = "rgba(38, 33, 26, 0.78)";
  ctx.textAlign = "center";
  ctx.fillText(footer, w / 2, h - footSize * 0.9);
  ctx.restore();
}

/**
 * View-only document surface. Everything is drawn onto <canvas> from bytes
 * fetched with the Authorization header — there is never a URL, <img src>,
 * <embed>, or blob link in the DOM that "Save as", right-click, or the
 * browser cache could capture. Right-click, copy, drag, Ctrl+S/P/C are
 * disabled while mounted.
 *
 * Layout (turn, move, scale, paper, skip, B&W) is applied here and only
 * changes how pages sit on paper. Editing what a page says needs the
 * customer's Allow first and their approval of the result after.
 */
export default function LockedViewer({ session, shareCode, onEnded }: Props) {
  const stackRef = useRef<HTMLDivElement>(null);
  const pristineRef = useRef<RenderedPage[]>([]);
  const composedRef = useRef<HTMLCanvasElement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attemptsLeft, setAttemptsLeft] = useState(session.printAttemptsLeft);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [layout, setLayout] = useState<Adjust[]>([]);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [layoutTarget, setLayoutTarget] = useState<"all" | number>("all");
  const [editPhase, setEditPhase] = useState<EditPhase>(null);
  const [editInfo, setEditInfo] = useState<EditInfo>({
    editStatus: "none",
    editKind: null,
    editLastOutcome: null,
    editRoundsLeft: session.editRoundsLeft ?? 0,
    wordEditable: !!session.wordEditable,
    editRequestExpiresAt: null,
  });
  const [wordEditor, setWordEditor] = useState<{ url: string; config: object } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const endedRef = useRef(false);
  const initRef = useRef(false);
  const savingSinceRef = useRef(0);

  const auth = { Authorization: `Bearer ${session.viewerToken}` };

  const beaconClose = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    navigator.sendBeacon(
      "/api/session-close",
      new Blob([JSON.stringify({ viewerToken: session.viewerToken })], { type: "application/json" })
    );
  }, [session.viewerToken]);

  // ---------------------------------------------------------------------------
  // Fetch + render (again after an approved edit)
  // ---------------------------------------------------------------------------

  const loadDocument = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/render", {
        headers: { Authorization: `Bearer ${session.viewerToken}` },
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not load document.");
      }
      const buf = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") ?? session.mimeType;
      const pages = await renderPages(buf, contentType.split(";")[0]);
      wipe(pristineRef.current.map((p) => p.canvas));
      pristineRef.current = pages;
      setLayout(pages.map(() => defaultAdjust()));
      setLayoutTarget("all");
      setPageCount(pages.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load document.");
    } finally {
      setLoading(false);
    }
  }, [session.viewerToken, session.mimeType]);

  useEffect(() => {
    if (initRef.current) return; // guard React strict-mode double mount
    initRef.current = true;
    void loadDocument();
  }, [loadDocument]);

  // Compose every page with its layout, stamp it, and show it.
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack || loading || pageCount === 0 || layout.length !== pageCount) return;
    const stampLabel = `SAFEPRINT · SP-${shareCode}`;
    const stampFooter = `Printed via SafePrint · SP-${shareCode} · ${new Date().toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    })} · single authorised copy — duplication prohibited`;

    const next = pristineRef.current.map((p, i) => {
      const adj = layout[i];
      const c = isDefault(adj)
        ? (() => {
            const copy = document.createElement("canvas");
            copy.width = p.canvas.width;
            copy.height = p.canvas.height;
            copy.getContext("2d")!.drawImage(p.canvas, 0, 0);
            return copy;
          })()
        : composePage(p.canvas, [p.widthMm, p.heightMm], adj, document);
      applyWatermark(c, stampLabel, stampFooter);
      if (!adj.include) c.classList.add("no-print");
      c.setAttribute("aria-label", `Page ${i + 1}${adj.include ? "" : " (skipped)"}`);
      return c;
    });
    wipe(composedRef.current);
    composedRef.current = next;
    next.forEach((c) => stack.appendChild(c));
  }, [layout, loading, pageCount, shareCode]);

  // Lock down the page while the viewer is mounted.
  useEffect(() => {
    const block = (e: Event) => e.preventDefault();
    const keydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ["s", "p", "c", "x", "u", "a"].includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key.toLowerCase() === "p") {
          setNotice("Use the Print button below — it is the only allowed print path.");
        } else {
          setNotice("Saving and copying are disabled in SafePrint.");
        }
      }
    };
    document.addEventListener("contextmenu", block);
    document.addEventListener("dragstart", block);
    document.addEventListener("copy", block);
    document.addEventListener("cut", block);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("pagehide", beaconClose);
    return () => {
      document.removeEventListener("contextmenu", block);
      document.removeEventListener("dragstart", block);
      document.removeEventListener("copy", block);
      document.removeEventListener("cut", block);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("pagehide", beaconClose);
    };
  }, [beaconClose]);

  const wipeCanvases = () => {
    wipe(composedRef.current);
    composedRef.current = [];
    wipe(pristineRef.current.map((p) => p.canvas));
    pristineRef.current = [];
  };

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  const targets = (i: number) => layoutTarget === "all" || layoutTarget === i;

  const updateLayout = (fn: (a: Adjust) => Partial<Adjust>) =>
    setLayout((cur) => cur.map((a, i) => (targets(i) ? { ...a, ...fn(a) } : a)));

  const shown: Adjust = layout[layoutTarget === "all" ? 0 : layoutTarget] ?? defaultAdjust();
  const paper = layout[0]?.paper ?? "auto";
  const included = layout.filter((a) => a.include).length;
  const layoutChanged = layout.some((a) => !isDefault(a));
  const pageMm = (): [number, number][] => pristineRef.current.map((p) => [p.widthMm, p.heightMm]);
  const offPaper = layout.flatMap((a, i) => {
    const p = pristineRef.current[i];
    return p && a.include && isOffPaper([p.widthMm, p.heightMm], a) ? [i + 1] : [];
  });

  const nudge = (dx: number, dy: number) =>
    updateLayout((a) => ({
      offsetXmm: Math.max(-40, Math.min(40, a.offsetXmm + dx)),
      offsetYmm: Math.max(-40, Math.min(40, a.offsetYmm + dy)),
    }));

  // Paper is one setting for the whole document (one @page rule).
  const setPaper = (p: Paper) => setLayout((cur) => cur.map((a) => ({ ...a, paper: p })));

  // Orientation for the @page rule: from the first page that will print.
  const firstIncluded = layout.findIndex((a) => a.include);
  const firstPage = pristineRef.current[firstIncluded];
  const landscape =
    !!firstPage &&
    (() => {
      const [w, h] = rotatedSize(firstPage.widthMm, firstPage.heightMm, layout[firstIncluded].rotate);
      return w > h;
    })();

  // ---------------------------------------------------------------------------
  // Print
  // ---------------------------------------------------------------------------

  const handlePrint = async () => {
    setNotice("");
    if (included === 0) {
      setNotice("Every page is set to skip — include at least one page.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/print-attempt", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ layout, pageMm: pageMm() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 403) setAttemptsLeft(0);
        setNotice(data.error ?? "Print not allowed.");
        return;
      }
      setAttemptsLeft(data.attemptsLeft);
      // Give the browser a beat to settle, then open the native print dialog.
      setTimeout(() => {
        window.print();
        setConfirmOpen(true); // afterprint isn't reliable everywhere; ask explicitly
      }, 100);
    } finally {
      setBusy(false);
    }
  };

  const confirmPrinted = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/confirm-print", { method: "POST", headers: auth });
      if (res.ok) {
        endedRef.current = true;
        wipeCanvases();
        onEnded("printed", "Document printed. The file has been permanently deleted.");
      } else {
        const data = await res.json().catch(() => ({}));
        setNotice(data.error ?? "Could not confirm print.");
      }
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const printFailed = () => {
    setConfirmOpen(false);
    if (attemptsLeft <= 0) {
      beaconClose();
      wipeCanvases();
      onEnded("ended", "Print attempts exhausted. The session is closed and the file deleted.");
    } else {
      setNotice(`Try again — ${attemptsLeft} print attempt(s) left.`);
    }
  };

  const endSession = () => {
    beaconClose();
    wipeCanvases();
    onEnded("ended", "Session closed. The file has been permanently deleted.");
  };

  // ---------------------------------------------------------------------------
  // Editing (customer consent → editor → customer approval)
  // ---------------------------------------------------------------------------

  const applyEditInfo = useCallback(
    (info: EditInfo, phase: EditPhase) => {
      setEditInfo(info);
      if (info.editStatus === "requested") return;
      if (info.editStatus === "editing") {
        if (phase === "requesting") {
          if (info.editKind === "word" && info.editor && info.onlyofficeUrl) {
            setWordEditor({ url: info.onlyofficeUrl, config: info.editor });
            setEditPhase("word");
          } else {
            setEditPhase("image");
          }
        } else if (phase === "saving" && Date.now() - savingSinceRef.current > 45_000) {
          setNotice("The edit didn't save. Try “Send to customer” again.");
          setEditPhase("word");
        }
        return;
      }
      if (info.editStatus === "pending_review") {
        if (phase !== "review") setEditPhase("review");
        return;
      }
      // Back to "none": the round ended one way or another.
      if (phase && phase !== "choose") {
        setEditPhase(null);
        setWordEditor(null);
        if (info.editLastOutcome) setNotice(OUTCOME_TEXT[info.editLastOutcome]);
        if (info.editLastOutcome === "approved") void loadDocument();
      }
    },
    [loadDocument]
  );

  // Poll while waiting on the customer (or the Document Server's save).
  useEffect(() => {
    if (!editPhase || editPhase === "choose" || editPhase === "image") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await fetch("/api/edit/status", { headers: auth, cache: "no-store" });
        if (res.ok && !stopped) applyEditInfo(await res.json(), editPhase);
      } catch {
        /* transient — keep polling */
      }
      if (!stopped) timer = setTimeout(tick, editPhase === "word" ? 5000 : 2000);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editPhase, applyEditInfo]);

  useEffect(() => {
    if (editPhase !== "requesting") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [editPhase]);

  const requestEdit = async (kind: "word" | "image") => {
    setNotice("");
    setBusy(true);
    try {
      const res = await fetch("/api/edit/request", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Couldn't ask to edit.");
        if (data.editStatus) setEditInfo((cur) => ({ ...cur, ...data }));
        setEditPhase(null);
        return;
      }
      setEditInfo((cur) => ({ ...cur, ...data }));
      setLayoutOpen(false);
      setEditPhase("requesting");
    } finally {
      setBusy(false);
    }
  };

  const cancelEdit = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/edit/cancel", { method: "POST", headers: auth });
      const data = await res.json().catch(() => ({}));
      if (data.editStatus) setEditInfo((cur) => ({ ...cur, ...data }));
      setEditPhase(null);
      setWordEditor(null);
    } finally {
      setBusy(false);
    }
  };

  const submitImageEdit = async (pages: EditedPage[], tools: string[]) => {
    setBusy(true);
    setNotice("");
    try {
      const form = new FormData();
      pages.forEach((p, i) => form.append("page", p.blob, `page-${i + 1}.jpg`));
      form.append("sizes", JSON.stringify(pages.map((p) => [p.widthPt, p.heightPt])));
      form.append("tools", JSON.stringify(tools));
      const res = await fetch("/api/edit/pages", { method: "POST", headers: auth, body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't send the edit.");
      setEditInfo((cur) => ({ ...cur, ...data }));
      setEditPhase("review");
    } finally {
      setBusy(false);
    }
  };

  const finishWordEdit = async () => {
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch("/api/edit/finish", { method: "POST", headers: auth });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(data.error ?? "Couldn't save the edit.");
        return;
      }
      savingSinceRef.current = Date.now();
      setEditPhase("saving");
    } finally {
      setBusy(false);
    }
  };

  const editing = editPhase !== null && editPhase !== "choose";
  const requestLeft = editInfo.editRequestExpiresAt ? new Date(editInfo.editRequestExpiresAt).getTime() - now : 0;
  const canEdit = editInfo.editRoundsLeft > 0 && !loading && !error;

  // ---------------------------------------------------------------------------

  return (
    <div className="locked-viewer">
      {paper !== "auto" && (
        <style media="print">{`@page { size: ${paper} ${landscape ? "landscape" : "portrait"}; margin: 0; }`}</style>
      )}

      <div className="viewer-toolbar">
        <span className="doc-name">{session.fileName}</span>
        <span className="lock-note">View-only · {attemptsLeft} print(s) left</span>
        {!editing && (
          <>
            <button
              className={`btn secondary${layoutOpen ? " active" : ""}`}
              onClick={() => setLayoutOpen((o) => !o)}
              disabled={loading || !!error}
              aria-expanded={layoutOpen}
            >
              Layout
            </button>
            <button
              className="btn secondary"
              onClick={() => setEditPhase(editPhase === "choose" ? null : "choose")}
              disabled={busy || !canEdit}
              aria-expanded={editPhase === "choose"}
              title={editInfo.editRoundsLeft > 0 ? "Ask the customer to let you edit" : "Edit limit reached"}
            >
              Edit
            </button>
            <button className="btn" onClick={handlePrint} disabled={busy || loading || !!error || attemptsLeft <= 0}>
              Print
            </button>
          </>
        )}
        <button className="btn secondary" onClick={endSession} disabled={busy} style={{ width: "auto", marginTop: 0 }}>
          Close
        </button>
      </div>

      {notice && <p className="error">{notice}</p>}
      {loading && <p className="hint">Decrypting and rendering document…</p>}
      {error && <p className="error">{error}</p>}

      {editPhase === "choose" && (
        <div className="viewer-panel">
          <h3>Edit this document</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            The customer must tap Allow on their phone first. Then they check your changes and approve them
            before you can print. {editInfo.editRoundsLeft} edit round(s) left.
          </p>
          <div className="row wrap">
            {editInfo.wordEditable && (
              <button className="btn" onClick={() => requestEdit("word")} disabled={busy}>
                Edit as Word
              </button>
            )}
            <button className={`btn${editInfo.wordEditable ? " secondary" : ""}`} onClick={() => requestEdit("image")} disabled={busy}>
              Edit pages (photo tools)
            </button>
          </div>
          <p className="field-note">
            {editInfo.wordEditable
              ? "Word: change text, fonts, alignment and spacing. Photo tools: crop, straighten, clean up, whiteout, draw, add text."
              : "Crop, straighten or fix a skewed photo, clean up shadows, whiteout marks, draw, and add text or boxes."}
          </p>
        </div>
      )}

      {editPhase === "requesting" && (
        <div className="viewer-panel waiting">
          <h3>Waiting for the customer</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            Their phone asks: “Allow this shop to edit your document?” Ask them to tap Allow.
          </p>
          {requestLeft > 0 && (
            <p className="countdown">
              Expires in{" "}
              <strong>
                {Math.floor(requestLeft / 60000)}:{String(Math.floor((requestLeft % 60000) / 1000)).padStart(2, "0")}
              </strong>
            </p>
          )}
          <button className="btn secondary" onClick={cancelEdit} disabled={busy}>
            Cancel request
          </button>
        </div>
      )}

      {(editPhase === "review" || editPhase === "saving") && (
        <div className="viewer-panel waiting">
          <h3>{editPhase === "saving" ? "Saving your changes…" : "Sent to the customer"}</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            They&apos;re checking the edited pages on their phone. Printing unlocks once they approve — or
            the earlier version comes back if they reject it.
          </p>
        </div>
      )}

      {editPhase === "image" && (
        <ImageEditor
          pages={pristineRef.current}
          watermark={`SAFEPRINT · SP-${shareCode}`}
          busy={busy}
          onSubmit={submitImageEdit}
          onCancel={cancelEdit}
        />
      )}

      {(editPhase === "word" || editPhase === "saving") && wordEditor && (
        <div style={editPhase === "saving" ? { display: "none" } : undefined}>
          <WordEditor
            onlyofficeUrl={wordEditor.url}
            config={wordEditor.config}
            busy={busy}
            onFinish={finishWordEdit}
            onCancel={cancelEdit}
          />
        </div>
      )}

      {layoutOpen && !editing && pageCount > 0 && (
        <div className="viewer-panel layout-panel">
          <div className="layout-row">
            {pageCount > 1 && (
              <label className="tool-field">
                Apply to
                <select
                  value={String(layoutTarget)}
                  onChange={(e) => setLayoutTarget(e.target.value === "all" ? "all" : Number(e.target.value))}
                >
                  <option value="all">All pages</option>
                  {Array.from({ length: pageCount }, (_, i) => (
                    <option key={i} value={i}>
                      Page {i + 1}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="tool-field">
              Paper
              <select value={paper} onChange={(e) => setPaper(e.target.value as Paper)}>
                {PAPERS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="tool-field">
              Size
              <select value={shown.fit} onChange={(e) => updateLayout(() => ({ fit: e.target.value as Adjust["fit"] }))}>
                <option value="fit">Fit to paper</option>
                <option value="actual">Actual size</option>
              </select>
            </label>
            <label className="tool-field">
              Scale {shown.scalePct}%
              <input
                type="range"
                min={25}
                max={MAX_SCALE}
                step={1}
                value={shown.scalePct}
                onChange={(e) => updateLayout(() => ({ scalePct: Number(e.target.value) }))}
              />
            </label>
          </div>
          <div className="layout-row">
            <div className="tool-group">
              <span className="tool-group-label">Turn</span>
              <button className="tool-btn" onClick={() => updateLayout((a) => ({ rotate: (((a.rotate + 270) % 360) as Adjust["rotate"]) }))}>
                ⟲ 90°
              </button>
              <button className="tool-btn" onClick={() => updateLayout((a) => ({ rotate: (((a.rotate + 90) % 360) as Adjust["rotate"]) }))}>
                ⟳ 90°
              </button>
            </div>
            <div className="tool-group">
              <span className="tool-group-label">Move</span>
              <button className="tool-btn" onClick={() => nudge(-1, 0)} aria-label="Move left 1 mm">←</button>
              <button className="tool-btn" onClick={() => nudge(0, -1)} aria-label="Move up 1 mm">↑</button>
              <button className="tool-btn" onClick={() => nudge(0, 1)} aria-label="Move down 1 mm">↓</button>
              <button className="tool-btn" onClick={() => nudge(1, 0)} aria-label="Move right 1 mm">→</button>
              <span className="tool-readout">
                {shown.offsetXmm >= 0 ? "+" : ""}
                {shown.offsetXmm} / {shown.offsetYmm >= 0 ? "+" : ""}
                {shown.offsetYmm} mm
              </span>
            </div>
            <label className="tool-check">
              <input type="checkbox" checked={shown.grayscale} onChange={(e) => updateLayout(() => ({ grayscale: e.target.checked }))} />{" "}
              Black &amp; white
            </label>
            {layoutTarget !== "all" && (
              <label className="tool-check">
                <input type="checkbox" checked={!shown.include} onChange={(e) => updateLayout(() => ({ include: !e.target.checked }))} /> Skip this
                page
              </label>
            )}
            <button
              className="tool-btn"
              onClick={() => setLayout((cur) => cur.map(() => defaultAdjust()))}
              disabled={!layoutChanged}
            >
              Reset
            </button>
          </div>
          {offPaper.length > 0 && (
            <p className="error" role="status">
              Part of page {offPaper.join(", ")} falls off the paper and won&apos;t print. Move it back or use Reset.
            </p>
          )}
          <p className="field-note">
            Layout turns, moves and shrinks pages on paper; it is logged with the print. Changing what a page says
            needs the customer&apos;s approval (Edit). Printing {included} of {pageCount} page
            {pageCount > 1 ? "s" : ""}.
          </p>
        </div>
      )}

      {!loading && !error && !editing && (
        <p className="hint" style={{ marginBottom: 12 }}>
          Every copy that leaves the print dialog — paper or saved PDF — carries the watermark
          SP-{shareCode} with date and time, and this session is logged.
        </p>
      )}

      <div
        className="canvas-stack print-area"
        ref={stackRef}
        data-paper={paper !== "auto" ? paper : undefined}
        style={editing ? { display: "none" } : undefined}
      >
        <RubberStamp className="desk-stamp" top="SAFEPRINT" bottom="DO NOT DOWNLOAD" center="VIEW" angle={-12} size={128} />
      </div>

      {confirmOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Did the document print correctly?</h3>
            <p className="hint" style={{ marginBottom: 16 }}>
              Confirming will permanently delete the file. If the print failed, choose “No” to
              retry ({attemptsLeft} attempt(s) left).
            </p>
            <div className="row">
              <button className="btn" onClick={confirmPrinted} disabled={busy}>
                Yes, printed
              </button>
              <button className="btn secondary" onClick={printFailed} disabled={busy}>
                No, it failed
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
