/**
 * Agora logo: three streams of decreasing radius spiraling clockwise into
 * a glowing hub — the pinwheel conveys many agents converging into one
 * center. Readable from 16px favicon to 36px nav mark.
 */
export function AgoraLogo({ size = 36 }: { size?: number }) {
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
        <radialGradient id="agora-hub" cx="0.42" cy="0.38" r="0.75">
          <stop offset="0%" stopColor="#ecfdf5" />
          <stop offset="45%" stopColor="#5eead4" />
          <stop offset="100%" stopColor="#0d9488" />
        </radialGradient>
      </defs>

      {/* Spiral streams: radius 17 → 14 → 11, each sweeping 130°,
          staggered 120° apart — a converging pinwheel. */}
      <g strokeLinecap="round">
        <path
          d="M 24 7 A 17 17 0 0 1 37.03 34.93"
          stroke="#34d399"
          strokeWidth="4.8"
        />
        <path
          d="M 36.12 31 A 14 14 0 0 1 10.84 28.79"
          stroke="#14b8a6"
          strokeWidth="4.2"
        />
        <path
          d="M 15.06 30.05 A 11.6 11.6 0 0 1 26.08 12.5"
          stroke="#06b6d4"
          strokeWidth="3.6"
        />
      </g>

      {/* The hub */}
      <circle cx="24" cy="24" r="5.1" fill="url(#agora-hub)" />
      <circle cx="22.5" cy="22.3" r="1.5" fill="#ffffff" fillOpacity="0.95" />
    </svg>
  );
}
