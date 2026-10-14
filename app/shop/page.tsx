"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LockedViewer, { type VerifiedSession } from "@/components/LockedViewer";
import RubberStamp from "@/components/RubberStamp";
import ShopCounter, { type CounterIdentity } from "@/components/ShopCounter";

type Phase = "loading" | "setup" | "counter" | "manual" | "waiting" | "viewer" | "done";

const COUNTER_KEY = "safeprint.counter";

// The device key identifies this counter. It lives in this browser only;
// losing it just means registering the counter again.
function loadCounter(): CounterIdentity | null {
  try {
    const raw = localStorage.getItem(COUNTER_KEY);
    return raw ? (JSON.parse(raw) as CounterIdentity) : null;
  } catch {
    return null;
  }
}
function saveCounter(c: CounterIdentity | null) {
  try {
    if (c) localStorage.setItem(COUNTER_KEY, JSON.stringify(c));
    else localStorage.removeItem(COUNTER_KEY);
  } catch {
    /* storage blocked — the counter works until this tab closes */
  }
}

function Masthead({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="brand">
        <h1>
          SafePrint<span className="logo-dot">.</span>
        </h1>
      </div>
      <span className="formref">Form SP-2 · Operator access</span>
      <p className="tagline">{children}</p>
    </>
  );
}

export default function ShopPortal() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [counter, setCounter] = useState<CounterIdentity | null>(null);
  const [shareCode, setShareCode] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<VerifiedSession | null>(null);
  const [waitingFor, setWaitingFor] = useState<{ token: string; shopName: string | null; until: number } | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "printed" | "ended"; message: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const nameRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = loadCounter();
    setCounter(stored);
    setPhase(stored ? "counter" : "setup");
  }, []);

  // Where the operator goes after a job: their counter, or the manual form if unregistered.
  const home = useCallback(() => setPhase(counter ? "counter" : "manual"), [counter]);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/shops/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nameRef.current?.value ?? "", area: areaRef.current?.value ?? "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not set up the counter.");
      saveCounter(data);
      setCounter(data);
      setPhase("counter");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set up the counter.");
    } finally {
      setBusy(false);
    }
  };

  const forgetCounter = useCallback(() => {
    saveCounter(null);
    setCounter(null);
    setError("");
    setPhase("setup");
  }, []);

  const verify = async (code: string, enteredOtp: string) => {
    setError("");
    setBusy(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (counter) headers["X-SafePrint-Shop-Key"] = counter.deviceKey;
      const res = await fetch("/api/verify-otp", {
        method: "POST",
        headers,
        body: JSON.stringify({ shareCode: code, otp: enteredOtp }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Verification failed.");
        return;
      }
      setShareCode(code);
      if (data.pendingApproval) {
        setWaitingFor({
          token: data.viewerToken,
          shopName: data.shopName,
          until: Date.now() + (data.approvalTimeoutSeconds ?? 120) * 1000,
        });
        setPhase("waiting");
      } else {
        setSession(data);
        setPhase("viewer");
      }
    } catch {
      setError("Network error — check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  // While the customer decides, poll for their Allow / Deny.
  useEffect(() => {
    if (phase !== "waiting" || !waitingFor) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = async () => {
      try {
        const res = await fetch("/api/approval-status", {
          headers: { Authorization: `Bearer ${waitingFor.token}` },
          cache: "no-store",
        });
        const data = await res.json();
        if (stopped) return;
        if (data.state === "approved") {
          setSession({ viewerToken: waitingFor.token, ...data });
          setWaitingFor(null);
          setPhase("viewer");
          return;
        }
        if (data.state === "denied") {
          setWaitingFor(null);
          setOtp("");
          setError("The customer did not allow access (denied or timed out). Ask them for a new OTP.");
          home();
          return;
        }
      } catch {
        // transient — keep waiting
      }
      if (!stopped) timer = setTimeout(check, 1500);
    };
    void check();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(tick);
    };
  }, [phase, waitingFor, home]);

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
              setSession(null);
              setShareCode("");
              setOtp("");
              setOutcome(null);
              setError("");
              home();
            }}
          >
            Next customer
          </button>
        </div>
      </main>
    );
  }

  if (phase === "waiting" && waitingFor) {
    const left = Math.max(0, Math.ceil((waitingFor.until - now) / 1000));
    return (
      <main className="page">
        <Masthead>
          OTP accepted. The customer now has to approve on their phone.
        </Masthead>
        <div className="card big-result">
          <h2>Waiting for the customer to tap Allow…</h2>
          <p className="hint">
            Their phone shows “{waitingFor.shopName ?? "A shop"} wants to open your document”.
          </p>
          <p className="countdown">
            Times out in{" "}
            <strong>
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </strong>
          </p>
        </div>
      </main>
    );
  }

  if (phase === "counter" && counter) {
    return (
      <main className="page wide">
        <Masthead>
          Customers scan your counter QR and upload. Pick their job and type the <strong>OTP</strong>{" "}
          they read you — the document opens view-only once they allow it.
        </Masthead>
        <ShopCounter
          counter={counter}
          busy={busy}
          error={error}
          onVerify={verify}
          onManual={() => {
            setError("");
            setPhase("manual");
          }}
          onForget={forgetCounter}
          onInvalidKey={forgetCounter}
        />
        <a className="crosslink" href="/download">
          Print without the system dialog — get the SafePrint Agent
        </a>
      </main>
    );
  }

  if (phase === "setup") {
    return (
      <main className="page">
        <Masthead>
          Set up this computer as a SafePrint counter once. Customers then scan your QR, and you
          only type their <strong>OTP</strong>.
        </Masthead>
        <div className="card">
          <h2>Set up this counter</h2>
          <form onSubmit={register}>
            <label htmlFor="shopName">Shop name</label>
            <input id="shopName" ref={nameRef} type="text" maxLength={60} placeholder="e.g. Sharma Xerox" required />
            <label htmlFor="shopArea">Area (optional)</label>
            <input id="shopArea" ref={areaRef} type="text" maxLength={60} placeholder="e.g. Andheri West" />
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Setting up…" : "Create counter QR"}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
          <p className="hint">
            No password needed: this browser keeps a private counter key. Clearing site data means
            setting up again.
          </p>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setError("");
              setPhase("manual");
            }}
          >
            Continue without setting up — enter share code + OTP
          </button>
        </div>
      </main>
    );
  }

  if (phase === "manual") {
    return (
      <main className="page">
        <Masthead>
          Ask the customer for their <strong>share code</strong> and <strong>OTP</strong>. The
          document opens view-only after they allow it, prints once, and is deleted.
        </Masthead>
        <div className="card">
          <h2>Open a customer document</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verify(shareCode, otp);
            }}
          >
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
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setError("");
              setPhase(counter ? "counter" : "setup");
            }}
          >
            ← {counter ? "Back to counter" : "Set up this counter instead"}
          </button>
        </div>
      </main>
    );
  }

  return <main className="page" />;
}
