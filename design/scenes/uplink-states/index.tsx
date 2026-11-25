import { useLayoutEffect, useRef, useState } from 'react'
import { Inbox } from 'lucide-react'
import { Avatar, Badge, Bar, Count, Spinner, Stage, Window, type Act } from '../../kit'
import './states.css'

// Uplink Room, Q10: run states. A project board as a dense list. One task is
// open on its three runs. Beats: calm, the arc turning on every Working run;
// Codex's run turns Waiting on its own pill and an Allow button fades into
// its reserved slot; a beat later the task's rollup pill follows (Waiting is
// the most urgent state among its runs) and the sidebar Inbox count rolls
// up; hold; Julio clicks Allow, Codex goes back to Working, the rollup
// follows, the Inbox count rolls back down. The loop ends where it began,
// caused by the click, so nothing rewinds.
//
// Real strings: the project, the task titles, the harness and machine names,
// the five state words, Allow and Inbox. Everything else is placeholder.

type State = 'working' | 'waiting' | 'done' | 'failed' | 'stopped'
type S = { codex: State; rollup: State; inbox: number; allow: boolean }

const initial: S = { codex: 'working', rollup: 'working', inbox: 1, allow: false }

async function script(a: Act<S>) {
  await a.wait(1800)
  a.mark('waiting')
  a.put({ codex: 'waiting', allow: true })
  await a.wait(550)
  a.put({ rollup: 'waiting' })
  await a.wait(250)
  a.put({ inbox: 2 })
  await a.wait(2600)
  a.mark('answer')
  await a.move({ at: 'allow', x: 0.9, y: 0.82 })
  await a.wait(220)
  await a.click({ at: 'allow', x: 0.9, y: 0.82 })
  a.put({ codex: 'working', allow: false })
  await a.wait(550)
  a.put({ rollup: 'working' })
  await a.wait(250)
  a.put({ inbox: 1 })
  await a.wait(500)
  await a.move({ x: 470, y: 352 }, { duration: 700 })
  await a.wait(1400)
}

const LABEL: Record<State, string> = { working: 'Working', waiting: 'Waiting', done: 'Done', failed: 'Failed', stopped: 'Stopped' }
const TONE = { working: 'accent', waiting: 'warning', done: 'success', failed: 'danger', stopped: 'neutral' } as const

// Filled marks drawn on the kit's filled check construction: a 6.75 disc with
// an even-odd cut-out, so all four read at one weight beside the spinner
const DISC = 'M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5Z'
const CUT: Record<Exclude<State, 'working'>, string> = {
  waiting: 'M7.25 4.4h1.5v4.6h-1.5ZM8 10.05a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9Z',
  done: 'M11 5.55l-.95-.8-3.3 3.95-1.85-1.8-.85.9 2.8 2.75Z',
  failed: 'M8 6.94 9.52 5.42 10.58 6.48 9.06 8 10.58 9.52 9.52 10.58 8 9.06 6.48 10.58 5.42 9.52 6.94 8 5.42 6.48 6.48 5.42Z',
  stopped: 'M5.9 5.9h4.2v4.2H5.9Z',
}

function Glyph({ state }: { state: State }) {
  if (state === 'working') return <Spinner size={12} />
  return (
    <svg viewBox="0 0 16 16" width={12} height={12} aria-hidden>
      <path d={DISC + CUT[state]} fill="currentColor" fillRule="evenodd" />
    </svg>
  )
}

// One pill per run or task. The tone eases on the same pill; the marks share
// one 12px cell and crossfade; the label cell eases to the word that shows.
function Pill({ state, states = [state] }: { state: State; states?: State[] }) {
  const words = useRef<HTMLSpanElement[]>([])
  const [w, setW] = useState<number[]>([])
  useLayoutEffect(() => setW(words.current.map(e => e.offsetWidth)), [])
  const on = states.indexOf(state)
  return (
    <Badge
      tone={TONE[state]}
      className="us-pill"
      data-state={state}
      icon={
        <span className="us-mark">
          {states.map(s => (
            <span key={s} className="us-mark__g" data-on={s === state || undefined}><Glyph state={s} /></span>
          ))}
        </span>
      }
    >
      <span className="us-label" style={w.length ? { width: w[on] } : undefined}>
        {states.map((s, i) => (
          <span key={s} ref={e => { if (e) words.current[i] = e }} className="us-word" data-on={s === state || undefined}>{LABEL[s]}</span>
        ))}
      </span>
    </Badge>
  )
}

function Task({ owner, title, state, states, meta }: { owner: string; title: string; state: State; states?: State[]; meta?: string }) {
  return (
    <div className="us-task">
      <Avatar name={owner} size={20} />
      <span className="us-title">
        {title}
        {meta && <span className="us-meta">{meta}</span>}
      </span>
      <Pill state={state} states={states} />
    </div>
  )
}

function Run({ harness, machine, state, states, allow, compact }: { harness: string; machine: string; state: State; states?: State[]; allow?: boolean; compact: boolean }) {
  return (
    <div className="us-run">
      <span className="us-harness">{harness}</span>
      {!compact && <span className="us-machine">{machine}</span>}
      <span className="us-slot">
        {allow !== undefined && (
          <button type="button" className="us-allow" data-target="allow" data-on={allow || undefined} tabIndex={-1}>Allow</button>
        )}
      </span>
      <Pill state={state} states={states} />
    </div>
  )
}

function Side({ inbox }: { inbox: number }) {
  return (
    <nav className="us-side">
      <span className="us-nav" data-strong>
        <Inbox size={14} strokeWidth={1.5} absoluteStrokeWidth />
        Inbox
        <span className="us-count"><Count value={inbox} /></span>
      </span>
      <span className="us-group"><Bar w={52} h={5} tone={2} /></span>
      <span className="us-nav" data-active>
        <span className="us-dot" />
        Reef Runner
      </span>
      {[58, 44].map((w, i) => (
        <span key={i} className="us-nav">
          <span className="us-dot" data-faint />
          <Bar w={w} h={6} tone={2} />
        </span>
      ))}
      <span className="us-group"><Bar w={40} h={5} tone={2} /></span>
      {[66, 50, 72].map((w, i) => (
        <span key={i} className="us-nav">
          <Bar w={12} h={12} r={3} tone={2} />
          <Bar w={w} h={6} tone={2} />
        </span>
      ))}
    </nav>
  )
}

const WW: State[] = ['working', 'waiting']

export default function UplinkStates() {
  return (
    <Stage<S>
      width={720}
      height={420}
      compact={{ below: 720, width: 358, height: 420 }}
      theme="dark"
      initial={initial}
      poster={{ codex: 'waiting', rollup: 'waiting', inbox: 2, allow: true }}
      script={script}
      cursor={{ at: { wide: { x: 470, y: 352 }, compact: { x: 250, y: 380 } } }}
      className="us"
    >
      {(s, _rect, layout) => {
        const compact = layout === 'compact'
        return (
          <Window
            title="Reef Runner"
            className="us-win"
            sidebarWidth={164}
            sidebar={compact ? undefined : <Side inbox={s.inbox} />}
            toolbar={compact ? <span className="us-inbox-chip"><Inbox size={14} strokeWidth={1.5} absoluteStrokeWidth /><Count value={s.inbox} /></span> : undefined}
          >
            <div className="us-body">
              <div className="us-list">
                <div className="us-open">
                  <Task owner="Julio" title="Fix double jump on ledges" meta="3 runs" state={s.rollup} states={WW} />
                  <div className="us-runs">
                    <Run harness="Claude Code" machine="build-linux" state="working" compact={compact} />
                    <Run harness="Codex" machine="julio-mbp" state={s.codex} states={WW} allow={s.allow} compact={compact} />
                    <Run harness="Grok Build" machine="playtest-pc" state="done" compact={compact} />
                  </div>
                </div>
                <Task owner="Ana" title="Level 3 layout" state="failed" />
                <Task owner="Diego" title="Menu music loop" state="stopped" />
                <Task owner="Julio" title="Coyote time tuning" state="done" />
                {[150, 118].map((w, i) => (
                  <div key={i} className="us-task us-task--filler">
                    <Avatar plain size={20} />
                    <Bar w={w} h={7} tone={2} />
                    <Bar w={70} h={20} r={10} tone={1} />
                  </div>
                ))}
              </div>
            </div>
          </Window>
        )
      }}
    </Stage>
  )
}
