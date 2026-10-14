"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ActiveSession {
  shareCode: string;
  otp: string;
  ownerToken: string;
  fileName: string;
  expiresAt: string;
  otpExpiresAt: string;
  shopName: string | null;
}

interface ShopChoice {
  shopCode: string;
  label: string;
}

type Status =
  | "awaiting_otp"
  | "awaiting_approval"
  | "verified"
  | "printed"
  | "closed"
  | "locked"
  | "expired";

interface LiveStatus {
  status: Status;
  otpExpiresAt: string | null;
  otpAttemptsLeft: number;
  otpRegenerationsLeft: number;
  shopName: string | null;
  approvalExpiresAt: string | null;
}

const STATUS_TEXT: Record<Status, { text: string; tone: "" | "ok" | "bad" }> = {
  awaiting_otp: { text: "Waiting for the shop to enter your OTP…", tone: "" },
  awaiting_approval: { text: "The shop entered your OTP — waiting for you to allow it.", tone: "" },
  verified: { text: "You allowed the shop — document is open in the locked viewer.", tone: "" },
  printed: { text: "Printed. Your document has been permanently deleted.", tone: "ok" },
  closed: { text: "Viewer was closed without printing. Your document was deleted.", tone: "bad" },
  locked: { text: "Too many wrong OTP entries. Your document was deleted.", tone: "bad" },
  expired: { text: "Session expired. Your document was deleted without being printed.", tone: "bad" },
};

const FINAL: Status[] = ["printed", "closed", "locked", "expired"];
const STORE_KEY = "safeprint.active";
const MAX_OTP_ATTEMPTS = 5;

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// sessionStorage keeps the OTP visible across a refresh of this tab only —
// it dies with the tab and is never shared. Every access is guarded: private
// modes can throw.
function loadStored(): ActiveSession | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as ActiveSession) : null;
  } catch {
    return null;
  }
}
function saveStored(s: ActiveSession | null) {
  try {
    if (s) sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable — the session just won't survive a refresh */
  }
}

export default function UploadPage() {
  const [phase, setPhase] = useState<"idle" | "uploading" | "active">("idle");
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [otpHidden, setOtpHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shop, setShop] = useState<ShopChoice | null>(null);
  const [shopInput, setShopInput] = useState("");
  const [shopError, setShopError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const status: Status = live?.status ?? "awaiting_otp";

  const lookupShop = useCallback(async (code: string) => {
    setShopError("");
    try {
      const res = await fetch(`/api/shops/lookup?code=${encodeURIComponent(code)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Shop not found.");
      setShop({ shopCode: data.shopCode, label: data.label });
      setShopInput("");
    } catch (err) {
      setShop(null);
      setShopError(err instanceof Error ? err.message : "Shop not found.");
    }
  }, []);

  // Restore an in-flight session after a refresh, and pick up ?shop= from a counter's QR.
  useEffect(() => {
    const stored = loadStored();
    if (stored) {
      setSession(stored);
      setPhase("active");
    }
    const code = new URLSearchParams(window.location.search).get("shop");
    if (code) void lookupShop(code.toUpperCase());
  }, [lookupShop]);

  useEffect(() => {
    saveStored(session);
  }, [session]);

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
      if (shop) form.append("shopCode", shop.shopCode);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      setLive(null);
      setOtpHidden(false);
      setSession(data);
      setPhase("active");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
      setPhase("idle");
    }
  }, [shop]);

  // Live status: a streamed response read with fetch (so the owner token
  // stays in a header, never a URL). Falls back to polling if streaming fails.
  const ownerToken = session?.ownerToken;
  useEffect(() => {
    if (phase !== "active" || !ownerToken) return;
    const headers = { Authorization: `Bearer ${ownerToken}` };
    const abort = new AbortController();
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const apply = (data: LiveStatus) => {
      setLive(data);
      if (FINAL.includes(data.status)) stopped = true;
    };

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/api/status", { headers, cache: "no-store", signal: abort.signal });
        if (res.status === 404) {
          stopped = true;
          return;
        }
        if (res.ok) apply(await res.json());
      } catch {
        // transient — keep polling
      }
      if (!stopped) pollTimer = setTimeout(poll, 3000);
    };

    const stream = async () => {
      let failures = 0;
      while (!stopped && failures < 3) {
        try {
          const res = await fetch("/api/status/stream", { headers, cache: "no-store", signal: abort.signal });
          if (res.status === 404) {
            stopped = true;
            setError("This session is no longer available.");
            return;
          }
          if (!res.ok || !res.body) throw new Error("stream unavailable");
          failures = 0;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              if (chunk.startsWith("data: ")) apply(JSON.parse(chunk.slice(6)));
            }
          }
        } catch {
          if (abort.signal.aborted) return;
          failures++;
          await new Promise((r) => setTimeout(r, 1000 * failures));
        }
      }
      if (!stopped) void poll();
    };

    void stream();
    return () => {
      stopped = true;
      abort.abort();
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [phase, ownerToken]);

  // One clock drives every countdown on the page.
  useEffect(() => {
    if (phase !== "active") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const decide = async (decision: "allow" | "deny") => {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.ownerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      if (data.status) setLive(data);
      if (!res.ok) setError(data.error ?? "Could not send your answer.");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async () => {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/regenerate-otp", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.ownerToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create a new OTP.");
      setSession({ ...session, otp: data.otp, otpExpiresAt: data.otpExpiresAt });
      setLive((l) =>
        l
          ? {
              ...l,
              status: "awaiting_otp",
              approvalExpiresAt: null,
              otpExpiresAt: data.otpExpiresAt,
              otpAttemptsLeft: MAX_OTP_ATTEMPTS,
              otpRegenerationsLeft: data.otpRegenerationsLeft,
            }
          : l
      );
      setOtpHidden(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a new OTP.");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setPhase("idle");
    setSession(null);
    setLive(null);
    setError("");
  };

  const sessionLeft = session ? new Date(session.expiresAt).getTime() - now : 0;
  const otpExpiresAt = live?.otpExpiresAt ?? session?.otpExpiresAt ?? null;
  const otpLeft = otpExpiresAt ? new Date(otpExpiresAt).getTime() - now : 0;
  const otpExpired = !!session && otpLeft <= 0 && !FINAL.includes(status);
  const approvalLeft = live?.approvalExpiresAt ? new Date(live.approvalExpiresAt).getTime() - now : 0;
  const wrongAttempts = live ? MAX_OTP_ATTEMPTS - live.otpAttemptsLeft : 0;
  const canRegenerate = status === "awaiting_otp" && (live?.otpRegenerationsLeft ?? 1) > 0;
  const shopName = live?.shopName ?? session?.shopName ?? null;
  const paired = !!shopName;

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

          <label htmlFor="shopCode">Print at</label>
          {shop ? (
            <div className="shop-chip">
              <span>
                <strong>{shop.label}</strong>
                <span className="shop-chip-code">Counter {shop.shopCode}</span>
              </span>
              <button type="button" className="link-btn" onClick={() => setShop(null)}>
                Change
              </button>
            </div>
          ) : (
            <>
              <div className="inline-field">
                <input
                  id="shopCode"
                  type="text"
                  autoComplete="off"
                  placeholder="Scan the counter's QR, or type its code"
                  maxLength={6}
                  value={shopInput}
                  onChange={(e) => setShopInput(e.target.value.toUpperCase())}
                  style={{ textTransform: "uppercase", letterSpacing: "0.15em" }}
                />
                <button
                  type="button"
                  className="btn secondary inline"
                  disabled={shopInput.length !== 6}
                  onClick={() => lookupShop(shopInput)}
                >
                  Find
                </button>
              </div>
              {shopError && <p className="error">{shopError}</p>}
              <p className="field-note">Optional — without a shop, you&apos;ll give them a share code too.</p>
            </>
          )}

          <label htmlFor="file">Document (PDF, JPG, or PNG — max 15 MB)</label>
          <input id="file" ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" />
          <button className="btn" onClick={upload} disabled={phase === "uploading"}>
            {phase === "uploading" ? "Encrypting & issuing OTP…" : "Lock & get OTP"}
          </button>
          {error && <p className="error">{error}</p>}
          <p className="hint">
            Your file is encrypted before it is stored, opens only with the OTP shown on this phone
            and your approval, and is permanently deleted after printing or 30 minutes — whichever
            comes first.
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
          {paired && (
            <p className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
              Printing at <strong>{shopName}</strong>
            </p>
          )}

          {status === "awaiting_approval" && (
            <div className="approval" role="alertdialog" aria-labelledby="approval-title">
              <h3 id="approval-title">
                {shopName ?? "A shop"} wants to open your document
              </h3>
              <p>
                Only allow it if you are at that counter right now and you just told them your OTP.
              </p>
              <div className="row">
                <button className="btn secondary" disabled={busy} onClick={() => decide("deny")}>
                  Deny
                </button>
                <button className="btn" disabled={busy} onClick={() => decide("allow")}>
                  Allow
                </button>
              </div>
              <p className="countdown" style={{ margin: "12px 0 0" }}>
                Auto-denied in <strong>{formatRemaining(approvalLeft)}</strong>
              </p>
            </div>
          )}

          {status === "awaiting_otp" && (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                {paired
                  ? "Tell the operator this OTP out loud:"
                  : "Ask the operator to open the Shop portal and read them these two codes out loud:"}
              </p>
              <div className={`code-row${paired ? " single" : ""}`}>
                {!paired && (
                  <div className="code-box">
                    <div className="code-label">Share code</div>
                    <div className="code-value">{session.shareCode}</div>
                  </div>
                )}
                <div className={`code-box${otpExpired ? " expired" : ""}`}>
                  <div className="code-label">One-time OTP</div>
                  <div className="code-value" aria-live="polite">
                    {otpHidden ? "••••••" : session.otp}
                  </div>
                  <button type="button" className="link-btn" onClick={() => setOtpHidden((h) => !h)}>
                    {otpHidden ? "Show" : "Hide"}
                  </button>
                </div>
              </div>
              <p className="counterfoil-note">
                {otpExpired
                  ? "OTP expired — get a new one below"
                  : `OTP valid for ${formatRemaining(otpLeft)} · say it in person, never text it`}
              </p>
              {wrongAttempts > 0 && (
                <div className="status-line bad" style={{ marginTop: 14 }}>
                  ⚠ {wrongAttempts} wrong OTP attempt{wrongAttempts > 1 ? "s" : ""} —{" "}
                  {live?.otpAttemptsLeft} left before your document is destroyed.
                </div>
              )}
              {canRegenerate && (
                <button className="btn secondary" disabled={busy} onClick={regenerate}>
                  {otpExpired ? "Get a new OTP" : "Regenerate OTP"}
                  {live ? ` (${live.otpRegenerationsLeft} left)` : ""}
                </button>
              )}
            </>
          )}

          {!FINAL.includes(status) && (
            <p className="countdown">
              Self-destructs in <strong>{formatRemaining(sessionLeft)}</strong>
            </p>
          )}
          <div className={`status-line ${STATUS_TEXT[status].tone}`}>{STATUS_TEXT[status].text}</div>
          {error && <p className="error">{error}</p>}
          {FINAL.includes(status) ? (
            <button className="btn secondary" onClick={reset}>
              Share another document
            </button>
          ) : (
            <ol className="steps">
              <li>The shop enters your OTP{paired ? "" : " and share code"}.</li>
              <li>You tap Allow on this phone.</li>
              <li>They see it in a locked, view-only screen and print once. Then it is deleted forever.</li>
            </ol>
          )}
        </div>
      )}
    </main>
  );
}
