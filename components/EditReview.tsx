"use client";

import { useEffect, useRef, useState } from "react";
import { renderPages, wipe } from "@/lib/pdfRender";

interface Props {
  ownerToken: string;
  shopName: string | null;
  onDecided: (status: unknown) => void;
}

/**
 * The citizen's check of the shop's edit: renders the edited version on their
 * own phone, then Approve (it becomes the print copy) or Reject (it's deleted
 * and the earlier version prints).
 */
export default function EditReview({ ownerToken, shopName, onDecided }: Props) {
  const pagesRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let canvases: HTMLCanvasElement[] = [];
    (async () => {
      try {
        const res = await fetch("/api/edit/preview", {
          headers: { Authorization: `Bearer ${ownerToken}` },
          cache: "no-store",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Couldn't load the edited version.");
        }
        const pages = await renderPages(await res.arrayBuffer(), "application/pdf", 1.5);
        canvases = pages.map((p) => p.canvas);
        if (cancelled || !pagesRef.current) return wipe(canvases);
        canvases.forEach((c, i) => {
          c.setAttribute("aria-label", `Edited page ${i + 1}`);
          pagesRef.current!.appendChild(c);
        });
        setPageCount(pages.length);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load the edited version.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      wipe(canvases);
    };
  }, [ownerToken]);

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/edit/review", {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      if (data.status) onDecided(data);
      if (!res.ok) setError(data.error ?? "Couldn't send your answer.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval edit-review" role="region" aria-labelledby="review-title">
      <h3 id="review-title">Check {shopName ?? "the shop"}&apos;s changes</h3>
      <p>
        This is exactly what will print. Approve only if everything is right — reject and the shop prints
        your earlier version.
      </p>
      {loading && <p className="hint">Loading the edited pages…</p>}
      <div className="review-pages" ref={pagesRef} hidden={loading || !!error} />
      {pageCount > 1 && <p className="field-note">{pageCount} pages — scroll to see them all.</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn secondary" disabled={busy} onClick={() => decide("reject")}>
          Reject
        </button>
        <button className="btn" disabled={busy || loading || !!error} onClick={() => decide("approve")}>
          Approve
        </button>
      </div>
    </div>
  );
}
