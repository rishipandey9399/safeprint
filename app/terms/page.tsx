import type { Metadata } from "next";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "Terms — SafePrint",
  description: "Terms of use for the SafePrint service and desktop agent.",
};

export default function TermsPage() {
  return (
    <main className="page landing legal">
      <SiteNav />
      <span className="formref">Form SP-6 · Terms of use</span>
      <h1 className="legal-title">Terms of use</h1>
      <p className="legal-updated">Effective 16 July 2026</p>

      <div className="card">
        <h3>The service</h3>
        <p>
          SafePrint lets a person share a document with a print shop for exactly one print. A
          session lasts at most 30 minutes, allows a maximum of two print attempts, and ends with
          the document&rsquo;s permanent destruction. Every rendered page carries a watermark tied
          to the session, and all activity is recorded in an audit log.
        </p>
      </div>

      <div className="card">
        <h3>Acceptable use</h3>
        <ul className="legal-list">
          <li>Upload only documents you own or have the right to print.</li>
          <li>No unlawful content, and no use of the service to facilitate fraud or impersonation.</li>
          <li>
            Share your codes only with the shop printing your document, in person. Codes sent over
            chat defeat the protection the service exists to provide.
          </li>
        </ul>
      </div>

      <div className="card">
        <h3>Shop operators</h3>
        <ul className="legal-list">
          <li>
            You are authorised to produce <strong>one physical copy</strong> per confirmed session
            — nothing else.
          </li>
          <li>
            Photographing the screen, saving dialog output, or otherwise retaining a copy is
            prohibited. Watermarks and the audit log make retained copies traceable to your
            session and IP address.
          </li>
          <li>Attempting to bypass the viewer&rsquo;s protections ends your access.</li>
        </ul>
      </div>

      <div className="card">
        <h3>What we promise — and don&rsquo;t</h3>
        <p>
          SafePrint is provided <strong>as is</strong>, without warranty. It is an MVP: it
          eliminates stored copies on the default path and makes circumvention traceable, but no
          system can prevent a camera pointed at a screen. To the maximum extent permitted by law,
          SafePrint&rsquo;s liability is limited to the amount you paid to use it (currently:
          nothing). These terms are governed by the laws of India.
        </p>
      </div>

      <div className="card">
        <h3>Changes</h3>
        <p>
          These terms may change as the service evolves; the effective date above moves when they
          do. Continued use after a change is acceptance of the new terms.
        </p>
      </div>

      <SiteFooter />
    </main>
  );
}
