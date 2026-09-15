/**
 * Agora logo: a rounded hexagon (the agora / gathering place) with three
 * streams converging into a glowing hub — many agents, one center.
 * Rendered in the brand accent (adapts to the active skin via currentColor).
 */
export function AgoraLogo({ size = 36 }: { size?: number }) {
  const id = 'agora-logo-grad';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-label="Agora logo"
      role="img"
    >
      <defs>
        <linearGradient id={`${id}-frame`} x1="8" y1="4" x2="40" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="55%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#0e7490" />
        </linearGradient>
        <radialGradient id={`${id}-hub`} cx="0.5" cy="0.45" r="0.65">
          <stop offset="0%" stopColor="#d1fae5" />
          <stop offset="60%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0.9" />
        </radialGradient>
      </defs>

      {/* Hexagon frame (the agora) */}
      <path
        d="M24 3.5 41.5 13.5v21L24 44.5 6.5 34.5v-21L24 3.5Z"
        stroke={`url(#${id}-frame)`}
        strokeWidth="3"
        strokeLinejoin="round"
        fill="rgba(16,185,129,0.08)"
      />

      {/* Three streams converging to the hub */}
      <g stroke={`url(#${id}-frame)`} strokeWidth="2.4" strokeLinecap="round">
        <path d="M24 10.5v8" />
        <path d="M13.5 29.5l6.8-4" />
        <path d="M34.5 29.5l-6.8-4" />
      </g>
      {/* Source nodes at the hexagon edge */}
      <g fill="#34d399">
        <circle cx="24" cy="10" r="2.2" />
        <circle cx="13" cy="30" r="2.2" />
        <circle cx="35" cy="30" r="2.2" />
      </g>

      {/* The hub */}
      <circle cx="24" cy="25" r="5.4" fill={`url(#${id}-hub)`} />
      <circle cx="24" cy="25" r="5.4" stroke="#d1fae5" strokeOpacity="0.7" strokeWidth="0.8" />
      <circle cx="22.6" cy="23.4" r="1.4" fill="#ecfdf5" fillOpacity="0.95" />
    </svg>
  );
}
