import Link from "next/link";

/** The wordmark (DESIGN.md, Brand): Link beside lowercase "uplink room", the dot on the i in amber. */
export function Wordmark() {
  return (
    <Link className="wordmark" href="/" aria-label="Uplink Room, home">
      {/* Link at idle, rendered from the app's character rig (design/link-rig.js). */}
      <img src="/link.png" alt="" width={34} height={34} />
      <span aria-hidden="true">
        upl<span className="idot">i</span>nk room
      </span>
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="site-head">
      <Wordmark />
      <nav className="site-nav" aria-label="Site">
        <Link href="/download">Download</Link>
        <Link className="nav-extra" href="/privacy">
          Privacy
        </Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <span>© 2026 Nuko Nova Dynamics LLC</span>
      <nav aria-label="Legal and downloads">
        <Link href="/download">Download</Link>
        <Link href="/privacy">Privacy policy</Link>
        <Link href="/terms">Terms of use</Link>
      </nav>
    </footer>
  );
}
