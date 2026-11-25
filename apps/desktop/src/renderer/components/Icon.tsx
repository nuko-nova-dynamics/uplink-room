import type { SVGProps } from "react";
import type { IconName } from "../lib/states";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** 16px line icons. Each run state has a distinct shape, so state never rests on color alone. */
const PATHS: Record<IconName, React.ReactNode> = {
  alert: (
    <>
      <path {...stroke} d="M8 2.2 14.2 13H1.8z" />
      <path
        d="M6.857 5.714h2.286v3.429H6.857zM6.857 10.286h2.286v2.285H6.857z"
        fill="currentColor"
      />
    </>
  ),
  working: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.6" opacity=".3" />
      <path {...stroke} d="M8 2.4a5.6 5.6 0 0 1 5.6 5.6" />
    </>
  ),
  check: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.8" />
      <path {...stroke} d="m5.4 8.2 1.8 1.8 3.4-3.8" />
    </>
  ),
  x: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.8" />
      <path {...stroke} d="m5.9 5.9 4.2 4.2M10.1 5.9 5.9 10.1" />
    </>
  ),
  stop: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.8" />
      <rect x="5.6" y="5.6" width="4.8" height="4.8" fill="currentColor" />
    </>
  ),
  dots: (
    <path
      d="M3 5.5a5 4.5 0 1 1 10 0c0 2.5-4 3-4 5H7c0-3.2 4-3.8 4-5a3 2.5 0 1 0-6 0zM7 12h2v2H7z"
      fill="currentColor"
    />
  ),
  circle: <circle {...stroke} cx="8" cy="8" r="5.6" />,
  inbox: <path {...stroke} d="M2 9.5 3.7 3.2h8.6L14 9.5v3.3H2zM2 9.5h3.6l.7 1.6h3.4l.7-1.6H14" />,
  unfiled: (
    <>
      <path {...stroke} d="M2.2 4.2h4l1.2 1.4h6.4v7H2.2z" strokeDasharray="2.6 2" />
    </>
  ),
  folder: <path {...stroke} d="M2.2 3.8h4l1.2 1.4h6.4v7H2.2z" />,
  hash: <path {...stroke} d="M6.2 2.5 5 13.5M11 2.5 9.8 13.5M2.8 6h10.6M2.6 10h10.6" />,
  /** Leaving a private channel: out through a door. */
  exit: (
    <path
      {...stroke}
      d="M9.4 2.8H4a1.2 1.2 0 0 0-1.2 1.2v8c0 .7.5 1.2 1.2 1.2h5.4M6.6 8h6.8M11 5.6 13.4 8 11 10.4"
    />
  ),
  /** A private channel (ADR 0016): where a team channel shows #. */
  lock: (
    <>
      <rect {...stroke} x="3.2" y="7" width="9.6" height="6.8" rx="1.6" />
      <path {...stroke} d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7M8 9.8v1.2" />
    </>
  ),
  /** Call settings: three sliders. */
  sliders: (
    <>
      <path {...stroke} d="M3 4.5h6M12.5 4.5H13M3 11.5h1.5M8 11.5h5" />
      <circle {...stroke} cx="10.8" cy="4.5" r="1.6" />
      <circle {...stroke} cx="6.2" cy="11.5" r="1.6" />
    </>
  ),
  /** Settings: a six-tooth gear, which holds its teeth at 14 px. (Rays around a circle are the sun.) */
  gear: (
    <>
      <path
        {...stroke}
        d="M 6.56 3.833 6.866 2.168 h 2.268 l 0.306 1.665 1.449 0.837 1.593 -0.567 1.134 1.962 -1.287 1.098 v 1.674 l 1.287 1.098 -1.134 1.962 -1.593 -0.567 -1.449 0.837 -0.306 1.665 H 6.866 l -0.306 -1.665 -1.449 -0.837 -1.593 0.567 -1.134 -1.962 1.287 -1.098 V 7.163 L 2.384 6.065 l 1.134 -1.962 1.593 0.567 z"
      />
      <circle {...stroke} cx="8" cy="8" r="2.1" />
    </>
  ),
  terminal: (
    <>
      <rect {...stroke} x="2" y="3" width="12" height="10" rx="2" />
      <path {...stroke} d="m5 6.5 2 1.6-2 1.6M8.5 10h2.5" />
    </>
  ),
  wheel: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      <path {...stroke} d="M2.4 7.2C4.4 6.6 6.2 6.4 8 6.4s3.6.2 5.6.8M8 9.6v4.1" />
    </>
  ),
  eye: (
    <>
      <path {...stroke} d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </>
  ),
  suggest: <path {...stroke} d="M2.5 3.75h11v6h-6l-3 2.5v-2.5h-2z" />,
  open: (
    <>
      <circle {...stroke} cx="5" cy="5.5" r="2" />
      <circle {...stroke} cx="11" cy="5.5" r="2" />
      <path
        {...stroke}
        d="M1.8 12.5c.5-2 1.7-3 3.2-3s2.7 1 3.2 3M7.8 12.5c.5-2 1.7-3 3.2-3s2.7 1 3.2 3"
      />
    </>
  ),
  machine: (
    <>
      <rect {...stroke} x="2" y="2.8" width="12" height="7.6" rx="1.4" />
      <path {...stroke} d="M5.5 13.2h5M8 10.4v2.8" />
    </>
  ),
  live: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.6" opacity=".3" />
      <circle cx="8" cy="8" r="2.6" fill="currentColor" />
    </>
  ),
  offline: (
    <>
      <rect {...stroke} x="2" y="3" width="12" height="7.6" rx="1.4" />
      <path {...stroke} d="M5.5 13.4h5M8 10.6v2.8" />
      <path {...stroke} d="M2 2 14 14" />
    </>
  ),
  plus: (
    <path
      d="M6.857 2.286h2.286v4.571h4.571v2.286H9.143v4.571H6.857V9.143H2.286V6.857h4.571z"
      fill="currentColor"
    />
  ),
  copy: (
    <>
      <rect {...stroke} x="5.4" y="5.4" width="8" height="8" rx="1.6" />
      <path
        {...stroke}
        d="M11 5.4V4.2a1.6 1.6 0 0 0-1.6-1.6H4.2A1.6 1.6 0 0 0 2.6 4.2v5.2A1.6 1.6 0 0 0 4.2 11h1.2"
      />
    </>
  ),
  chevron: <path {...stroke} d="m6 3.6 4.4 4.4L6 12.4" />,
  "chevron-left": <path {...stroke} d="M10 3.6 5.6 8l4.4 4.4" />,
  more: (
    <>
      <circle cx="3.6" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="12.4" cy="8" r="1.25" fill="currentColor" />
    </>
  ),
  "chevron-down": <path {...stroke} d="m3.6 6 4.4 4.4L12.4 6" />,
  layers: <path {...stroke} d="m8 2.4 6 3.2-6 3.2-6-3.2zM2 8.4l6 3.2 6-3.2M2 11l6 3.2 6-3.2" />,
  board: (
    <>
      <rect {...stroke} x="2" y="2.8" width="3.6" height="10.4" rx="1" />
      <rect {...stroke} x="6.2" y="2.8" width="3.6" height="7" rx="1" />
      <rect {...stroke} x="10.4" y="2.8" width="3.6" height="4.6" rx="1" />
    </>
  ),
  file: <path {...stroke} d="M4 1.8h5l3.2 3.2v9.2H4zM9 1.8V5h3.2" />,
  doc: <path {...stroke} d="M4 1.8h5l3.2 3.2v9.2H4zM9 1.8V5h3.2M6 8h4.2M6 10.4h4.2M6 5.8h1.6" />,
  canvas: (
    <>
      <rect {...stroke} x="1.8" y="2.6" width="6" height="4.6" rx="1" />
      <circle {...stroke} cx="11.2" cy="11" r="2.8" />
      <path {...stroke} d="M7.8 5h2.6a1.6 1.6 0 0 1 1.6 1.6v1.2M4.8 7.2v4.4h3.4" />
    </>
  ),
  pdf: (
    <>
      <path {...stroke} d="M4 1.8h5l3.2 3.2v9.2H4zM9 1.8V5h3.2" />
      <path {...stroke} d="M6 11.6V8.2h1a1 1 0 0 1 0 2H6" />
    </>
  ),
  image: (
    <>
      <rect {...stroke} x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" />
      <path {...stroke} d="m2.2 11.6 3.6-3.8 2.8 2.8 1.8-1.8 3.4 3.2" />
      <circle {...stroke} cx="10.6" cy="5.8" r="1.1" />
    </>
  ),
  pin: (
    <path
      {...stroke}
      d="M3 3.2A1.4 1.4 0 0 1 4.4 1.8h7.2A1.4 1.4 0 0 1 13 3.2v6.2a1.4 1.4 0 0 1-1.4 1.4H7.2L3 14.2z"
    />
  ),
  upload: (
    <path
      {...stroke}
      d="M8 10.2V2.4M4.8 5.4 8 2.2l3.2 3.2M2.6 10v2.4c0 .8.6 1.4 1.4 1.4h8c.8 0 1.4-.6 1.4-1.4v-2.4"
    />
  ),
  download: (
    <path
      {...stroke}
      d="M8 2.2v7.8M4.8 7 8 10.2l3.2-3.2M2.6 10v2.4c0 .8.6 1.4 1.4 1.4h8c.8 0 1.4-.6 1.4-1.4v-2.4"
    />
  ),
  comment: (
    <path
      {...stroke}
      d="M2.4 3.7c0-.9.7-1.6 1.6-1.6h8c.9 0 1.6.7 1.6 1.6v5.8c0 .9-.7 1.6-1.6 1.6H6.8l-3 2.8v-2.8h.2c-.9 0-1.6-.7-1.6-1.6z"
    />
  ),
  user: (
    <>
      <circle {...stroke} cx="8" cy="5.3" r="2.6" />
      <path {...stroke} d="M2.8 13.3c.6-2.6 2.6-3.8 5.2-3.8s4.6 1.2 5.2 3.8" />
    </>
  ),
  people: (
    <>
      <circle {...stroke} cx="6" cy="5.6" r="2.3" />
      <path {...stroke} d="M1.8 13c.5-2.3 2.1-3.4 4.2-3.4s3.7 1.1 4.2 3.4" />
      <path {...stroke} d="M10.4 3.5a2.3 2.3 0 0 1 0 4.4M12 9.9c1.2.5 1.9 1.5 2.2 3.1" />
    </>
  ),
  close: <path {...stroke} d="m3 3 10 10M13 3 3 13" />,
  send: <path {...stroke} d="M2.4 8 13.6 2.8 9 13.2 7.4 9z" />,
  "arrow-up": <path {...stroke} d="M8 12.8V3.6M4 7.4l4-4 4 4" />,
  reply: <path {...stroke} d="M6.4 4.1 2.6 7.7l3.8 3.6M2.6 7.7h6.2c2.4 0 4.2 1.4 4.6 4.2" />,
  trash: <path {...stroke} d="M2.8 4.6h10.4M6 4.6V2.6h4v2M4 4.6l.7 8.8h6.6l.7-8.8M8 7.2v3.6" />,
  sun: (
    <>
      <circle {...stroke} cx="8" cy="8" r="2.8" />
      <path
        {...stroke}
        d="M8 2.3v1.3M8 12.4v1.3M2.3 8h1.3M12.4 8h1.3M3.9 3.9l1 1M11.1 11.1l1 1M3.9 12.1l1-1M11.1 4.9l1-1"
      />
    </>
  ),
  moon: <path {...stroke} d="M13.6 8.9A5.6 5.6 0 0 1 7.2 2.5 5.6 5.6 0 1 0 13.6 8.9z" />,
  link: (
    <path
      {...stroke}
      d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.6.6M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.6-.6"
    />
  ),
  clock: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.8" />
      <path {...stroke} d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  browser: (
    <>
      <rect {...stroke} x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path {...stroke} d="M1.8 6h12.4" />
      <circle cx="4" cy="4.4" r=".7" fill="currentColor" />
      <circle cx="6" cy="4.4" r=".7" fill="currentColor" />
    </>
  ),
  expand: <path {...stroke} d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />,
  shrink: <path {...stroke} d="M13 7H9V3M3 9h4v4M9 7l4.5-4.5M7 9l-4.5 4.5" />,
  bell: (
    <>
      <path {...stroke} d="M4 10.6V6.4a4 4 0 0 1 8 0v4.2l1.2 1.2H2.8z" />
      <path {...stroke} d="M6.6 13.4a1.6 1.6 0 0 0 2.8 0" />
    </>
  ),
  play: <path {...stroke} d="M4 2.5v11L13 8z" />,
  mic: (
    <>
      <rect {...stroke} x="5.8" y="1.8" width="4.4" height="7.6" rx="2.2" />
      <path {...stroke} d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2" />
    </>
  ),
  "mic-off": (
    <>
      <path {...stroke} d="M10.2 6.6V4a2.2 2.2 0 0 0-4.2-.9M5.8 6v1.2a2.2 2.2 0 0 0 3.4 1.8" />
      <path
        {...stroke}
        d="M3.4 7.6a4.6 4.6 0 0 0 7.6 3.5M12.6 7.6c0 .5-.1 1-.2 1.4M8 12.2v2M2.4 2.4l11.2 11.2"
      />
    </>
  ),
  camera: (
    <>
      <rect {...stroke} x="1.8" y="4.2" width="9" height="7.6" rx="1.8" />
      <path {...stroke} d="m10.8 7 3.4-2v6l-3.4-2" />
    </>
  ),
  "camera-off": (
    <>
      <path
        {...stroke}
        d="M10.8 9.6v.4a1.8 1.8 0 0 1-1.8 1.8H3.6A1.8 1.8 0 0 1 1.8 10V6a1.8 1.8 0 0 1 1.6-1.8M6.4 4.2H9A1.8 1.8 0 0 1 10.8 6v1l3.4-2v6l-1.4-.8"
      />
      <path {...stroke} d="m2.2 2.2 11.6 11.6" />
    </>
  ),
  screen: (
    <>
      <rect {...stroke} x="1.8" y="2.6" width="12.4" height="8.6" rx="1.6" />
      <path {...stroke} d="M5.6 13.6h4.8M8 11.2v2.4" />
    </>
  ),
  leave: (
    <path
      {...stroke}
      d="M2.2 7.8c3.4-3 8.2-3 11.6 0l-.4 1.8c-.1.5-.6.8-1.1.7l-2-.5c-.4-.1-.7-.5-.7-.9V7.7a6.4 6.4 0 0 0-3.2 0v1.2c0 .4-.3.8-.7.9l-2 .5c-.5.1-1-.2-1.1-.7z"
    />
  ),
  volume: (
    <>
      <path {...stroke} d="M2.8 6.2h2.1L8 3.6v8.8L4.9 9.8H2.8z" />
      <path {...stroke} d="M10.6 6a2.8 2.8 0 0 1 0 4M12.4 4.4a5.2 5.2 0 0 1 0 7.2" />
    </>
  ),
  transcript: (
    <>
      <path {...stroke} d="M3 3.2h10v7.4H8.4L5.4 13v-2.4H3z" />
      <path {...stroke} d="M5.4 5.8h5.2M5.4 8h3.4" />
    </>
  ),
  smile: (
    <>
      <circle {...stroke} cx="8" cy="8" r="5.8" />
      <path {...stroke} d="M5.6 9.4c.6.9 1.4 1.4 2.4 1.4s1.8-.5 2.4-1.4M6 6.4v.1M10 6.4v.1" />
    </>
  ),
  edit: <path {...stroke} d="M10.6 2.6 13.4 5.4 6 12.8l-3.4.6.6-3.4zM9.2 4l2.8 2.8" />,
  pushpin: <path {...stroke} d="M6 2.2h4l-.5 4.1 2.4 2.3H4.1l2.4-2.3zM8 8.6v5.2" />,
  search: (
    <>
      <circle {...stroke} cx="7" cy="6.8" r="4.4" />
      <path {...stroke} d="m10.2 10 3.4 3.4" />
    </>
  ),
  at: (
    <>
      <circle {...stroke} cx="8" cy="8" r="2.4" />
      <path {...stroke} d="M10.4 8v1c0 1 .7 1.6 1.5 1.6s1.5-.8 1.5-2.6A5.4 5.4 0 1 0 10.6 12.8" />
    </>
  ),
  /** The chosen row in a menu of choices. `check` (in a circle) stays the Done state. */
  tick: <path {...stroke} d="m2.6 8.2 3.8 3.8 7-8" />,
  /** An attachment: on a message, and the composer's attach action. */
  paperclip: (
    <path {...stroke} d="m6 9.5 4.6-4.6a1.8 1.8 0 0 1 2.5 2.5l-5.7 5.7a3 3 0 0 1-4.2-4.2L9.1 3" />
  ),
  /** A repo: a branch leaving a line of commits. Settings, GitHub, and the repo pickers. */
  repo: (
    <>
      <circle {...stroke} cx="4.6" cy="3.6" r="1.4" />
      <circle {...stroke} cx="4.6" cy="12.4" r="1.4" />
      <circle {...stroke} cx="11.4" cy="5.2" r="1.4" />
      <path {...stroke} d="M4.6 5v6M11.4 6.6c0 2.6-2.2 3.4-5.4 4.2" />
    </>
  ),
};

export function Icon({
  name,
  size = 14,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      {...rest}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      data-icon={name}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
