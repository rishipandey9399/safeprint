import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Privacy — SafePrint",
  description: "What SafePrint stores, for how long, and what it never stores.",
};

export default function PrivacyPage() {
  return (
    <main className="page landing legal">
      <SiteNav />
      <span className="formref">Form SP-5 · Privacy policy</span>
      <h1 className="legal-title">Privacy policy</h1>
      <p className="legal-updated">Effective 16 July 2026 · describes what the system actually does</p>

      <div className="card">
        <h3>What we store, and for how long</h3>
        <ul className="legal-list">
          <li>
            <strong>Your document</strong> — encrypted with AES-256-GCM before it touches storage,
            using a per-file key that is itself encrypted. It exists for at most 30 minutes, and is
            destroyed the moment a print is confirmed, the viewer is closed, or the OTP is entered
            wrong five times. Destruction erases the encryption keys as well, so any residual copy
            of the stored data is permanently unreadable.
          </li>
          <li>
            <strong>A session record</strong> — file name, size, type, hashed codes, timestamps,
            and session status. Document contents are never stored in the database.
          </li>
          <li>
            <strong>An audit log</strong> — upload, code verification, viewing, print attempts,
            deletion, and expiry events, each with a timestamp and the IP address that performed
            it. This exists so a misused session can be traced.
          </li>
          <li>
            <strong>Your phone number, only if you give it</strong> — used solely to send you the
            print/deletion confirmation. Leave it blank and nothing is sent.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>What we never store</h3>
        <ul className="legal-list">
          <li>A readable copy of your document, at any point, on any machine.</li>
          <li>Your OTP or access codes in plain text — only salted cryptographic hashes.</li>
          <li>Anything on the shop&rsquo;s computer: the viewer holds the document in memory only.</li>
        </ul>
      </div>

      <div className="card">
        <h3>No cookies, no analytics, no advertising</h3>
        <p>
          SafePrint sets no tracking cookies, runs no analytics scripts, and shares nothing with
          advertisers. There is no account system; a session is identified only by the codes you
          hold.
        </p>
      </div>

      <div className="card">
        <h3>Service providers</h3>
        <p>
          In production, encrypted files may be held in Google Cloud Storage (they remain
          encrypted with keys the storage provider never sees) and confirmation SMS may be sent
          through an SMS gateway (which sees your phone number and the message text, never your
          document). In local/self-hosted deployments, neither is used.
        </p>
      </div>

      <div className="card">
        <h3>Questions</h3>
        <p>
          The full implementation is open for inspection on{" "}
          <a href="https://github.com/rishipandey9399/safeprint">GitHub</a> — the code is the
          authoritative version of this policy. Raise privacy questions or reports there.
        </p>
      </div>

      <SiteFooter />
    </main>
  );
}
