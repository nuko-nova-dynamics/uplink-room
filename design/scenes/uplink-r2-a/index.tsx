import { Check, ChevronDown, Hash, Inbox, Mic, Volume2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Avatar, Collapse, Count, Facepile, Segmented, Stage, States, Window, clock, type Act } from '../../kit'
import './a.css'

// Uplink Room, round 2, direction A "Needs you". The brand is the attention
// signal: neutrals and quiet run-state colors, and one loud color, amber,
// which only ever means "this needs you". The amber dot is one object: it
// sits on the waiting row, on the Inbox count and on the app icon, and it
// leaves all three together when the Inbox reaches zero.
//
// Beats: Allow once on Codex's request moves that run to Working with a
// timer from 00:00; the focused Done row is settled with S; the merged pull
// request settles itself; Ship now answers Hermes, Needs you empties and the
// dot leaves (Inbox zero, held). Then new requests arrive and the dot comes
// back with them: the visible cause that returns the opening picture.
//
// Real strings: everything in the Inbox list and the sidebar labels; this is
// a brand comparison, so the screen is shown at realistic fidelity.

type S = { allowed: boolean; settled: boolean; footer: boolean; shipped: boolean; focus: boolean; back: 0 | 1 | 2 }
const START: S = { allowed: false, settled: false, footer: false, shipped: false, focus: false, back: 0 }
const REST = { at: 'rest', x: 0.5, y: 0.4 }

async function script(a: Act<S>) {
  await a.wait(1100)

  // 1. Allow once: Codex's run leaves Needs you and starts working
  a.mark('allow')
  await a.move({ at: 'allow', x: 0.42, y: 0.55 })
  await a.wait(200)
  await a.click()
  await a.set({ allowed: true })
  void a.move(REST)
  await a.wait(1300)

  // 2. The finished run is focused and settled from the keyboard
  a.mark('settle')
  await a.set({ focus: true })
  await a.wait(900)
  await a.key('s')
  await a.set({ settled: true, focus: false })
  await a.wait(800)

  // 3. The merged pull request settles on its own
  a.mark('auto')
  await a.set({ footer: true })
  await a.wait(1000)

  // 4. Answer Hermes: nothing needs you, the dot leaves everywhere at once
  a.mark('zero')
  await a.move({ at: 'ship', x: 0.5, y: 0.55 })
  await a.wait(200)
  await a.click()
  await a.set({ shipped: true })
  void a.move(REST)
  await a.wait(2400)

  // 5. New requests arrive and bring the dot back; finished runs land in Done
  a.mark('back')
  await a.set({ back: 1 })
  await a.wait(500)
  await a.set({ back: 2 })
  await a.wait(1500)
  // The picture now matches the opening one; snapping to it changes nothing
  await a.snap(START)
}

function useRunClock(run: boolean) {
  const [s, setS] = useState(0)
  useEffect(() => {
    if (!run) {
      setS(0)
      return
    }
    const slow = (window as unknown as { __stageshow?: { slow?: number } }).__stageshow?.slow ?? 1
    const t0 = clock.now()
    let id = 0
    const tick = () => {
      setS(Math.floor((clock.now() - t0) / 1000 / slow))
      id = clock.raf(tick)
    }
    id = clock.raf(tick)
    return () => clock.cancelRaf(id)
  }, [run])
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

type Mark = 'wait' | 'work' | 'done'

function StateMark({ kind }: { kind: Mark }) {
  if (kind === 'wait') return <span className="ra-mark ra-mark--wait" aria-label="Needs you" />
  if (kind === 'done') {
    return (
      <svg className="ra-mark ra-mark--done" width="14" height="14" viewBox="0 0 14 14" aria-label="Done">
        <circle cx="7" cy="7" r="6" />
        <path d="M4.3 7.2 6.1 9l3.6-3.8" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg className="ra-mark ra-mark--work" width="14" height="14" viewBox="0 0 14 14" aria-label="Working">
      <circle cx="7" cy="7" r="5.25" fill="none" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2" />
    </svg>
  )
}

function Agent({ initials }: { initials: string }) {
  return <span className="ra-agent">{initials}</span>
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ra-kbd">{children}</kbd>
}

function Item({ mark, who, title, chip, reason, right, focus }: { mark: Mark; who: ReactNode; title: string; chip?: ReactNode; reason: ReactNode; right?: ReactNode; focus?: boolean }) {
  return (
    <div className="ra-row" data-focus={focus || undefined} data-kind={mark}>
      <StateMark kind={mark} />
      <span className="ra-who">{who}</span>
      <div className="ra-text">
        <div className="ra-title">
          <span>{title}</span>
          {chip}
        </div>
        <div className="ra-reason">{reason}</div>
      </div>
      <div className="ra-right">{right}</div>
    </div>
  )
}

function SectionHead({ label, n }: { label: string; n: number }) {
  return (
    <div className="ra-sec">
      <span>{label}</span>
      <span className="ra-sec__n" data-on={n > 0 || undefined}>
        <Count value={Math.max(n, 1)} duration={450} />
      </span>
    </div>
  )
}

function Empty({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <Collapse open={open}>
      <div className="ra-empty">{children}</div>
    </Collapse>
  )
}

function CodexWorking({ on }: { on: boolean }) {
  const t = useRunClock(on)
  return (
    <Item
      mark="work"
      who={<Agent initials="Cx" />}
      title="Level 3 layout"
      chip={<span className="ra-chip">Reef Runner</span>}
      reason={<>Allowed once. Installing <span className="ra-mono">tiled-map</span></>}
      right={<span className="ra-time ra-mono">{t}</span>}
    />
  )
}

function HermesWorking({ on }: { on: boolean }) {
  const t = useRunClock(on)
  return (
    <Item
      mark="work"
      who={<Agent initials="He" />}
      title="Release 0.4.2"
      chip={<span className="ra-chip">Ops</span>}
      reason={<>Shipping to <span className="ra-mono">playtest-pc</span></>}
      right={<span className="ra-time ra-mono">{t}</span>}
    />
  )
}

function Sidebar({ needs }: { needs: number }) {
  return (
    <nav className="ra-side">
      <div className="ra-team">
        <span>Nuko Nova</span>
        <ChevronDown size={13} strokeWidth={1.8} />
      </div>
      <div className="ra-nav" data-active>
        <Inbox size={15} strokeWidth={1.6} />
        <span>Inbox</span>
        <span className="ra-pill" data-on={needs > 0 || undefined}>
          <Count value={Math.max(needs, 1)} duration={450} />
        </span>
      </div>
      <div className="ra-group">Projects</div>
      {[
        ['Reef Runner', '#8796b4'],
        ['Website', '#7ea590'],
        ['Ops', '#a99484'],
      ].map(([name, color]) => (
        <div key={name} className="ra-nav">
          <span className="ra-sq" style={{ background: color }} />
          <span>{name}</span>
        </div>
      ))}
      <div className="ra-group">Channels</div>
      <div className="ra-nav">
        <Hash size={15} strokeWidth={1.6} />
        <span>general</span>
      </div>
      <div className="ra-nav">
        <Volume2 size={15} strokeWidth={1.6} />
        <span>Standup</span>
        <Facepile names={['Julio', 'Ana']} size={16} overlap={4} className="ra-pile" />
      </div>
      <div className="ra-rest" data-target="rest" />
      <div className="ra-call">
        <div className="ra-call__text">
          <span className="ra-call__live">In call</span>
          <span>Standup</span>
        </div>
        <span className="ra-mic">
          <Mic size={14} strokeWidth={1.8} />
        </span>
      </div>
    </nav>
  )
}

export function AppIcon({ size = 48, dot = true }: { size?: number; dot?: boolean }) {
  return (
    <span className="ra-icon" style={{ width: size, height: size, ['--s' as string]: `${size}px` }}>
      <span className="ra-icon__u">u</span>
      <span className="ra-icon__dot" data-on={dot || undefined} />
    </span>
  )
}

export default function DirectionA() {
  return (
    <Stage<S> width={800} height={520} theme="dark" fidelity="realistic" initial={START} poster={START} script={script} cursor={{ at: REST, style: 'real' }} className="ra">
      {(s) => {
        const back1 = s.back >= 1
        const back2 = s.back >= 2
        const codexNeeds = !s.allowed || back1
        const codexWorking = s.allowed && !back1
        const hermesNeeds = !s.shipped || back1
        const hermesWorking = s.shipped && !back1
        const coyote = !s.settled || back2
        const footer = !s.footer || back2
        const needs = Number(codexNeeds) + Number(hermesNeeds)
        const done = Number(coyote) + Number(footer)
        const working = 2 + Number(codexWorking) + Number(hermesWorking)
        const zero = needs === 0 && done === 0
        return (
          <>
            <Window
              className="ra-win"
              sidebar={<Sidebar needs={needs} />}
              sidebarWidth={172}
              lead={
                <span className="ra-lead">
                  <span className="ra-h">Inbox</span>
                  <Segmented items={['Mine', 'Team']} value={0} className="ra-seg" />
                  <span className="ra-zero" data-on={zero || undefined}>
                    <Check size={13} strokeWidth={2} />
                    Inbox zero
                  </span>
                </span>
              }
              toolbar={<span className="ra-grp">Group by project</span>}
            >
              <div className="ra-main">
                <div className="ra-list">
                  <SectionHead label="Needs you" n={needs} />
                  <Collapse open={codexNeeds}>
                    <Item
                      mark="wait"
                      who={<Agent initials="Cx" />}
                      title="Level 3 layout"
                      chip={<span className="ra-chip">Reef Runner</span>}
                      reason={<>Codex wants to run <span className="ra-mono ra-cmd">pnpm add -D tiled-map</span></>}
                      right={
                        <>
                          <span className="ra-time">2m</span>
                          <span className="ra-btn ra-btn--primary" data-target="allow" data-cursor="pointer">
                            Allow once <Kbd>A</Kbd>
                          </span>
                        </>
                      }
                    />
                  </Collapse>
                  <Collapse open={hermesNeeds}>
                    <Item
                      mark="wait"
                      who={<Agent initials="He" />}
                      title="Release 0.4.2"
                      chip={<span className="ra-chip">Ops</span>}
                      reason="Hermes asks: ship to playtest-pc now, or after Ana checks it?"
                      right={
                        <>
                          <span className="ra-time">9m</span>
                          <span className="ra-btn" data-target="ship" data-cursor="pointer">Ship now</span>
                        </>
                      }
                    />
                  </Collapse>
                  <Empty open={needs === 0}>Nothing needs you.</Empty>

                  <SectionHead label="Working" n={working} />
                  <Collapse open={hermesWorking}>
                    <HermesWorking on={hermesWorking} />
                  </Collapse>
                  <Collapse open={codexWorking}>
                    <CodexWorking on={codexWorking} />
                  </Collapse>
                  <Item
                    mark="work"
                    who={<Avatar name="Julio" size={20} />}
                    title="Fix double jump on ledges"
                    chip={<span className="ra-chip">Reef Runner</span>}
                    reason={
                      <span className="ra-runs">
                        <span>Claude Code <span className="ra-mono">build-linux</span> <span className="ra-mono ra-dim">4m</span></span>
                        <span>Codex <span className="ra-mono">julio-mbp</span> <span className="ra-mono ra-dim">1m</span></span>
                      </span>
                    }
                    right={<span className="ra-time">2 runs</span>}
                  />
                  <Item
                    mark="work"
                    who={<Agent initials="CC" />}
                    title="Try Vite 7 on the website"
                    chip={<span className="ra-chip ra-chip--unfiled">Unfiled</span>}
                    reason={<>Started in T3 Code on <span className="ra-mono">julio-mbp</span></>}
                    right={<span className="ra-time">13m</span>}
                  />

                  <SectionHead label="Done" n={done} />
                  <Collapse open={coyote}>
                    <Item
                      mark="done"
                      focus={s.focus}
                      who={<Agent initials="GB" />}
                      title="Coyote time tuning"
                      chip={<span className="ra-chip">Reef Runner</span>}
                      reason="Worked 6m, changed 3 files, 6 tests pass"
                      right={
                        <States
                          value={s.focus ? 'keys' : 'time'}
                          align="end"
                          states={{
                            time: <span className="ra-time">1h</span>,
                            keys: (
                              <span className="ra-hints">
                                <Kbd>S</Kbd> Settle <Kbd>H</Kbd> Snooze
                              </span>
                            ),
                          }}
                        />
                      }
                    />
                  </Collapse>
                  <Collapse open={footer}>
                    <Item
                      mark="done"
                      who={<Agent initials="Cx" />}
                      title="Fix footer links"
                      chip={<span className="ra-chip">Website</span>}
                      reason="PR #41 merged, settles on its own"
                      right={<span className="ra-time">3h</span>}
                    />
                  </Collapse>
                  <Empty open={done === 0}>Nothing to settle.</Empty>
                </div>
              </div>
            </Window>
            <div className="ra-corner">
              <AppIcon size={52} dot={needs > 0} />
            </div>
          </>
        )
      }}
    </Stage>
  )
}
