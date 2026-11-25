import { LinkMascot } from "../characters/LinkMascot";

/**
 * The wordmark (DESIGN.md, Brand): Link as the logomark beside lowercase
 * "uplink room" in Atkinson Hyperlegible Next Bold. The lettering and its i dot
 * share the text ink; amber in the interface is reserved for needs-you states.
 */
export function Wordmark({ size = 22, lively = false }: { size?: number; lively?: boolean }) {
  return (
    <span className="wordmark" style={{ fontSize: "var(--font-20)" }}>
      <LinkMascot size={Math.round(size * 2.6)} lively={lively} />
      <span aria-label="uplink room">
        upl<span className="idot">i</span>nk room
      </span>
    </span>
  );
}
