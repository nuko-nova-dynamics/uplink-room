// Direction C's mark: a steering wheel. One rim, a filled hub and three
// spokes (left, right, down) like a car wheel, so it reads as "who is
// driving" and not as a ship's wheel or a settings cog. Drawn on a 24 grid
// with one stroke weight; small sizes take a heavier stroke so the rim
// doesn't go wiry.

const C = 12
const RIM = 8.9
const HUB = 2.7

function spoke(deg: number) {
  const r = (deg * Math.PI) / 180
  const a = HUB + 0.4
  const b = RIM
  const f = (n: number) => n.toFixed(2)
  return `M${f(C + Math.cos(r) * a)} ${f(C + Math.sin(r) * a)}L${f(C + Math.cos(r) * b)} ${f(C + Math.sin(r) * b)}`
}

const SPOKES = [spoke(9), spoke(171), spoke(90)].join('')

export function WheelMark({ size = 24, stroke, className }: { size?: number; stroke?: number; className?: string }) {
  // Keep the drawn line near 1.6px at small sizes, 2px at large ones
  const w = stroke ?? (size <= 14 ? 3.1 : size <= 20 ? 2.6 : 2.15)
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx={C} cy={C} r={RIM} fill="none" stroke="currentColor" strokeWidth={w} />
      <circle cx={C} cy={C} r={HUB} fill="currentColor" />
      <path d={SPOKES} fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
    </svg>
  )
}

// The app icon: the wheel in white on a cobalt tile with macOS proportions
export function AppIcon({ size }: { size: number }) {
  return (
    <span className="uc-icon" style={{ width: size, height: size, borderRadius: size * 0.225 }}>
      <WheelMark size={Math.round(size * 0.58)} stroke={2.3} />
    </span>
  )
}
