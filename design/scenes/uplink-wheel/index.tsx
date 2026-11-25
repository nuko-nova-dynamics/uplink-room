import { KeyRound, ShieldCheck, ShipWheel, type LucideIcon } from 'lucide-react'
import { Bar, Collapse, Fly, Popover, Spinner, Stage, Swap, Text, Window, type Act, type Rect } from '../../kit'
import './wheel.css'

// Uplink Room, Q9: people are round, agents are square, and the driver
// carries one wheel mark. A thread window with the team sidebar. Beats:
// the cursor rests on Hermes and its card says who added it and what it
// may do; Ana asks for the wheel; Julio passes it and the wheel flies from
// his avatar to hers while the composer turns to suggesting; after a hold,
// Ana passes it back, which is the loop's reset.
//
// Real strings: the thread title, the two messages, the member names, the
// hover card, the request and the composer. The nav above the members is
// placeholder.

type Who = 'julio' | 'ana'
type S = {
  hover: boolean
  ask: boolean
  back: boolean
  driver: Who | null
  seat: Who
  fly: null | { from: Rect; to: Rect; go: boolean }
}

const initial: S = { hover: false, ask: false, back: false, driver: 'julio', seat: 'julio', fly: null }
const poster: S = { ...initial, driver: 'ana', seat: 'ana' }

async function pass(a: Act<S>, from: Who, to: Who, extra: Partial<S>) {
  const f = a.rect(`wheel-${from}`, { layout: true })
  const t = a.rect(`wheel-${to}`, { layout: true })
  // The source hides in the set that sends the flyer; the composer answers at once
  await a.set({ ...extra, driver: null, seat: to, fly: { from: f, to: t, go: true } })
  await a.wait(900)
  await a.set({ driver: to, fly: null })
}

async function script(a: Act<S>) {
  await a.wait(1000)
  a.mark('hover')
  await a.move({ at: 'row-hermes', x: 0.72, y: 0.5 })
  await a.set({ hover: true })
  await a.wait(2800)
  await a.move({ at: 'rest', x: 0.5, y: 0.5 })
  await a.set({ hover: false })
  await a.wait(500)

  a.mark('ask')
  await a.set({ ask: true })
  await a.wait(1300)
  await a.move({ at: 'pass', x: 0.82, y: 0.62 })
  await a.wait(220)
  await a.click()
  a.mark('pass')
  await pass(a, 'julio', 'ana', { ask: false })
  await a.move({ at: 'rest', x: 0.6, y: 0.4 })
  await a.wait(2400)

  // The reset has a cause: Ana hands the wheel back
  a.mark('back')
  await a.set({ back: true })
  await a.wait(600)
  await pass(a, 'ana', 'julio', {})
  await a.wait(1400)
  await a.set({ back: false })
  // Back to where the loop began, so the seam is still
  await a.move(a.layout === 'compact' ? { x: 300, y: 120 } : { x: 560, y: 150 })
  await a.wait(500)
}

function I({ icon: Glyph, size = 14 }: { icon: LucideIcon; size?: number }) {
  return <Glyph size={size} strokeWidth={1.75} className="uw-i" aria-hidden />
}

// People are round, agents are square: the shape says it before the name
function Face({ name, kind, size = 22, hue }: { name: string; kind: 'person' | 'agent'; size?: number; hue: string }) {
  return (
    <span className="uw-face" data-kind={kind} style={{ width: size, height: size, fontSize: Math.round(size * (name.length > 1 ? 0.36 : 0.45)), background: hue }}>
      <span className="uw-face__t">{name}</span>
    </span>
  )
}

// The wheel mark sits on the driver's avatar; every person has the slot so
// the flight can measure where it lands
function Wheel({ who, on }: { who: Who; on: boolean }) {
  return (
    <span className="uw-wheel" data-target={`wheel-${who}`} data-on={on || undefined}>
      <ShipWheel size={10} strokeWidth={2.4} aria-hidden />
    </span>
  )
}

const HUE = { julio: '#5b7fd1', ana: '#c0703f', diego: '#4f9a7a', hermes: '#3d4450', note: '#3d4450', deploy: '#3d4450', cc: '#4a3f37' }

function Member({ name, k, kind, hue, wheel, target }: { name: string; k: string; kind: 'person' | 'agent'; hue: string; wheel?: { who: Who; on: boolean }; target?: string }) {
  return (
    <div className="uw-member" data-target={target}>
      <span className="uw-member__av">
        <Face name={k} kind={kind} hue={hue} />
        {wheel && <Wheel who={wheel.who} on={wheel.on} />}
      </span>
      <Text className="uw-member__name">{name}</Text>
    </div>
  )
}

function Side({ s }: { s: S }) {
  return (
    <div className="uw-side">
      <div className="uw-nav">
        <Bar w={14} h={14} r={4} tone={2} />
        <Bar w={62} h={6} tone={2} />
      </div>
      <div className="uw-nav">
        <Bar w={14} h={14} r={4} tone={2} />
        <Bar w={80} h={6} tone={2} />
      </div>
      <div className="uw-sec">People</div>
      <Member name="Julio" k="J" kind="person" hue={HUE.julio} wheel={{ who: 'julio', on: s.driver === 'julio' }} />
      <Member name="Ana" k="A" kind="person" hue={HUE.ana} wheel={{ who: 'ana', on: s.driver === 'ana' }} />
      <Member name="Diego" k="D" kind="person" hue={HUE.diego} />
      <div className="uw-sec">Agents</div>
      <Member name="Hermes" k="H" kind="agent" hue={HUE.hermes} target="row-hermes" />
      <Member name="Notetaker" k="N" kind="agent" hue={HUE.note} />
      <Member name="Deploy bot" k="D" kind="agent" hue={HUE.deploy} />
    </div>
  )
}

function Card() {
  return (
    <div className="uw-card">
      <div className="uw-card__head">
        <Face name="H" kind="agent" size={32} hue={HUE.hermes} />
        <span className="uw-card__id">
          <Text className="uw-card__name">Hermes</Text>
          <Text className="uw-card__kind">Agent, connected over A2A</Text>
        </span>
      </div>
      <div className="uw-card__rows">
        <div className="uw-card__row">
          <Face name="J" kind="person" size={16} hue={HUE.julio} />
          <Text>Added by Julio, accountable</Text>
        </div>
        <div className="uw-card__row">
          <I icon={ShieldCheck} />
          <Text>Can do at most what Julio can</Text>
        </div>
        <div className="uw-card__row">
          <I icon={KeyRound} />
          <Text>2 agent keys</Text>
        </div>
      </div>
    </div>
  )
}

function Thread({ s }: { s: S }) {
  return (
    <div className="uw-thread">
      <div className="uw-msgs">
        <div className="uw-msg uw-msg--first">
          <Face name="J" kind="person" size={28} hue={HUE.julio} />
          <div className="uw-msg__body">
            <div className="uw-msg__meta">
              <Text className="uw-msg__name">Julio</Text>
              <Text className="uw-msg__time">10:41</Text>
            </div>
            <p className="uw-msg__text">Players can double jump after walking off a ledge. Find out why and fix it.</p>
          </div>
        </div>
        <div className="uw-msg">
          <Face name="CC" kind="agent" size={28} hue={HUE.cc} />
          <div className="uw-msg__body">
            <div className="uw-msg__meta">
              <Text className="uw-msg__name">Claude Code</Text>
              <span className="uw-tag">Harness</span>
              <Text className="uw-msg__time">10:42</Text>
            </div>
            <Text className="uw-msg__via">Run by Julio through T3 Code on build-linux</Text>
            <p className="uw-msg__text">The jump counter resets when the player leaves the ground. I'll reset it only on landing.</p>
          </div>
        </div>
      </div>

      <div className="uw-rest" data-target="rest" />

      <div className="uw-foot">
        <Collapse open={s.ask} reveal="drop">
          <div className="uw-ask">
            <Face name="A" kind="person" size={20} hue={HUE.ana} />
            <Text className="uw-ask__text">Ana asked for the wheel</Text>
            <span className="uw-grow" />
            <span className="uw-btn uw-btn--ghost">Not now</span>
            <span className="uw-btn uw-btn--primary" data-target="pass">Pass the wheel</span>
          </div>
        </Collapse>
        <Collapse open={s.back} reveal="drop">
          <div className="uw-ask uw-ask--note">
            <Face name="A" kind="person" size={20} hue={HUE.ana} />
            <Text className="uw-ask__text">Ana passed the wheel back to you</Text>
          </div>
        </Collapse>
        <div className="uw-compose" data-seat={s.seat}>
          <span className="uw-seat">
            <ShipWheel size={13} strokeWidth={2} aria-hidden />
            <Swap id={s.seat} duration={420}>
              <span className="uw-seat__t">{s.seat === 'julio' ? "You're driving" : 'Ana is driving'}</span>
            </Swap>
          </span>
          <Swap id={`p-${s.seat}`} duration={420} className="uw-ph">
            <span>{s.seat === 'julio' ? 'Message Claude Code' : 'Suggest a prompt for Ana to send'}</span>
          </Swap>
        </div>
      </div>
    </div>
  )
}

export default function UplinkWheel() {
  return (
    <Stage<S>
      width={720}
      height={400}
      compact={{ below: 640, width: 358, height: 360 }}
      theme="dark"
      initial={initial}
      poster={poster}
      script={script}
      cursor={{ at: { wide: { x: 560, y: 150 }, compact: { x: 300, y: 120 } } }}
      className="uw"
    >
      {(s, rect, layout) => {
        const row = rect('row-hermes')
        const compact = layout === 'compact'
        return (
          <>
            <Window
              className="uw-win"
              sidebarWidth={compact ? 132 : 188}
              sidebar={<Side s={s} />}
              title="Fix double jump on ledges"
              toolbar={
                <span className="uw-run">
                  <Spinner size={12} />
                  <span>Working</span>
                </span>
              }
            >
              <Thread s={s} />
            </Window>
            <Popover
              show={s.hover}
              origin={compact ? 'bottom left' : 'left center'}
              className="uw-pop"
              style={compact ? { left: row.x, top: row.y - 162 } : { left: row.x + row.width + 10, top: row.y + row.height / 2 - 78 }}
            >
              <Card />
            </Popover>
            {s.fly && (
              <Fly from={s.fly.from} to={s.fly.to} go={s.fly.go} duration={850}>
                <span className="uw-wheel uw-wheel--fly">
                  <ShipWheel size={10} strokeWidth={2.4} aria-hidden />
                </span>
              </Fly>
            )}
          </>
        )
      }}
    </Stage>
  )
}
