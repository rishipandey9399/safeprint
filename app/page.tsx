"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ActiveSession {
  shareCode: string;
  otp: string;
  ownerToken: string;
  fileName: string;
  expiresAt: string;
}

type Status = "awaiting_otp" | "verified" | "printed" | "closed" | "locked" | "expired";

const STATUS_TEXT: Record<Status, { text: string; tone: "" | "ok" | "bad" }> = {
  awaiting_otp: { text: "Waiting for the shop to enter your code…", tone: "" },
  verified: { text: "Shop verified the OTP — document is open in the locked viewer.", tone: "" },
  printed: { text: "Printed. Your document has been permanently deleted.", tone: "ok" },
  closed: { text: "Viewer was closed without printing. Your document was deleted.", tone: "bad" },
  locked: { text: "Too many wrong OTP entries. Your document was deleted.", tone: "bad" },
  expired: { text: "Session expired. Your document was deleted without being printed.", tone: "bad" },
};

const FINAL: Status[] = ["printed", "closed", "locked", "expired"];

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function UploadPage() {
  const [phase, setPhase] = useState<"idle" | "uploading" | "active">("idle");
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [status, setStatus] = useState<Status>("awaiting_otp");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);

  const upload = useCallback(async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a PDF or image first.");
      return;
    }
    setError("");
    setPhase("uploading");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("phone", phoneRef.current?.value ?? "");
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      setSession(data);
      setStatus("awaiting_otp");
      setPhase("active");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setPhase("idle");
    }
  }, []);

  // Poll session status so the uploader sees the print/delete confirmation live.
  useEffect(() => {
    if (phase !== "active" || !session || FINAL.includes(status)) return;
    const id = setInterval(async () => {
      try {
        const res = await fetch(`/api/status?ownerToken=${session.ownerToken}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        setStatus(data.status as Status);
      } catch {
        // transient network issue — keep polling
      }
    }, 3000);
    return () => clearInterval(id);
  }, [phase, session, status]);

  // Countdown to TTL expiry.
  useEffect(() => {
    if (phase !== "active" || !session) return;
    const id = setInterval(() => {
      setRemaining(formatRemaining(new Date(session.expiresAt).getTime() - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [phase, session]);

  const reset = () => {
    setPhase("idle");
    setSession(null);
    setError("");
  };

  return (
    <main className="page">
      <div className="brand">
        <h1>
          SafePrint<span className="logo-dot">.</span>
        </h1>
      </div>
      <span className="formref">Form SP-1 · One-time print authorisation</span>
      <p className="tagline">
        Hand the Xerox shop <strong>one</strong> printable copy of your document — no download, no
        forward, nothing left on their computer afterward.
      </p>

      {phase !== "active" && (
        <div className="card">
          <h2>Authorise one print</h2>
          <label htmlFor="file">Document (PDF, JPG, or PNG — max 15 MB)</label>
          <input id="file" ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" />
          <label htmlFor="phone">Mobile number (optional — for SMS updates)</label>
          <input id="phone" ref={phoneRef} type="tel" placeholder="+91…" maxLength={20} />
          <button className="btn" onClick={upload} disabled={phase === "uploading"}>
            {phase === "uploading" ? "Encrypting & issuing codes…" : "Lock & issue codes"}
          </button>
          {error && <p className="error">{error}</p>}
          <p className="hint">
            Your file is encrypted before it is stored, can only be opened once with the OTP you
            hold, and is permanently deleted after printing or 30 minutes — whichever comes first.
          </p>
          <a className="crosslink" href="/download">
            What is SafePrint? · Get the shop agent
          </a>
        </div>
      )}

      {phase === "active" && session && (
        <div className="card">
          <span className="sheet-ref">SP·{session.shareCode}</span>
          <h2>{session.fileName}</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            At the shop counter, ask the operator to open <strong>Shop portal</strong> and read them
            these two codes out loud:
          </p>
          <div className="code-row">
            <div className="code-box">
              <div className="code-label">Share code</div>
              <div className="code-value">{session.shareCode}</div>
            </div>
            <div className="code-box">
              <div className="code-label">One-time OTP</div>
              <div className="code-value">{session.otp}</div>
            </div>
          </div>
          <p className="counterfoil-note">Say them in person · never text or forward them</p>
          <p className="countdown">
            Self-destructs in <strong>{remaining || "30:00"}</strong>
          </p>
          <div className={`status-line ${STATUS_TEXT[status].tone}`}>{STATUS_TEXT[status].text}</div>
          {FINAL.includes(status) ? (
            <button className="btn secondary" onClick={reset}>
              Share another document
            </button>
          ) : (
            <ol className="steps">
              <li>The shop enters your share code and OTP.</li>
              <li>They see the document in a locked, view-only screen — no download possible.</li>
              <li>They press Print once. The file is then deleted forever.</li>
            </ol>
          )}
        </div>
      )}
    </main>
  );
}
