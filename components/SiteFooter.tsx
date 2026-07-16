export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="foot-guarantee">
        SafePrint never stores a readable file: encrypted at rest, destroyed after one print or 30
        minutes — whichever comes first.
      </p>
      <div className="foot-row">
        <span>© {new Date().getFullYear()} SafePrint · All rights reserved</span>
        <nav aria-label="Legal">
          <a href="/about">About</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="https://github.com/rishipandey9399/safeprint">GitHub</a>
        </nav>
      </div>
    </footer>
  );
}
