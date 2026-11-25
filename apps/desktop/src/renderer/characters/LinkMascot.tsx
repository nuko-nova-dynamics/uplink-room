import { useEffect, useState } from "react";
import { CUES, onCue } from "../lib/sound";
import { CharacterView, type RigState } from "./CharacterView";
import type { AnyState } from "../lib/states";

/**
 * Link, the house mascot (DESIGN.md, Link). Every Link on screen reacts to
 * every sound cue, taking the cue's state for a moment, even with sounds off.
 */
export function LinkMascot({
  size,
  state = "idle",
  label = "Link",
  lively = false,
  reacts = true,
  still = false,
}: {
  size: number;
  state?: AnyState | "idle";
  label?: string;
  lively?: boolean;
  reacts?: boolean;
  still?: boolean;
}) {
  const [reaction, setReaction] = useState<{ state: RigState; at: number } | null>(null);
  useEffect(() => {
    if (!reacts) return;
    return onCue((cue) => setReaction({ state: CUES[cue].link, at: performance.now() }));
  }, [reacts]);
  return (
    <CharacterView
      link
      size={size}
      state={state}
      label={label}
      lively={lively}
      still={still}
      reaction={reaction}
    />
  );
}
