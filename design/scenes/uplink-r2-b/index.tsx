import { ChevronDown, Hash, Inbox, Mic, Volume2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Bar, Collapse, Count, Segmented, Stage, States, Window, type Act } from '../../kit'
import './room.css'

// Round 2, direction B, "The room": people and agents in one room. Warm dark,
// presence first. Uplink Room's Inbox (Needs you, Working, Done) with the
// call block live in the sidebar.
//
// Beats: calm, Julio speaking in Standup; Julio allows Codex's command, so
// "Level 3 layout" leaves Needs you and opens at the top of Working with a
// fresh timer while the counts roll; he settles "Coyote time tuning" with S;
// Hermes joins the call, its square tile sliding in beside the two faces,
// and the speaking ring passes to Ana. Reset: he looks at Team (the Mine list
// is restored under it), Hermes leaves the call, he comes back to Mine.
//
// Real strings: the Inbox, its sections and rows (the subject), the call
// block. Sidebar projects and channels are real because the brief names them;
// the Team view is mostly placeholder.

type S = {
  allowing: boolean
  allowed: boolean
  allowAt: number
  hover: boolean
  settled: boolean
  hermes: boolean
  speaker: 'julio' | 'ana'
  sec: number
  tab: number
}

const initial: S = { allowing: false, allowed: false, allowAt: 0, hover: false, settled: false, hermes: false, speaker: 'julio', sec: 0, tab: 0 }
const REST = { at: 'rest', x: 0.5, y: 0.5 }

let generation = 0

async function script(a: Act<S>) {
  const gen = ++generation
  let sec = 0
  // Live timers: one tick a second on the stage's own clock
  ;(async () => {
    while (gen === generation) {
      await a.wait(1000)
      if (gen !== generation) break
      sec += 1
      a.put({ sec })
    }
  })()

  await a.wait(1500)

  // 1. Allow Codex's command
  a.mark('allow')
  await a.move({ at: 'allow', x: 0.42, y: 0.6 })
  await a.click()
  a.put({ allowing: true })
  await a.wait(500)
  a.put({ allowed: true, allowAt: sec })
  await a.wait(1700)

  // 2. Settle the done row with S
  a.mark('settle')
  await a.move({ at: 'done1', x: 0.55, y: 0.55 })
  a.put({ hover: true })
  await a.wait(800)
  await a.key('s')
  a.put({ settled: true, hover: false })
  await a.wait(900)

  // 3. Presence: Hermes joins the call, Ana starts talking
  a.mark('call')
  void a.move(REST)
  a.put({ hermes: true })
  await a.wait(1100)
  a.put({ speaker: 'ana' })
  await a.wait(2600)

  // 4. Reset with a cause: look at Team, Hermes leaves, back to Mine
  a.mark('team')
  await a.move({ at: 'tab-team', x: 0.6, y: 0.55 })
  await a.click()
  a.put({ tab: 1 })
  await a.wait(500)
  // Under the Team view: stop the clocks and restore the Mine list unseen
  generation += 1
  await a.snap({ allowing: false, allowed: false, allowAt: 0, settled: false, hover: false, sec: 0 })
  a.put({ hermes: false })
  await a.wait(900)
  a.put({ speaker: 'julio' })
  await a.move({ at: 'tab-mine', x: 0.6, y: 0.55 })
  await a.click()
  a.put({ tab: 0 })
  await a.wait(700)
  await a.move(REST)
}

const mmss = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

function Face({ name, color, size = 24 }: { name: string; color: string; size?: number }) {
  return (
    <span className="ur-face" style={{ width: size, height: size, background: color, fontSize: size < 24 ? 9.5 : 10.5 }}>
      {name[0]}
    </span>
  )
}

function Agent({ label, size = 24 }: { label: string; size?: number }) {
  return (
    <span className="ur-agent" style={{ width: size, height: size, fontSize: size < 24 ? 9 : 10 }}>
      {label}
    </span>
  )
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ur-kbd">{children}</kbd>
}

function Section({ state, label, count }: { state: 'wait' | 'work' | 'done'; label: string; count: number }) {
  return (
    <div className="ur-sec">
      <span className="ur-dot" data-state={state} />
      <span className="ur-sec__label">{label}</span>
      <span className="ur-sec__count"><Count value={count} duration={420} /></span>
    </div>
  )
}

function Item({ lead, title, chip, reason, side, target, hover }: { lead: ReactNode; title: string; chip?: ReactNode; reason: ReactNode; side: ReactNode; target?: string; hover?: boolean }) {
  return (
    <div className="ur-row" data-target={target} data-hover={hover || undefined}>
      {lead}
      <div className="ur-row__text">
        <div className="ur-row__title">
          <span>{title}</span>
          {chip}
        </div>
        <div className="ur-row__reason">{reason}</div>
      </div>
      <div className="ur-row__side">{side}</div>
    </div>
  )
}

function Run({ who, machine, time }: { who: string; machine: string; time: string }) {
  return (
    <span className="ur-run">
      <Agent label={who === 'Claude Code' ? 'CC' : 'Cx'} size={16} />
      <span className="ur-run__who">{who}</span>
      <span className="ur-mono ur-faint">{machine}</span>
      <span className="ur-mono ur-live">{time}</span>
    </span>
  )
}

function Mine({ s }: { s: S }) {
  const t = (base: number) => mmss(base + s.sec)
  return (
    <div className="ur-list">
      <Section state="wait" label="Needs you" count={s.allowed ? 1 : 2} />
      <Collapse open={!s.allowed}>
        <Item
          lead={<Agent label="Cx" />}
          title="Level 3 layout"
          chip={<span className="ur-chip">Reef Runner</span>}
          reason={<>Codex wants to run <code className="ur-mono ur-code">pnpm add -D tiled-map</code></>}
          target="needs1"
          side={
            <>
              <span className="ur-time">2m</span>
              <States
                value={s.allowing ? 'ok' : 'ask'}
                align="end"
                className="ur-allow-slot"
                states={{
                  ask: <span className="ur-btn ur-btn--primary" data-target="allow">Allow once <Kbd>A</Kbd></span>,
                  ok: <span className="ur-btn ur-btn--done">Allowed</span>,
                }}
              />
            </>
          }
        />
      </Collapse>
      <Item
        lead={<Agent label="He" />}
        title="Release 0.4.2"
        chip={<span className="ur-chip">Ops</span>}
        reason="Hermes asks: ship to playtest-pc now, or after Ana checks it?"
        side={<span className="ur-time">9m</span>}
      />

      <Section state="work" label="Working" count={s.allowed ? 3 : 2} />
      <Collapse open={s.allowed} reveal="drop">
        <Item
          lead={<Agent label="Cx" />}
          title="Level 3 layout"
          chip={<span className="ur-chip">Reef Runner</span>}
          reason={<>Running <code className="ur-mono ur-code">pnpm add -D tiled-map</code></>}
          side={<span className="ur-mono ur-live">{mmss(Math.max(0, s.sec - s.allowAt))}</span>}
        />
      </Collapse>
      <div className="ur-row ur-row--task">
        <Face name="Julio" color="#E8B04B" />
        <div className="ur-row__text">
          <div className="ur-row__title"><span>Fix double jump on ledges</span><span className="ur-chip">Reef Runner</span></div>
          <div className="ur-runs">
            <Run who="Claude Code" machine="build-linux" time={t(252)} />
            <Run who="Codex" machine="julio-mbp" time={t(97)} />
          </div>
        </div>
        <div className="ur-row__side"><span className="ur-time">14m</span></div>
      </div>
      <Item
        lead={<Agent label="CC" />}
        title="Try Vite 7 on the website"
        chip={<span className="ur-chip ur-chip--unfiled">Unfiled</span>}
        reason="Claude Code on julio-mbp"
        side={<span className="ur-mono ur-live">{t(41)}</span>}
      />

      <Section state="done" label="Done" count={s.settled ? 1 : 2} />
      <Collapse open={!s.settled}>
        <Item
          lead={<Agent label="GB" />}
          title="Coyote time tuning"
          reason="Worked 6m, changed 3 files, 6 tests pass"
          target="done1"
          hover={s.hover}
          side={
            <States
              value={s.hover ? 'keys' : 'time'}
              align="end"
              states={{
                time: <span className="ur-time">1h</span>,
                keys: <span className="ur-hints"><Kbd>S</Kbd>Settle<Kbd>H</Kbd>Snooze</span>,
              }}
            />
          }
        />
      </Collapse>
      <Item
        lead={<Agent label="Cx" />}
        title="Fix footer links"
        reason="PR #41 merged, settles on its own"
        side={<span className="ur-time">3h</span>}
      />
    </div>
  )
}

function Team() {
  return (
    <div className="ur-list">
      <Section state="wait" label="Needs someone" count={1} />
      <Item lead={<Face name="Diego" color="#7FB8A4" />} title="Menu music loop" reason="Claude Code is waiting on Diego" side={<span className="ur-time">5m</span>} />
      <Section state="work" label="Working" count={4} />
      <Item lead={<Face name="Ana" color="#D98C6A" />} title="Pricing page copy" reason="Ana is driving Codex" side={<span className="ur-time">22m</span>} />
      {[178, 132, 156].map((w, i) => (
        <div key={i} className="ur-row">
          <span className="ur-face ur-face--plain" />
          <div className="ur-row__text ur-bars"><Bar w={w} h={6} tone={3} /><Bar w={w * 0.7} h={5} tone={2} /></div>
          <div className="ur-row__side"><Bar w={26} h={5} tone={2} /></div>
        </div>
      ))}
    </div>
  )
}

function Sidebar({ s }: { s: S }) {
  const inCall = s.hermes ? 3 : 2
  return (
    <div className="ur-side">
      <div className="ur-team">
        <span>Nuko Nova</span>
        <ChevronDown size={13} strokeWidth={1.8} />
      </div>
      <div className="ur-nav" data-active>
        <Inbox size={15} strokeWidth={1.6} />
        <span>Inbox</span>
        <span className="ur-nav__count"><Count value={s.allowed ? 1 : 2} duration={420} /></span>
      </div>
      <div className="ur-group">Projects</div>
      {[
        ['Reef Runner', '#8AB4F8'],
        ['Website', '#7BC89A'],
        ['Ops', '#D98C6A'],
      ].map(([n, c]) => (
        <div key={n} className="ur-nav">
          <span className="ur-swatch" style={{ background: c }} />
          <span>{n}</span>
        </div>
      ))}
      <div className="ur-group">Channels</div>
      <div className="ur-nav">
        <Hash size={15} strokeWidth={1.6} />
        <span>general</span>
      </div>
      <div className="ur-nav" data-live>
        <Volume2 size={15} strokeWidth={1.6} />
        <span>Standup</span>
        <span className="ur-nav__meta"><Count value={inCall} duration={420} /></span>
      </div>

      <div className="ur-call">
        <div className="ur-call__head">
          <span className="ur-call__live">In call</span>
          <span className="ur-call__name">Standup</span>
        </div>
        <div className="ur-call__row">
          <span className="ur-call__faces">
            <span className="ur-speak" data-on={s.speaker === 'julio' || undefined}><Face name="Julio" color="#E8B04B" size={28} /></span>
            <span className="ur-speak" data-on={s.speaker === 'ana' || undefined}><Face name="Ana" color="#D98C6A" size={28} /></span>
            <span className="ur-join" data-in={s.hermes || undefined}>
              <span className="ur-join__tile"><Agent label="He" size={28} /></span>
            </span>
          </span>
          <span className="ur-mic" aria-label="Mute">
            <Mic size={15} strokeWidth={1.7} />
          </span>
        </div>
      </div>
    </div>
  )
}

export default function UplinkRoomB() {
  return (
    <Stage<S>
      width={760}
      height={540}
      theme="dark"
      initial={initial}
      poster={initial}
      script={script}
      keys="bottom-right"
      cursor={{ at: REST }}
      className="ur"
    >
      {(s) => (
        <Window
          className="ur-win"
          sidebar={<Sidebar s={s} />}
          sidebarWidth={204}
          lead={
            <div className="ur-head">
              <span className="ur-head__title">Inbox</span>
              <Segmented items={['Mine', 'Team']} value={s.tab} targets={['tab-mine', 'tab-team']} className="ur-seg" />
              <span className="ur-ghost">Group by project</span>
            </div>
          }
        >
          <div className="ur-body">
            <div className="ur-views">
              <div className="ur-view" data-show={s.tab === 0 || undefined}><Mine s={s} /></div>
              <div className="ur-view" data-show={s.tab === 1 || undefined}><Team /></div>
            </div>
            <span className="ur-rest" data-target="rest" />
          </div>
        </Window>
      )}
    </Stage>
  )
}
