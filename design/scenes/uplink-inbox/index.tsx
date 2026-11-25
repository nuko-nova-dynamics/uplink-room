import { Bar, Collapse, Count, Expand, Icon, LockScreen, Notification, Phone, Spinner, Stage, States, Window, WALLPAPER, type Act } from '../../kit'
import './inbox.css'

// Q7 for Uplink Room: one inbox card, at desktop width and at phone width.
// Beats: the run is Working; it starts Waiting and its card drops into Julio's
// Inbox on the desktop while the count rolls up; the phone gets the
// notification; Julio opens it and taps Allow once on the phone-width card;
// the desktop card resolves and closes, the count rolls back, the run is
// Working again, and the phone locks. The lock is the visible cause of the
// reset, so the loop starts on the same picture it ends on.
//
// Real strings: Inbox and its count, the run's task, the card's title, task,
// command and buttons, the notification. Everything else is placeholder.

type S = { waiting: boolean; notif: boolean; open: boolean; allowed: boolean; resolved: boolean; locked: boolean }

const START: S = { waiting: false, notif: false, open: false, allowed: false, resolved: false, locked: false }
const REST = { x: 640, y: 400 }

const TITLE = 'Claude Code wants to run a command'
const TASK = 'Fix double jump on ledges'
const CMD = 'pnpm add -D vitest'

async function script(a: Act<S>) {
  await a.wait(900)
  a.mark('waiting')
  a.put({ waiting: true })
  await a.wait(1500)
  a.mark('notified')
  a.put({ notif: true })
  await a.wait(1500)
  a.mark('open')
  await a.click('notif', { x: 0.7, y: 0.5 } as never)
  a.put({ open: true })
  await a.wait(1700)
  a.mark('allow')
  await a.click('allow', { x: 0.75, y: 0.6 } as never)
  a.put({ allowed: true })
  await a.wait(900)
  a.mark('resolved')
  // The approval lands on the desktop: the card says so, then closes
  a.put({ resolved: true })
  await a.wait(1300)
  a.mark('locked')
  a.put({ locked: true })
  await a.wait(500)
  // Under the fading app: the notification was consumed
  a.put({ notif: false })
  await a.wait(1300)
  // Everything the loop added is gone from view; reset the rest unseen
  await a.snap({ waiting: false, open: false, allowed: false, resolved: false })
  await a.snap({ locked: false })
  await a.move(REST)
}

function RunMark({ waiting }: { waiting: boolean }) {
  return (
    <span className="ui-mark" data-waiting={waiting || undefined}>
      <span className="ui-mark__work"><Spinner size={14} /></span>
      <span className="ui-mark__wait"><Icon name="clock" filled size={14} /></span>
    </span>
  )
}

function Card({ phone, allowed, resolved }: { phone?: boolean; allowed: boolean; resolved?: boolean }) {
  const done = phone ? allowed : resolved
  return (
    <div className="ui-card" data-phone={phone || undefined}>
      <div className="ui-card__head">
        <Icon name="clock" filled size={phone ? 18 : 14} className="ui-card__icon" />
        <span className="ui-card__title">{TITLE}</span>
      </div>
      <div className="ui-card__task">{TASK}</div>
      <code className="ui-card__cmd">{CMD}</code>
      <States
        value={done ? 'done' : 'ask'}
        align="start"
        className="ui-card__actions"
        states={{
          ask: (
            <span className="ui-btns">
              <span className="ui-btn ui-btn--primary" data-target={phone ? 'allow' : undefined}>Allow once</span>
              <span className="ui-btn">Deny</span>
              <span className="ui-btn ui-btn--ghost">Open thread</span>
            </span>
          ),
          done: (
            <span className="ui-done">
              <Icon name="check" filled size={phone ? 16 : 14} />
              {phone ? 'Allowed' : 'Allowed from phone'}
            </span>
          ),
        }}
      />
    </div>
  )
}

function Side({ waiting, count }: { waiting: boolean; count: number }) {
  return (
    <nav className="ui-side">
      <div className="ui-nav" data-active>
        <Icon name="inbox" size={14} />
        <span className="ui-nav__label">Inbox</span>
        <span className="ui-count"><Count value={count} duration={500} /></span>
      </div>
      <div className="ui-nav"><Bar w={14} h={14} r={4} tone={2} /><Bar w={52} h={6} tone={2} /></div>
      <div className="ui-group">Reef Runner</div>
      <div className="ui-nav ui-nav--run">
        <RunMark waiting={waiting} />
        <span className="ui-nav__label ui-ellip">{TASK}</span>
      </div>
      {[64, 48, 58].map((w, i) => (
        <div key={i} className="ui-nav"><Bar w={13} h={13} r={7} tone={1} /><Bar w={w} h={6} tone={2} /></div>
      ))}
      <div className="ui-group"><Bar w={44} h={5} tone={1} /></div>
      {[56, 40].map((w, i) => (
        <div key={i} className="ui-nav"><Bar w={13} h={13} r={7} tone={1} /><Bar w={w} h={6} tone={2} /></div>
      ))}
    </nav>
  )
}

function Filler({ widths }: { widths: number[] }) {
  return (
    <>
      {widths.map((w, i) => (
        <div key={i} className="ui-filler">
          <Bar w={14} h={14} r={7} tone={1} />
          <Bar w={w} h={6} tone={2} />
          <Bar w={28} h={5} tone={1} style={{ marginLeft: 'auto' }} />
        </div>
      ))}
    </>
  )
}

function Notif(props: Record<string, unknown>) {
  return <Notification {...props} icon={<span className="ui-appicon"><Icon name="inbox" size={18} stroke={2} /></span>} title={TITLE} body={`${TASK}: ${CMD}`} />
}

export default function UplinkInbox() {
  return (
    <Stage<S>
      width={728}
      height={440}
      compact={{ below: 600, width: 358, height: 470 }}
      theme="dark"
      initial={START}
      poster={{ waiting: true, notif: true, open: true, allowed: false, resolved: false, locked: false }}
      script={script}
      cursor={{ at: { wide: REST, compact: { x: 300, y: 430 } }, style: 'touch' }}
      className="uiq"
    >
      {(s, rect, layout) => {
        const count = s.waiting && !s.resolved ? 2 : 1
        return (
          <>
            {layout === 'wide' && (
              <Window className="ui-win" sidebarWidth={136} sidebar={<Side waiting={s.waiting && !s.resolved} count={count} />}>
                <div className="ui-main">
                  <div className="ui-head">
                    <span className="ui-title">Inbox</span>
                  </div>
                  <div className="ui-list">
                    <Collapse open={s.waiting && !s.resolved} reveal="drop">
                      <div className="ui-slot">
                        <Card allowed={s.allowed} resolved={s.resolved || s.allowed} />
                      </div>
                    </Collapse>
                    <Filler widths={[132, 104]} />
                    <div className="ui-sub"><Bar w={52} h={5} tone={1} /></div>
                    <Filler widths={[118, 146, 92]} />
                  </div>
                </div>
              </Window>
            )}
            <Phone width={layout === 'compact' ? 300 : 276} frame="pro" dark wallpaper={WALLPAPER} className="ui-phone">
              <LockScreen size="satellite" stack="top">
                <Collapse open={s.notif} reveal="drop">
                  <Notif data-target="notif" />
                </Collapse>
              </LockScreen>
              <div className="ui-applayer" data-show={(s.open && !s.locked) || undefined}>
                <Expand open={s.open} from={rect('notif')} face={<Notif />} className="ui-expand">
                  <div className="ui-app">
                    <div className="ui-app__title">Inbox</div>
                    <Card phone allowed={s.allowed} />
                    <div className="ui-app__rows">
                      <Filler widths={[150, 118, 170]} />
                    </div>
                  </div>
                </Expand>
              </div>
            </Phone>
          </>
        )
      }}
    </Stage>
  )
}
