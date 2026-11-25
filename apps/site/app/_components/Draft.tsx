import type { ReactNode } from "react";

/** The notice at the top of the privacy policy and the terms while they're drafts under review. */
export function DraftNotice({ children }: { children: ReactNode }) {
  return (
    <div className="draft" role="note">
      <b>Draft</b>
      <p>{children}</p>
    </div>
  );
}

/** A fact the draft still needs, shown as a highlighted placeholder. */
export function Placeholder({ children }: { children: ReactNode }) {
  return <span className="placeholder">[{children}]</span>;
}
