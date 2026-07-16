"use client";

import { useState } from "react";
import LockedViewer, { type VerifiedSession } from "@/components/LockedViewer";
import RubberStamp from "@/components/RubberStamp";

export default function ShopPortal() {
  const [phase, setPhase] = useState<"entry" | "viewer" | "done">("entry");
  const [shareCode, setShareCode] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<VerifiedSession | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "printed" | "ended"; message: string } | null>(null);

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareCode, otp }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Verification failed.");
        return;
      }
      setSession(data);
      setPhase("viewer");
    } catch {
      setError("Network error — check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "viewer" && session) {
    return (
      <main className="page wide">
        <LockedViewer
          session={session}
          shareCode={shareCode}
          onEnded={(kind, message) => {
            setOutcome({ kind, message });
            setPhase("done");
          }}
        />
      </main>
    );
  }

  if (phase === "done" && outcome) {
    return (
      <main className="page">
        <div className="card big-result">
          <div className={`result-stamp stamp-land ${outcome.kind === "printed" ? "printed" : "ended"}`}>
            <RubberStamp
              top={outcome.kind === "printed" ? "SAFEPRINT · TRUE COPY" : "SAFEPRINT"}
              bottom={outcome.kind === "printed" ? "COPY DESTROYED" : "SESSION CLOSED"}
              center={outcome.kind === "printed" ? "✓" : "—"}
              size={168}
            />
          </div>
          <h2>{outcome.kind === "printed" ? "Printed & destroyed" : "Session closed"}</h2>
          <p>{outcome.message}</p>
          <p className="hint">Nothing was saved on this computer.</p>
          <button
            className="btn secondary"
            onClick={() => {
              setPhase("entry");
              setSession(null);
              setShareCode("");
              setOtp("");
              setOutcome(null);
            }}
          >
            Print another customer&apos;s document
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="brand">
        <h1>
          SafePrint<span className="logo-dot">.</span>
        </h1>
      </div>
      <span className="formref">Form SP-2 · Operator access</span>
      <p className="tagline">
        Ask the customer for their <strong>share code</strong> and <strong>OTP</strong>. The
        document opens view-only, prints once, and is deleted — nothing is stored on this PC.
      </p>
      <div className="card">
        <h2>Open a customer document</h2>
        <form onSubmit={verify}>
          <label htmlFor="shareCode">Share code</label>
          <input
            id="shareCode"
            type="text"
            autoComplete="off"
            placeholder="e.g. K7X2MP"
            maxLength={6}
            value={shareCode}
            onChange={(e) => setShareCode(e.target.value.toUpperCase())}
            style={{ textTransform: "uppercase", letterSpacing: "0.2em", fontWeight: 700 }}
          />
          <label htmlFor="otp">6-digit OTP</label>
          <input
            id="otp"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="••••••"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            style={{ letterSpacing: "0.35em", fontWeight: 700 }}
          />
          <button className="btn" type="submit" disabled={busy || shareCode.length !== 6 || otp.length !== 6}>
            {busy ? "Verifying…" : "Open document"}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          Wrong OTP 5 times locks the session and deletes the customer&apos;s file. Sessions
          self-destruct 30 minutes after upload.
        </p>
        <a className="crosslink" href="/download">
          Print without the system dialog — get the SafePrint Agent
        </a>
      </div>
    </main>
  );
}
