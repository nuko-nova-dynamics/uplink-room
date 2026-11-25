import { ChevronDown, Hash, Inbox as InboxIcon, Mic, Volume2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Avatar, Bar, Collapse, Count, Facepile, Fly, Roll, Segmented, Stage, Text, Window, type Act, type Rect } from '../../kit'
import { WheelMark } from './mark'
import './c.css'

// Direction C, "The wheel": the brand is who is driving. Uplink Room's Inbox
// (Needs you, Working, Done) beside the thread of the task being driven.
// Beats: Allow once sends Codex's request from Needs you into Working; S
// settles a finished run; W passes the wheel on "Fix double jump on ledges"
// from Julio to Ana, and the cobalt driver pill travels from his face to
// hers; Ana hands it back; a look at the Team tab covers the reset.
//
// Real strings: the sidebar labels, every Inbox row (the subject), the
// thread's title, people and steps, the key hints. The thread's message
// bodies and the Team view's far rows are placeholder lines.

type Who = 'julio' | 'ana'
type S = {
  sec: number
  room: boolean
  gone: boolean
  closed: boolean
  landed: boolean
  fly: null | { from: Rect; to: Rect; go: boolean }
  focus: 'none' | 'coyote' | 'fix'
  settled: boolean
  driver: Who
  name: Who
  back: boolean
  tab: 0 | 1
  hint: '' | 'S' | 'W' | 'A' | 'H'
  t0: number
}

const initial: S = { sec: 0, room: false, gone: false, closed: false, landed: false, fly: null, focus: 'none', settled: false, driver: 'julio', name: 'julio', back: false, tab: 0, hint: '', t0: 0 }

const REST = { at: 'rest', x: 0.5, y: 0.5 }

async function pass(a: Act<S>, to: Who) {
  await a.set({ driver: to })
  // The name changes during the last third of the trip, not on landing
  await a.wait(430)
  await a.set({ name: to })
}

async function script(a: Act<S>) {
  let done = false
  const ticker = (async () => {
    while (!done) {
      await a.wait(1000)
      if (done) break
      await a.set((s) => ({ sec: s.sec + 1 }))
    }
  })()

  await a.wait(1000)

  // 1. Allow once: Codex's request leaves Needs you and lands in Working
  a.mark('allow')
  await a.move({ at: 'allow', x: 0.72, y: 0.62 })
  await a.wait(200)
  await a.click()
  await a.wait(120)
  // The request's room closes as the Working room opens, so the list keeps
  // its height; the flight aims where the new row will sit once both settle
  const from = a.rect('src-head', { layout: true })
  const src = a.rect('src-row', { layout: true })
  const sec = a.rect('work-sec', { layout: true })
  // Once the request's room has closed, the Working header sits src.height
  // higher and the new row starts right under it, its head at the same
  // offset inside the row as the request's
  const to = { ...from, y: sec.y + sec.height - src.height + (from.y - src.y) }
  await a.set({ gone: true, room: true, closed: true, fly: { from, to, go: true } })
  await a.wait(860)
  await a.set((s) => ({ landed: true, fly: null, t0: s.sec }))
  await a.move(REST)
  await a.wait(500)

  // 2. Settle the finished run with S
  a.mark('settle')
  await a.set({ focus: 'coyote' })
  await a.wait(650)
  await a.set({ hint: 'S' })
  await a.key('s')
  await a.set({ settled: true, hint: '' })
  await a.wait(800)

  // 3. Pass the wheel with W
  a.mark('wheel')
  await a.set({ focus: 'fix' })
  await a.wait(650)
  await a.set({ hint: 'W' })
  await a.key('w')
  await a.set({ hint: '' })
  await pass(a, 'ana')
  await a.wait(2100)

  // 4. Ana hands it back: the driver's reset has a cause on screen
  a.mark('back')
  await a.set({ back: true })
  await a.wait(700)
  await pass(a, 'julio')
  await a.wait(600)

  // 5. A look at the Team tab covers the list while it resets
  a.mark('team')
  await a.set({ focus: 'none', back: false })
  await a.move({ at: 'tab-team', x: 0.55, y: 0.55 })
  await a.click()
  await a.set({ tab: 1 })
  await a.wait(320)
  done = true
  await ticker
  await a.snap({ room: false, gone: false, closed: false, landed: false, settled: false, sec: 0, t0: 0 })
  await a.wait(300)
  await a.move({ at: 'tab-mine', x: 0.45, y: 0.55 })
  await a.click()
  await a.set({ tab: 0 })
  await a.move(REST)
}

const clock = (base: number, sec: number) => {
  const t = base + sec
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

function Agent({ k }: { k: string }) {
  return <span className="uc-agent">{k}</span>
}

function Person({ name, size = 20 }: { name: string; size?: number }) {
  return <Avatar name={name} size={size} className="uc-person" style={{ fontSize: Math.round(size * 0.46) }} />
}

function Run({ who, where, base, sec }: { who: string; where: string; base: number; sec: number }) {
  return (
    <div className="uc-run">
      <i className="uc-live" aria-hidden />
      <span className="uc-run__who">{who}</span>
      <span className="uc-mono uc-run__where">{where}</span>
      <span className="uc-run__t">
        Working <span className="uc-mono">{clock(base, sec)}</span>
      </span>
    </div>
  )
}

function Row({ lead, title, chip, children, right, focus, target, head, hidden }: { lead: ReactNode; title: string; chip?: ReactNode; children?: ReactNode; right?: ReactNode; focus?: boolean; target?: string; head?: string; hidden?: boolean }) {
  return (
    <div className="uc-row" data-focus={focus || undefined} data-target={target}>
      <span className="uc-head" data-target={head} data-hidden={hidden || undefined}>
        {lead}
        <Text className="uc-title">{title}</Text>
      </span>
      {chip}
      <span className="uc-right">{right}</span>
      <div className="uc-sub">{children}</div>
    </div>
  )
}

function Section({ dot, label, count, target }: { dot: 'wait' | 'work' | 'done'; label: string; count: number; target?: string }) {
  return (
    <div className="uc-sec" data-target={target}>
      <i className="uc-dot" data-state={dot} aria-hidden />
      <span>{label}</span>
      <span className="uc-sec__n" data-zero={count === 0 || undefined}>
        <Count value={count} duration={420} />
      </span>
    </div>
  )
}

function Pill({ name }: { name: Who }) {
  return (
    <span className="uc-pill">
      <WheelMark size={12} />
      <Roll>{name === 'julio' ? 'Julio' : 'Ana'}</Roll>
    </span>
  )
}

function Mine({ s }: { s: S }) {
  const needs = s.closed ? 1 : 2
  const working = s.landed ? 3 : 2
  const doneN = s.settled ? 1 : 2
  return (
    <div className="uc-sections">
      <Section dot="wait" label="Needs you" count={needs} />
      <Collapse open={!s.closed}>
        <div className="uc-src" data-gone={s.gone || undefined} data-target="src-row">
          <Row
            lead={<Agent k="Cx" />}
            title="Level 3 layout"
            head="src-head"
            hidden={s.gone}
            right={<span className="uc-age">2m</span>}
          >
            <span className="uc-reason">Codex wants to run</span>
            <span className="uc-act">
              <span className="uc-mono uc-cmd">pnpm add -D tiled-map</span>
              <span className="uc-btn" data-target="allow">Allow once</span>
            </span>
          </Row>
        </div>
      </Collapse>
      <Row lead={<Agent k="H" />} title="Release 0.4.2" right={<span className="uc-age">9m</span>}>
        <span className="uc-reason uc-clip">Hermes asks: ship to playtest-pc now, or after Ana checks it?</span>
      </Row>

      <Section dot="work" label="Working" count={working} target="work-sec" />
      <Collapse open={s.room}>
        <div className="uc-dst" data-landed={s.landed || undefined}>
          <Row lead={<Agent k="Cx" />} title="Level 3 layout" head="dst-head" hidden={!s.landed}>
            <Run who="Codex" where="playtest-pc" base={0} sec={s.landed ? Math.max(0, s.sec - s.t0) : 0} />
          </Row>
        </div>
      </Collapse>
      <Row
        lead={<Person name="Julio" />}
        title="Fix double jump on ledges"
        focus={s.focus === 'fix'}
        right={
          <span className="uc-pill uc-pill--row">
            <WheelMark size={12} />
            <Roll>{s.name === 'julio' ? 'Julio' : 'Ana'}</Roll>
          </span>
        }
      >
        <Run who="Claude Code" where="build-linux" base={252} sec={s.sec} />
        <Run who="Codex" where="julio-mbp" base={97} sec={s.sec} />
      </Row>
      <Row lead={<Agent k="CC" />} title="Try Vite 7 on the website" chip={<span className="uc-chip">Unfiled</span>}>
        <Run who="Claude Code" where="julio-mbp" base={48} sec={s.sec} />
      </Row>

      <Section dot="done" label="Done" count={doneN} />
      <Collapse open={!s.settled}>
        <Row lead={<Agent k="GB" />} title="Coyote time tuning" focus={s.focus === 'coyote'} right={<span className="uc-age">1h</span>}>
          <span className="uc-reason">Worked 6m, changed 3 files, 6 tests pass</span>
        </Row>
      </Collapse>
      <Row lead={<Agent k="Cx" />} title="Fix footer links" right={<span className="uc-age">3h</span>}>
        <span className="uc-reason">PR #41 merged, settles on its own</span>
      </Row>
    </div>
  )
}

function Team() {
  return (
    <div className="uc-sections">
      <Section dot="wait" label="Needs someone" count={1} />
      <Row lead={<Person name="Diego" />} title="Menu music loop" right={<span className="uc-age">5m</span>}>
        <span className="uc-reason">Claude Code is waiting on Diego</span>
      </Row>
      <Section dot="work" label="Working" count={4} />
      <Row lead={<Person name="Ana" />} title="Pricing page copy" right={<span className="uc-age">22m</span>}>
        <span className="uc-reason">Ana is driving Codex</span>
      </Row>
      {[148, 112, 176].map((w, i) => (
        <div className="uc-row uc-row--bar" key={i}>
          <span className="uc-head">
            <Avatar plain size={20} />
            <Bar w={w} h={6} tone={3} />
          </span>
          <span className="uc-right" />
          <div className="uc-sub">
            <Bar w={w - 40} h={5} tone={2} />
          </div>
        </div>
      ))}
    </div>
  )
}

function Sidebar({ s }: { s: S }) {
  const needs = s.closed ? 1 : 2
  return (
    <div className="uc-side">
      <div className="uc-team">
        <Text>Nuko Nova</Text>
        <ChevronDown size={13} strokeWidth={1.75} className="uc-i" />
      </div>
      <div className="uc-nav" data-active>
        <InboxIcon size={15} strokeWidth={1.75} className="uc-i" />
        <Text>Inbox</Text>
        <span className="uc-badge">
          <Count value={needs} duration={420} />
        </span>
      </div>
      <div className="uc-group">Projects</div>
      {[
        ['Reef Runner', '#5fb8c9'],
        ['Website', '#d08a5e'],
        ['Ops', '#9aa6b5'],
      ].map(([n, c]) => (
        <div className="uc-nav" key={n}>
          <i className="uc-sq" style={{ background: c }} />
          <Text>{n}</Text>
        </div>
      ))}
      <div className="uc-group">Channels</div>
      <div className="uc-nav">
        <Hash size={15} strokeWidth={1.75} className="uc-i" />
        <Text>general</Text>
      </div>
      <div className="uc-nav">
        <Volume2 size={15} strokeWidth={1.75} className="uc-i" />
        <Text>Standup</Text>
        <Facepile names={['Julio', 'Ana']} size={16} className="uc-pile" />
      </div>
      <div className="uc-call">
        <div className="uc-call__t">
          <span className="uc-call__k">In call</span>
          <Text className="uc-call__n">Standup</Text>
        </div>
        <span className="uc-mic">
          <Mic size={14} strokeWidth={1.75} />
        </span>
      </div>
    </div>
  )
}

function Keys({ hint }: { hint: S['hint'] }) {
  const k = (key: S['hint'], label: string) => (
    <span className="uc-k" data-on={hint === key || undefined}>
      <kbd>{key}</kbd>
      {label}
    </span>
  )
  return (
    <div className="uc-keys">
      {k('S', 'Settle')}
      {k('H', 'Snooze')}
      {k('A', 'Allow')}
      {k('W', 'Pass the wheel')}
    </div>
  )
}

function Thread({ s }: { s: S }) {
  return (
    <div className="uc-thread">
      <div className="uc-rest" data-target="rest" />
      <div className="uc-t-title">Fix double jump on ledges</div>
      <div className="uc-t-proj">
        <i className="uc-sq" style={{ background: '#5fb8c9' }} />
        Reef Runner
      </div>
      <div className="uc-t-people">
        <Person name="Julio" size={24} />
        <Person name="Ana" size={24} />
        <Person name="Diego" size={24} />
        <div className="uc-float" style={{ transform: `translateX(${s.driver === 'julio' ? 0 : 42}px)` }}>
          <Pill name={s.name} />
        </div>
      </div>
      <div className="uc-t-log">
        <div className="uc-t-msg">
          <Person name="Julio" size={18} />
          <span className="uc-t-lines">
            <Bar w={150} h={5} tone={3} />
            <Bar w={104} h={5} tone={3} />
          </span>
        </div>
        <div className="uc-t-msg">
          <Agent k="CC" />
          <span className="uc-t-lines">
            <span className="uc-t-live">
              <i className="uc-live" aria-hidden />
              Working
            </span>
            <span className="uc-t-step">Read movement.ts</span>
            <span className="uc-t-step">Running tests</span>
            <span className="uc-term">
              <span>$ pnpm test movement</span>
              <span className="uc-term__ok">3 passed</span>
            </span>
          </span>
        </div>
        <div className="uc-t-msg">
          <Person name="Ana" size={18} />
          <span className="uc-t-lines">
            <Bar w={132} h={5} tone={3} />
            <Bar w={86} h={5} tone={3} />
          </span>
        </div>
        <Collapse open={s.back} reveal="drop">
          <div className="uc-t-note">
            <WheelMark size={12} />
            Ana passed the wheel back
          </div>
        </Collapse>
      </div>
      <div className="uc-compose">
        <WheelMark size={14} />
        <Roll>{s.name === 'julio' ? "You're driving" : 'Ana is driving'}</Roll>
      </div>
    </div>
  )
}

function Scene({ s }: { s: S }) {
  return (
    <>
      <Window
        className="uc-win"
        sidebar={<Sidebar s={s} />}
        sidebarWidth={176}
        lead={
          <div className="uc-bar">
            <span className="uc-h">Inbox</span>
            <Segmented items={['Mine', 'Team']} value={s.tab} targets={['tab-mine', 'tab-team']} className="uc-seg" />
            <span className="uc-group-by">Group by project</span>
          </div>
        }
      >
        <div className="uc-main">
          <div className="uc-list">
            <div className="uc-pages">
              <div className="uc-page" data-on={s.tab === 0 || undefined}>
                <Mine s={s} />
              </div>
              <div className="uc-page" data-on={s.tab === 1 || undefined}>
                <Team />
              </div>
            </div>
            <Keys hint={s.hint} />
          </div>
          <Thread s={s} />
        </div>
      </Window>

      {s.fly && (
        <Fly from={s.fly.from} to={s.fly.to} go={s.fly.go} duration={800}>
          <span className="uc-head uc-head--fly">
            <Agent k="Cx" />
            <span className="uc-title">Level 3 layout</span>
          </span>
        </Fly>
      )}
    </>
  )
}

export default function UplinkR2C() {
  return (
    <Stage<S>
      width={780}
      height={580}
      theme="dark"
      accent="#4C7DFF"
      initial={initial}
      poster={initial}
      script={script}
      keys="bottom-right"
      cursor={{ at: REST }}
      className="uc"
    >
      {(s) => <Scene s={s} />}
    </Stage>
  )
}
