import { ChevronDown, ChevronRight, Folder, Hash, Inbox, Plus, SquareTerminal, Volume2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Bar, Facepile, Stage, Text, Window, type Layout } from '../../kit'
import './nav.css'

// Q8, the navigation model. One window, pinned a gutter in from the top-left,
// running off the right and bottom. The sidebar is the subject, so its labels
// are real words; the main pane shows the Inbox with words only on the first
// waiting item. Variant "rail" adds a Discord-style column of team tiles.
//
// Real strings: the team, Inbox, the Reef Runner project and its channel,
// runs, terminal and files, the two collapsed projects, the two channels that
// belong to no project, and the first Inbox item.
//
// Icons: lucide-react at 14px, stroke 1.7, the way the linear study uses it.
// The run-state marks are the product's own content geometry, like Linear's
// status circles.

type Variant = 'sidebar' | 'rail'

function RunMark({ state }: { state: 'working' | 'waiting' }) {
  if (state === 'working') {
    return (
      <svg className="un-mark" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="5" fill="none" stroke="var(--un-working-track)" strokeWidth="1.8" />
        <path d="M7 2a5 5 0 0 1 5 5" fill="none" stroke="var(--un-working)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className="un-mark" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="5.2" fill="none" stroke="var(--un-waiting)" strokeWidth="1.8" />
      <rect x="6.2" y="4" width="1.6" height="3.6" rx="0.8" fill="var(--un-waiting)" />
      <rect x="6.2" y="8.6" width="1.6" height="1.6" rx="0.8" fill="var(--un-waiting)" />
    </svg>
  )
}

const ic = { size: 14, strokeWidth: 1.7, className: 'un-icon' }

function Item({ icon, children, active, mono, end }: { icon: ReactNode; children: ReactNode; active?: boolean; mono?: boolean; end?: ReactNode }) {
  return (
    <div className="un-item" data-active={active || undefined}>
      {icon}
      <Text className={mono ? 'un-label un-label--mono' : 'un-label'}>{children}</Text>
      {end}
    </div>
  )
}

function Sidebar({ compact }: { compact: boolean }) {
  return (
    <div className="un-side">
      <div className="un-team">
        <Text className="un-team__name">Nuko Nova</Text>
        <ChevronDown size={12} strokeWidth={1.8} className="un-icon" />
      </div>
      <Item icon={<Inbox {...ic} />} active end={<span className="un-count">2</span>}>Inbox</Item>

      <div className="un-group">
        <div className="un-proj">
        <div className="un-project" data-open>
          <ChevronDown size={12} strokeWidth={1.8} className="un-icon" />
          <Text className="un-project__name">Reef Runner</Text>
        </div>
        <div className="un-sub">
          <Item icon={<Hash {...ic} />}>reef-runner</Item>
          <Item icon={<RunMark state="working" />}>Fix double jump</Item>
          <Item icon={<RunMark state="waiting" />}>Level 3 layout</Item>
          <Item icon={<SquareTerminal {...ic} />} mono>build-linux</Item>
          <Item icon={<Folder {...ic} />}>Files</Item>
        </div>
        </div>
        <div className="un-project">
          <ChevronRight size={12} strokeWidth={1.8} className="un-icon" />
          <Text className="un-project__name">Website</Text>
        </div>
        <div className="un-project">
          <ChevronRight size={12} strokeWidth={1.8} className="un-icon" />
          <Text className="un-project__name">Ops</Text>
        </div>
      </div>

      {compact ? (
        // The compact crop runs off the bottom here, so this group is filler
        <div className="un-group">
          <div className="un-section"><Bar w={52} h={5} tone={2} /></div>
          <div className="un-item"><Bar w={14} h={14} r={4} tone={2} /><Bar w={56} h={5} tone={2} /></div>
          <div className="un-item"><Bar w={14} h={14} r={4} tone={2} /><Bar w={64} h={5} tone={2} /></div>
        </div>
      ) : (
        <div className="un-group">
          <div className="un-section"><Text>Channels</Text></div>
          <Item icon={<Hash {...ic} />}>general</Item>
          <Item icon={<Volume2 {...ic} />} end={<Facepile names={['Julio', 'Ana']} size={18} overlap={4} className="un-pile" />}>Standup</Item>
        </div>
      )}
    </div>
  )
}

function Rail() {
  return (
    <div className="un-rail">
      <span className="un-tile" data-on>
        <Text>NN</Text>
      </span>
      <span className="un-tile">
        <Text>SP</Text>
      </span>
      <span className="un-tile un-tile--add">
        <Plus size={14} strokeWidth={1.8} />
      </span>
    </div>
  )
}

function InboxPane({ compact }: { compact: boolean }) {
  return (
    <div className="un-main">
      <div className="un-card">
        <div className="un-card__head">
          <RunMark state="waiting" />
          <div className="un-card__who">
            {compact ? <Bar w={150} h={6} tone={4} /> : <Text className="un-card__title">Codex wants to run a command</Text>}
            {compact ? <Bar w={80} h={5} tone={2} /> : <Text className="un-card__sub">Level 3 layout</Text>}
          </div>
          {!compact && <Text className="un-card__time">2m</Text>}
        </div>
        <div className="un-msg">
          <Bar w={300} h={5} tone={2} />
          <Bar w={236} h={5} tone={2} />
        </div>
        <div className="un-cmd">{compact ? <Bar w={120} h={5} tone={3} /> : <Text className="un-cmd__text">pnpm add -D tiled-map</Text>}</div>
        {!compact && (
          <div className="un-actions">
            <span className="un-btn un-btn--primary"><Text>Allow once</Text></span>
            <span className="un-btn"><Text>Deny</Text></span>
          </div>
        )}
      </div>
      <div className="un-card">
        <div className="un-card__head">
          <RunMark state="waiting" />
          <div className="un-card__who">
            <Bar w={168} h={6} tone={3} />
            <Bar w={84} h={5} tone={2} />
          </div>
        </div>
        <div className="un-msg">
          <Bar w={280} h={5} tone={2} />
          <Bar w={310} h={5} tone={2} />
          <Bar w={190} h={5} tone={2} />
        </div>
        <div className="un-cmd"><Bar w={140} h={5} tone={3} /></div>
      </div>
    </div>
  )
}

export function NavScene({ variant }: { variant: Variant }) {
  const rail = variant === 'rail'
  return (
    <Stage width={720} height={440} theme="dark" compact={{ below: 600, width: 358, height: 352 }} className={`un-stage un-stage--${variant}`}>
      {(_s, _rect, layout: Layout) => {
        const compact = layout === 'compact'
        const lead = (
          <div className="un-lead">
            <Text className="un-lead__title">Inbox</Text>
            {!compact && <Text className="un-lead__count">2 waiting</Text>}
          </div>
        )
        const side = rail ? (
          <div className="un-split">
            <Rail />
            <Sidebar compact={compact} />
          </div>
        ) : (
          <Sidebar compact={compact} />
        )
        return (
          <Window className="un-window" lead={lead} sidebar={side} sidebarWidth={rail ? 252 : 200}>
            <InboxPane compact={compact} />
          </Window>
        )
      }}
    </Stage>
  )
}
