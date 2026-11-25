import { useState, type CSSProperties } from "react";
import type { MemberRow, RunState, Character } from "../lib/api";
import { HARNESS_LABELS as HARNESS_LABEL, initials } from "../lib/format";
import { STATE_META, type AnyState, type IconName } from "../lib/states";
import { CharacterView } from "../characters/CharacterView";
import { Icon } from "./Icon";
import type { Presence } from "../lib/presence";

type Who = {
  name: string;
  kind: "person" | "agent";
  character?: Character | undefined;
  avatarUrl?: string | undefined;
};

/** People are round avatars; agents are their characters (DESIGN.md). */
export function Face({
  who,
  state = "idle",
  size,
  title,
}: {
  who: Who;
  state?: AnyState | "idle";
  size?: number;
  title?: string;
}) {
  if (who.kind === "agent") {
    return (
      <span
        className="face agent"
        title={title ?? who.name}
        style={size ? { width: size, height: size } : undefined}
      >
        <CharacterView character={who.character} state={state} size={size ?? 20} label={who.name} />
      </span>
    );
  }
  return (
    <span
      className="face"
      title={title ?? who.name}
      style={size ? ({ "--face": `${size}px` } as CSSProperties) : undefined}
    >
      {who.avatarUrl !== undefined ? (
        <Picture src={who.avatarUrl} fallback={initials(who.name)} />
      ) : (
        <span className="face-fallback">{initials(who.name)}</span>
      )}
    </span>
  );
}

/** A person's picture, such as the one a Pair shows (ADR 0034); their initials if it doesn't load. */
function Picture({ src, fallback }: { src: string; fallback: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) return <span className="face-picture face-fallback">{fallback}</span>;
  return (
    <img
      className="face-picture"
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

/** A member as the rest of the app knows them: pull the character from the members list. */
export function MemberFace({
  member,
  members,
  state,
  size,
  presence,
}: {
  member: { memberId: string; name: string; kind: "person" | "agent" };
  members?: MemberRow[] | undefined;
  state?: AnyState | "idle";
  size?: number;
  /** A person's presence as a dot on the face (lib/presence.ts): active or away; offline shows none. */
  presence?: { presence: Presence; label: string } | undefined;
}) {
  const character = members?.find((m) => m.memberId === member.memberId)?.character;
  const face = (
    <Face
      who={{ ...member, character }}
      {...(state ? { state } : {})}
      {...(size ? { size } : {})}
      {...(presence ? { title: `${member.name}, ${presence.label.toLowerCase()}` } : {})}
    />
  );
  if (!presence || member.kind === "agent" || presence.presence === "offline") return face;
  return (
    <span className="face-presence">
      {face}
      <span
        className={`presence-dot ${presence.presence}`}
        role="img"
        aria-label={presence.label}
      />
    </span>
  );
}

/** The state's own icon, in its own color. A working run's icon turns, since only live things move. */
export function StateIcon({
  state,
  size = 14,
  withLabel = false,
  label,
  still = false,
  glyph,
}: {
  state: AnyState;
  size?: number;
  withLabel?: boolean;
  /** Words in place of the state's own label, such as "Live" for a plain shell's run. */
  label?: string;
  /** Hold the working icon still where many sit side by side (board chips). */
  still?: boolean;
  /** An icon in place of the state's own, such as a machine for Machine offline. */
  glyph?: IconName | undefined;
}) {
  const meta = {
    ...STATE_META[state],
    ...(label ? { label } : {}),
    ...(glyph ? { icon: glyph } : {}),
  };
  return (
    <span
      className={`state-icon state-${state} ${state === "working" && !still ? "live" : ""}`}
      title={meta.label}
    >
      <Icon name={meta.icon} size={size} />
      {withLabel ? (
        <span style={{ marginLeft: 5 }}>{meta.label}</span>
      ) : (
        <span className="sr-only">{meta.label}</span>
      )}
    </span>
  );
}

export function StateDot({ state }: { state: RunState | "not_started" }) {
  return (
    <span className={`state-dot state-${state}`} role="img" aria-label={STATE_META[state].label} />
  );
}

/** A harness shows as a tool, not a member: a neutral terminal mark stands in for the real marks (DESIGN.md). */
/**
 * The coding harnesses drawn from the same character system as agents, so the roster, the Inbox and a
 * thread read as one cast: each its own body and color, and its tool out while it works. They stay
 * tools, not members (DESIGN.md, "People, agents and harnesses"); a plain shell, Rex and a Space keep
 * their marks.
 */
const HARNESS_CHARACTERS: Record<string, Character> = {
  "claude-code": { body: "watch", color: "gold", accessory: "scribe" },
  codex: { body: "deploy", color: "sand", accessory: "deploy" },
  "grok-build": { body: "chief", color: "blue", accessory: "chief" },
  opencode: { body: "scribe", color: "teal", accessory: "scribe" },
  cursor: { body: "notetaker", color: "pink", accessory: "deploy" },
  "hermes-agent": { body: "hermes", color: "gold", accessory: "hermes" },
  t3code: { body: "scribe", color: "lilac", accessory: "scribe" },
} as unknown as Record<string, Character>;

export function HarnessMark({
  harness,
  state = "idle",
  size,
  title,
}: {
  harness: string;
  /** Its run's state, which its character shows as an agent's face does. */
  state?: AnyState | "idle";
  size?: number;
  title?: string;
}) {
  // Its id ("codex") or its label ("Codex"), which a thread's messages carry.
  const id = HARNESS_LABEL[harness]
    ? harness
    : (Object.keys(HARNESS_LABEL).find((k) => HARNESS_LABEL[k] === harness) ?? harness);
  const character = HARNESS_CHARACTERS[id];
  const label = HARNESS_LABEL[id] ?? harness;
  if (character) {
    return (
      <span
        className="face agent harness-face"
        title={title ?? label}
        style={size ? { width: size, height: size } : undefined}
      >
        <CharacterView character={character} state={state} size={size ?? 20} label={label} />
      </span>
    );
  }
  // A Space is a desktop, not a terminal harness: it takes the machine mark, as in its own view.
  return (
    <span
      className="mark"
      title={title ?? label}
      style={size ? ({ "--face": `${size}px` } as CSSProperties) : undefined}
    >
      <Icon name={harness === "space" ? "machine" : "terminal"} />
    </span>
  );
}
