const LINKS = [
  { href: "/download#how", label: "How it works" },
  { href: "/download#download", label: "Download" },
  { href: "/about", label: "About" },
];

export default function SiteNav() {
  return (
    <nav className="site-nav" aria-label="Site">
      <a className="nav-brand" href="/download">
        SafePrint<span>.</span>
      </a>
      <div className="nav-links">
        {LINKS.map((l) => (
          <a key={l.href} href={l.href}>
            {l.label}
          </a>
        ))}
        <a className="nav-cta" href="/">
          Send a document
        </a>
      </div>
    </nav>
  );
}
