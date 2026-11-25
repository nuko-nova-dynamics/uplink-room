import { Stage } from '../../kit'
import './board.css'

// Direction B brand board: mark and wordmark, app icon at two sizes, the type
// pair with Uplink Room's own words, and the palette by role.

function Mark({ size = 28, circle = '#efe9e2', square = '#efe9e2' }: { size?: number; circle?: string; square?: string }) {
  return (
    <svg width={(size * 46) / 28} height={size} viewBox="0 0 46 28" aria-hidden>
      <circle cx="12" cy="14" r="11" fill={circle} />
      <rect x="23" y="3" width="22" height="22" rx="6" fill={square} />
    </svg>
  )
}

function Icon({ px }: { px: number }) {
  return (
    <span className="bb-icon" style={{ width: px, height: px, borderRadius: px * 0.225 }}>
      <Mark size={px * 0.42} circle="#5dd39e" square="#efe9e2" />
    </span>
  )
}

const SWATCHES: [string, string][] = [
  ['Ground', '#181512'], ['Sidebar', '#13110e'], ['Raised', '#201c18'], ['Text', '#efe9e2'], ['Muted', '#a69d92'],
  ['Presence', '#5dd39e'], ['Waiting', '#f2a23c'], ['Working', '#8ab4f8'], ['Done', '#7bc89a'], ['Failed', '#ef7a6c'], ['Stopped', '#8c8379'],
]

export default function BoardB() {
  return (
    <Stage width={760} height={300} theme="dark" specimen className="bb">
      {() => (
        <div className="bb-board">
          <div className="bb-brand">
            <div className="bb-lockup"><Mark size={28} /><span className="bb-word">Uplink Room</span></div>
            <p className="bb-line">People and agents in one room.</p>
            <div className="bb-icons"><Icon px={64} /><Icon px={32} /></div>
          </div>
          <div className="bb-type">
            <div className="bb-spec">
              <span className="bb-name">Familjen Grotesk</span>
              <span className="bb-sample">Needs you</span>
              <span className="bb-body">Fix double jump on ledges. Hermes asks: ship to playtest-pc now?</span>
            </div>
            <div className="bb-spec">
              <span className="bb-name">Fragment Mono</span>
              <span className="bb-mono">build-linux 04:12 pnpm add -D tiled-map</span>
            </div>
            <div className="bb-swatches">
              {SWATCHES.map(([n, c]) => (
                <span key={n} className="bb-sw"><i style={{ background: c }} /><span>{n}</span></span>
              ))}
            </div>
          </div>
        </div>
      )}
    </Stage>
  )
}
