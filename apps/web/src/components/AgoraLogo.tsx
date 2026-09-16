/**
 * Agora logo: the letter A as a Greek temple façade — two doric columns
 * (flared bases) carrying an architrave, with a glowing hearth in the
 * open plaza between them. Agora = the gathering square of ancient
 * Greece; the mark is its initial and its architecture in one.
 * Readable from 16px favicon to 36px nav mark.
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
        <linearGradient id="agora-columns" x1="24" y1="6" x2="24" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6ee7b7" />
          <stop offset="60%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#0e7490" />
        </linearGradient>
      </defs>

      {/* Two doric columns (the legs of A) */}
      <path d="M14 40 L20.5 11" stroke="url(#agora-columns)" strokeWidth="5" strokeLinecap="round" />
      <path d="M34 40 L27.5 11" stroke="url(#agora-columns)" strokeWidth="5" strokeLinecap="round" />

      {/* Flared column bases */}
      <path d="M11.5 40.8 L17 40.8" stroke="#2dd4a4" strokeWidth="3.2" strokeLinecap="round" />
      <path d="M31 40.8 L36.5 40.8" stroke="#14909e" strokeWidth="3.2" strokeLinecap="round" />

      {/* Architrave (the top beam) and the crossbar */}
      <path d="M17 8 L31 8" stroke="url(#agora-columns)" strokeWidth="4.6" strokeLinecap="round" />
      <path d="M17.8 27 L30.2 27" stroke="url(#agora-columns)" strokeWidth="4.2" strokeLinecap="round" />

      {/* The glowing hearth in the open plaza */}
      <circle cx="24" cy="20.5" r="4.6" fill="url(#agora-hub)" />
      <circle cx="22.8" cy="19.1" r="1.2" fill="#ffffff" fillOpacity="0.95" />
    </svg>
  );
}
