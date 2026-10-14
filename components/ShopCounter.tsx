"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export interface CounterIdentity {
  deviceKey: string;
  shopCode: string;
  name: string;
  area: string;
}

interface Job {
  shareCode: string;
  status: "awaiting_otp" | "awaiting_approval";
  fileName: string;
  createdAt: string;
  expiresAt: string;
}

interface Props {
  counter: CounterIdentity;
  busy: boolean;
  error: string;
  onVerify: (shareCode: string, otp: string) => void;
  onManual: () => void;
  onForget: () => void;
  onInvalidKey: () => void;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The registered counter's home screen: a QR the customer scans (pairs
 * their upload with this counter) and the live queue of paired jobs. The
 * operator picks a job and types only the customer's OTP.
 */
export default function ShopCounter({ counter, busy, error, onVerify, onManual, onForget, onInvalidKey }: Props) {
  const [qrSvg, setQrSvg] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [queueError, setQueueError] = useState("");

  const pairUrl = typeof window === "undefined" ? "" : `${window.location.origin}/?shop=${counter.shopCode}`;

  useEffect(() => {
    if (!pairUrl) return;
    QRCode.toString(pairUrl, { type: "svg", margin: 1, color: { dark: "#26211a", light: "#fffdf7" } })
      .then(setQrSvg)
      .catch(() => setQrSvg(""));
  }, [pairUrl]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch("/api/shops/jobs", {
          headers: { "X-SafePrint-Shop-Key": counter.deviceKey },
          cache: "no-store",
        });
        if (res.status === 401) {
          onInvalidKey();
          return;
        }
        const data = await res.json();
        if (!stopped && res.ok) {
          setJobs(data.jobs);
          setQueueError("");
        }
      } catch {
        if (!stopped) setQueueError("Can't reach SafePrint — retrying…");
      }
      if (!stopped) timer = setTimeout(load, 3000);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [counter.deviceKey, onInvalidKey]);

  // Drop the selection if that job left the queue (printed, expired, locked).
  useEffect(() => {
    if (selected && !jobs.some((j) => j.shareCode === selected)) {
      setSelected(null);
      setOtp("");
    }
  }, [jobs, selected]);

  return (
    <div className="counter-grid">
      <div className="card counter-qr">
        <h2>{counter.name}</h2>
        {counter.area && <p className="hint" style={{ marginTop: 0 }}>{counter.area}</p>}
        <div className="qr" aria-label={`QR code for ${pairUrl}`} dangerouslySetInnerHTML={{ __html: qrSvg }} />
        <div className="code-label" style={{ textAlign: "center" }}>Counter code</div>
        <div className="counter-code">{counter.shopCode}</div>
        <p className="hint" style={{ textAlign: "center" }}>
          Customers scan this with their phone camera, upload, and read you their OTP.
        </p>
        <button type="button" className="link-btn" onClick={onForget}>
          Forget this counter
        </button>
      </div>

      <div className="card">
        <h2>Incoming jobs</h2>
        {queueError && <p className="error">{queueError}</p>}
        {jobs.length === 0 ? (
          <p className="hint">No customers waiting. Jobs appear here as soon as someone uploads.</p>
        ) : (
          <ul className="job-list">
            {jobs.map((job) => (
              <li key={job.shareCode}>
                <button
                  type="button"
                  className={`job${selected === job.shareCode ? " selected" : ""}`}
                  onClick={() => {
                    setSelected(job.shareCode);
                    setOtp("");
                  }}
                >
                  <span className="job-name">{job.fileName}</span>
                  <span className="job-meta">
                    {timeOf(job.createdAt)} · SP·{job.shareCode}
                    {job.status === "awaiting_approval" ? " · waiting for customer" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onVerify(selected, otp);
            }}
          >
            <label htmlFor="otp">Customer&apos;s 6-digit OTP</label>
            <input
              id="otp"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="••••••"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              style={{ letterSpacing: "0.35em", fontWeight: 700 }}
            />
            <button className="btn" type="submit" disabled={busy || otp.length !== 6}>
              {busy ? "Verifying…" : "Open document"}
            </button>
          </form>
        )}
        {error && <p className="error">{error}</p>}
        <p className="hint">
          Wrong OTP 5 times destroys the customer&apos;s file. After a correct OTP the customer must tap
          Allow on their phone.
        </p>
        <button type="button" className="link-btn" onClick={onManual}>
          Customer didn&apos;t scan the QR? Enter share code + OTP
        </button>
      </div>
    </div>
  );
}
