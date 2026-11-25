import { Stage } from '../../kit'
import { AppIcon } from '../uplink-r2-a'
import '../uplink-r2-a/a.css'
import './board.css'

// Direction A's brand board: the wordmark with its amber tittle, the app
// icon at two sizes, the type pair with real names, and the palette, on the
// direction's own ground.

const INKS: [string, string][] = [
  ['Ground', '#121315'],
  ['Raised', '#18191c'],
  ['Line', '#26282c'],
  ['Text', '#ebecee'],
  ['Muted', '#8f939b'],
]
const STATES: [string, string][] = [
  ['Needs you', '#f0a73a'],
  ['Working', '#9db0d8'],
  ['Done', '#5fc38f'],
  ['Failed', '#ef6f6c'],
  ['Stopped', '#7c8088'],
]

function Swatch({ name, hex }: { name: string; hex: string }) {
  return (
    <div className="rb-sw">
      <span className="rb-sw__chip" style={{ background: hex }} />
      <span className="rb-sw__name">{name}</span>
      <span className="rb-sw__hex">{hex}</span>
    </div>
  )
}

export default function BoardA() {
  return (
    <Stage width={760} height={320} theme="dark" initial={{}} className="ra rb">
      {() => (
        <div className="rb-board">
          <div className="rb-left">
            <div className="rb-word" aria-label="uplink room">
              upl<span className="rb-i">ı<span className="rb-tittle" /></span>nk room
            </div>
            <div className="rb-icons">
              <AppIcon size={72} />
              <AppIcon size={36} />
              <span className="rb-note">The dot is on when something needs you.</span>
            </div>
          </div>
          <div className="rb-right">
            <div className="rb-type">
              <div className="rb-type__name">Host Grotesk <span>Interface, 13px, 400 500 600</span></div>
              <div className="rb-type__sample">Codex wants to run a command</div>
            </div>
            <div className="rb-type">
              <div className="rb-type__name">Martian Mono <span>Timers, machines, commands, 10px</span></div>
              <div className="rb-type__mono">build-linux&nbsp;&nbsp;&nbsp;04:12&nbsp;&nbsp;&nbsp;tiled-map</div>
            </div>
          </div>
          <div className="rb-pal">
            {INKS.map(([n, h]) => <Swatch key={n} name={n} hex={h} />)}
          </div>
          <div className="rb-pal">
            {STATES.map(([n, h]) => <Swatch key={n} name={n} hex={h} />)}
          </div>
        </div>
      )}
    </Stage>
  )
}
