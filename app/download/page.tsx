"use client";

import { useEffect, useState } from "react";
import RubberStamp from "@/components/RubberStamp";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";
import Reveal from "@/components/Reveal";

const AGENT_VERSION = "0.1.1";
const RELEASE = `https://github.com/rishipandey9399/safeprint/releases/download/agent-v${AGENT_VERSION}`;

type OS = "windows" | "mac" | "linux";

const DOWNLOADS: Record<OS, { label: string; file: string; note: string; alt?: { label: string; file: string } }> = {
  windows: {
    label: "Download for Windows",
    file: `SafePrint.Agent-${AGENT_VERSION}-win-x64.exe`,
    note: "Windows 10/11 · one-click installer",
  },
  mac: {
    label: "Download for macOS",
    file: `SafePrint.Agent-${AGENT_VERSION}-mac-arm64.dmg`,
    note: "macOS 12+ · Apple Silicon",
  },
  linux: {
    label: "Download for Linux",
    file: `SafePrint.Agent-${AGENT_VERSION}-linux-x86_64.AppImage`,
    note: "AppImage · runs anywhere",
    alt: { label: ".deb for Debian/Ubuntu", file: `SafePrint.Agent-${AGENT_VERSION}-linux-amd64.deb` },
  },
};

const OS_NAMES: Record<OS, string> = { windows: "Windows", mac: "macOS", linux: "Linux" };

function detectOS(): OS {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(ua)) return "mac";
  return "linux";
}

export default function DownloadPage() {
  const [os, setOs] = useState<OS>("windows");
  useEffect(() => setOs(detectOS()), []);
  const main = DOWNLOADS[os];
  const others = (Object.keys(DOWNLOADS) as OS[]).filter((k) => k !== os);

  return (
    <main className="page landing">
      <SiteNav />
      <span className="formref">Form SP-0 · Public notice</span>

      {/* ---- hero: the thesis, sealed ---- */}
      <section className="hero">
        <div className="hero-claim">
          <h2>
            One print.
            <br />
            No copy left behind.
          </h2>
          <p className="hero-sub">
            Your Aadhaar, PAN, or marksheet reaches the photocopy shop, prints <strong>once</strong>,
            and stops existing. The shop never gets a file it can save, forward, or sell.
          </p>
          <div className="hero-actions">
            <a className="btn" href="/">
              Send a document
            </a>
            <a className="btn secondary" href="#download">
              Download the shop agent
            </a>
          </div>
        </div>
        <div className="hero-seal stamp-land" aria-hidden="true">
          <RubberStamp top="SAFEPRINT · TRUE COPY" bottom="COPY DESTROYED" center="✓" size={190} />
        </div>
      </section>

      {/* ---- the problem, as a ledger ---- */}
      <Reveal>
      <section className="ledger card">
        <h2>What happens to your document today</h2>
        <div className="ledger-row">
          <span className="ledger-step">You WhatsApp it to the shop</span>
          <span className="ledger-result">it lands in their Downloads folder</span>
        </div>
        <div className="ledger-row">
          <span className="ledger-step">The shop prints it and moves on</span>
          <span className="ledger-result">the file stays on the counter PC, forever</span>
        </div>
        <div className="ledger-row">
          <span className="ledger-step">Years of customers pile up</span>
          <span className="ledger-result">one leak = thousands of Aadhaar & PAN scans</span>
        </div>
        <p className="hint">
          Identity fraud, benami PAN shells, and loan scams start with exactly these folders.
          SafePrint removes the file — so there is nothing to leak.
        </p>
      </section>
      </Reveal>

      {/* ---- how it works: a real sequence ---- */}
      <Reveal>
      <section className="card" id="how">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            Upload your document at this site. It is encrypted immediately and you get two codes: a
            share code and a one-time OTP. A 30-minute self-destruct timer starts.
          </li>
          <li>At the shop counter, say the two codes out loud. Nothing is sent to the shop.</li>
          <li>
            The shop enters the codes and sees your document in a locked, view-only window — no
            download, no save, every pixel watermarked with your session code.
          </li>
          <li>
            They print once. The file is destroyed — encryption keys erased — and your phone gets
            the confirmation. Unused sessions destroy themselves at 30 minutes.
          </li>
        </ol>
      </section>
      </Reveal>

      {/* ---- two tiers, honestly compared ---- */}
      <Reveal>
      <section className="card">
        <h2>Two ways for a shop to print</h2>
        <div className="compare-scroll">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col">Browser portal</th>
                <th scope="col">SafePrint Agent</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Installation</th>
                <td>None — any browser</td>
                <td>One small app</td>
              </tr>
              <tr>
                <th scope="row">Download / save blocked in the viewer</th>
                <td className="yes">Yes</td>
                <td className="yes">Yes</td>
              </tr>
              <tr>
                <th scope="row">System print dialog (has &ldquo;Save as PDF&rdquo;)</th>
                <td className="no">Opens — output is watermarked</td>
                <td className="yes">Never opens — prints direct to the machine</td>
              </tr>
              <tr>
                <th scope="row">Virtual &ldquo;PDF printers&rdquo; blocked</th>
                <td className="no">No</td>
                <td className="yes">Yes — physical printers only</td>
              </tr>
              <tr>
                <th scope="row">Screenshots &amp; screen recording</th>
                <td className="no">Possible — output is watermarked</td>
                <td className="yes">Blocked on Windows &amp; macOS</td>
              </tr>
              <tr>
                <th scope="row">Marked in the audit trail as</th>
                <td>browser</td>
                <td>verified agent</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="hint">
          Every print, either way: session-coded watermark on each page, one-time OTP, two print
          attempts maximum, full audit log, file destroyed after printing.
        </p>
      </section>

      </Reveal>

      {/* ---- the download slip ---- */}
      <Reveal>
      <section className="card dl-slip" id="download">
        <span className="sheet-ref">AGENT v{AGENT_VERSION}</span>
        <h2>Download the SafePrint Agent</h2>
        <p className="hint" style={{ marginTop: 4 }}>
          For the shop&rsquo;s computer. Detected: <strong>{OS_NAMES[os]}</strong>.
        </p>
        <a className="btn dl-main" href={`${RELEASE}/${main.file}`}>
          {main.label}
        </a>
        <p className="dl-note">{main.note}</p>
        {main.alt && (
          <p className="dl-note">
            Prefer a package? <a className="dl-alt" href={`${RELEASE}/${main.alt.file}`}>{main.alt.label}</a>
          </p>
        )}
        <div className="dl-others">
          {others.map((k) => (
            <a key={k} className="dl-alt" href={`${RELEASE}/${DOWNLOADS[k].file}`}>
              {OS_NAMES[k]} — {DOWNLOADS[k].file.split("-").slice(-1)[0]}
            </a>
          ))}
        </div>
        <details className="dl-firstrun">
          <summary>First-run note: these builds are not yet notarized</summary>
          <p>
            <strong>Windows</strong> — SmartScreen shows &ldquo;unrecognized app&rdquo;. Choose{" "}
            <em>More info → Run anyway</em>.
          </p>
          <p>
            <strong>macOS</strong> — the download is blocked on first open. Open <em>Terminal</em>
            {" "}and run, then launch the app normally:
          </p>
          <pre className="dl-cmd">xattr -dr com.apple.quarantine &quot;/Applications/SafePrint Agent.app&quot;</pre>
          <p>
            <strong>Linux</strong> — mark the AppImage executable
            (<code>chmod +x</code>), or install the .deb with <code>sudo apt install ./…deb</code>.
          </p>
        </details>
      </section>
      </Reveal>

      <SiteFooter />
    </main>
  );
}
