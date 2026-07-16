import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "About — SafePrint",
  description: "Why SafePrint exists and how it protects documents at photocopy shops.",
};

export default function AboutPage() {
  return (
    <main className="page landing legal">
      <SiteNav />
      <span className="formref">Form SP-4 · About</span>
      <h1 className="legal-title">Why SafePrint exists</h1>

      <div className="card">
        <h3>The problem</h3>
        <p>
          Every day, people WhatsApp their Aadhaar cards, PAN cards, marksheets, and bank
          statements to neighbourhood photocopy shops. The operator downloads the file, prints it,
          and moves on. The file stays on the shop&rsquo;s computer — and years of customers&rsquo;
          identity documents pile up in a Downloads folder. Those folders leak: to data brokers,
          into benami PAN registrations, into loan fraud. The person whose document it was never
          finds out.
        </p>
      </div>

      <div className="card">
        <h3>The idea</h3>
        <p>
          A photocopy shop needs your document for about ninety seconds — the time it takes to
          print it. SafePrint gives the shop exactly that and nothing more: the document opens in
          a locked, view-only window after you say a one-time code at the counter, prints once,
          and is destroyed. Encryption keys are erased on deletion, so even a surviving copy of the
          stored blob is unreadable. Every page carries a watermark tied to the session, and every
          action lands in an audit log.
        </p>
      </div>

      <div className="card">
        <h3>Two tiers, honestly</h3>
        <p>
          The <strong>browser portal</strong> needs no installation and blocks downloading, saving,
          and copying in the viewer — but no web page can control the system print dialog, so its
          output relies on the watermark. The <strong>SafePrint Agent</strong>, a small desktop app
          for Windows, macOS, and Linux, closes that gap: it prints directly to physical printers
          (the dialog never opens), refuses virtual &ldquo;PDF printers&rdquo;, and blocks
          screenshots of the document window on Windows and macOS. We say plainly what each tier
          can and cannot stop — the details are in the open source.
        </p>
      </div>

      <div className="card">
        <h3>Status</h3>
        <p>
          SafePrint is an MVP proving the privacy mechanism. The code — server, portal, and agent —
          is available for audit on{" "}
          <a href="https://github.com/rishipandey9399/safeprint">GitHub</a>. Questions and reports
          are welcome there.
        </p>
      </div>

      <SiteFooter />
    </main>
  );
}
