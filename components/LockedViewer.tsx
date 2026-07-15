"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import RubberStamp from "./RubberStamp";

export interface VerifiedSession {
  viewerToken: string;
  fileName: string;
  mimeType: string;
  expiresAt: string;
  printAttemptsLeft: number;
}

interface Props {
  session: VerifiedSession;
  onEnded: (outcome: "printed" | "ended", message: string) => void;
}

/**
 * View-only document surface. Everything is drawn onto <canvas> from bytes
 * fetched with the Authorization header — there is never a URL, <img src>,
 * <embed>, or blob link in the DOM that "Save as", right-click, or the
 * browser cache could capture. Right-click, copy, drag, Ctrl+S/P/C are
 * disabled while mounted.
 */
export default function LockedViewer({ session, onEnded }: Props) {
  const stackRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attemptsLeft, setAttemptsLeft] = useState(session.printAttemptsLeft);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const endedRef = useRef(false);
  const initRef = useRef(false);

  const beaconClose = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    navigator.sendBeacon(
      "/api/session-close",
      new Blob([JSON.stringify({ viewerToken: session.viewerToken })], { type: "application/json" })
    );
  }, [session.viewerToken]);

  // Fetch bytes and paint onto canvases.
  useEffect(() => {
    if (initRef.current) return; // guard React strict-mode double mount
    initRef.current = true;

    (async () => {
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
        const stack = stackRef.current;
        if (!stack) return;

        if (session.mimeType === "application/pdf") {
          const pdfjs = await import("pdfjs-dist");
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            "pdfjs-dist/build/pdf.worker.min.mjs",
            import.meta.url
          ).toString();
          const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
          for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const viewport = page.getViewport({ scale: 2 }); // 2x for print quality
            const canvas = document.createElement("canvas");
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext("2d")!;
            await page.render({ canvasContext: ctx, viewport }).promise;
            stack.appendChild(canvas);
          }
        } else {
          const bitmap = await createImageBitmap(new Blob([buf], { type: session.mimeType }));
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
          bitmap.close();
          stack.appendChild(canvas);
        }
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load document.");
        setLoading(false);
      }
    })();
  }, [session]);

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
    stackRef.current?.querySelectorAll("canvas").forEach((c) => {
      c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
      c.remove();
    });
  };

  const handlePrint = async () => {
    setNotice("");
    setBusy(true);
    try {
      const res = await fetch("/api/print-attempt", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.viewerToken}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setAttemptsLeft(0);
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
      const res = await fetch("/api/confirm-print", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.viewerToken}` },
      });
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

  return (
    <div className="locked-viewer">
      <div className="viewer-toolbar">
        <span className="doc-name">{session.fileName}</span>
        <span className="lock-note">View-only · {attemptsLeft} print(s) left</span>
        <button className="btn" onClick={handlePrint} disabled={busy || loading || !!error || attemptsLeft <= 0}>
          Print
        </button>
        <button className="btn secondary" onClick={endSession} disabled={busy} style={{ width: "auto", marginTop: 0 }}>
          Close
        </button>
      </div>

      {notice && <p className="error">{notice}</p>}
      {loading && <p className="hint">Decrypting and rendering document…</p>}
      {error && <p className="error">{error}</p>}

      <div className="canvas-stack print-area" ref={stackRef}>
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
