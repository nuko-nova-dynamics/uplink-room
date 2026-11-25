import { Stage } from '../../kit'
import { AppIcon, WheelMark } from '../uplink-r2-c/mark'
import '../uplink-r2-c/c.css'
import './board.css'

// Direction C's brand board: the lockup, the app icon at two sizes, the type
// pair set in real product strings, and the palette with each color's job.

const PALETTE: [string, string, string][] = [
  ['Ground', '#0E1116', 'Window'],
  ['Raised', '#151A21', 'Cards'],
  ['Text', '#E6EBF2', 'Words'],
  ['Cobalt', '#4C7DFF', 'The driver'],
  ['Working', '#79A0FF', 'State'],
  ['Waiting', '#F5A524', 'State'],
  ['Done', '#4FBF8A', 'State'],
  ['Failed', '#F26B6B', 'State'],
  ['Stopped', '#7D8696', 'State'],
]

export default function UplinkR2CBoard() {
  return (
    <Stage width={760} height={320} theme="dark" className="ucb">
      {() => (
        <div className="ucb-board">
          <div className="ucb-lockup">
            <WheelMark size={46} />
            <span className="ucb-word">Uplink Room</span>
          </div>
          <div className="ucb-icons">
            <AppIcon size={88} />
            <AppIcon size={44} />
            <AppIcon size={22} />
          </div>
          <div className="ucb-type">
            <div className="ucb-face">
              <span className="ucb-name">Atkinson Hyperlegible Next</span>
              <span className="ucb-sample">Codex wants to run a command</span>
              <span className="ucb-weights">
                <span style={{ fontWeight: 400 }}>Regular</span>
                <span style={{ fontWeight: 500 }}>Medium</span>
                <span style={{ fontWeight: 700 }}>Bold</span>
              </span>
            </div>
            <div className="ucb-face">
              <span className="ucb-name">Atkinson Hyperlegible Mono</span>
              <span className="ucb-mono">
                build-linux <span className="ucb-work">Working 04:12</span>
              </span>
            </div>
          </div>
          <div className="ucb-palette">
            {PALETTE.map(([n, hex, job]) => (
              <div className="ucb-sw" key={n}>
                <i style={{ background: hex }} />
                <span className="ucb-sw__n">{n}</span>
                <span className="ucb-sw__h">{hex}</span>
                <span className="ucb-sw__j">{job}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Stage>
  )
}
