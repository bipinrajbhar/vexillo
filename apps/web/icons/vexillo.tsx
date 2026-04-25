export function VexilloMark({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" fill="none" aria-label="Vexillo" className={className}>
      <rect x="12" y="8" width="3" height="80" fill="currentColor" />
      <path d="M15 18 L70 18 L52 44 L70 70 L15 70 L15 60 L52 60 L40 44 L52 28 L15 28 Z" fill="currentColor" />
    </svg>
  )
}

export function VexilloLockup({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 120" fill="none" aria-label="Vexillo" className={className}>
      <g transform="translate(28, 18)">
        <rect x="12" y="8" width="3" height="80" fill="currentColor" />
        <path d="M15 18 L70 18 L52 44 L70 70 L15 70 L15 60 L52 60 L40 44 L52 28 L15 28 Z" fill="currentColor" />
      </g>
      <text x="138" y="80" fontFamily="Inter, system-ui, sans-serif" fontWeight="700" fontSize="64" letterSpacing="-1.6" fill="currentColor">vexillo</text>
    </svg>
  )
}
