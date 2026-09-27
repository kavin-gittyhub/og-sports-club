// Hand-built SVG illustrations for each activity (no external images needed).
import { useId } from 'react';

export const SPORT_COLORS = {
  football: '#15803d',
  oval: '#0f766e',
  cricket: '#c2410c',
  pickleball: '#1d4ed8',
  other: '#334155',
};

export const sportColor = (sport) => SPORT_COLORS[sport] || SPORT_COLORS.other;

function Football({ id }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1f9d55" />
          <stop offset="1" stopColor="#0d5c33" />
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill={`url(#${id}g)`} />
      {Array.from({ length: 8 }, (_, i) => <rect key={i} x={i * 40} y="0" width="20" height="180" fill="#fff" opacity="0.05" />)}
      <g fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="2.5">
        <rect x="22" y="18" width="276" height="144" rx="2" />
        <line x1="160" y1="18" x2="160" y2="162" />
        <circle cx="160" cy="90" r="26" />
        <rect x="22" y="55" width="40" height="70" />
        <rect x="258" y="55" width="40" height="70" />
        <rect x="12" y="74" width="10" height="32" />
        <rect x="298" y="74" width="10" height="32" />
      </g>
      <g transform="translate(160 90)">
        <circle r="12" fill="#fff" />
        <path d="M0-5 4.8-1.5 3 4H-3L-4.8-1.5z" fill="#111" />
        <path d="M0-5V-12M4.8-1.5 11.4-3.7M3 4 7 9.7M-3 4-7 9.7M-4.8-1.5-11.4-3.7" stroke="#111" strokeWidth="1.4" />
      </g>
    </>
  );
}

function Oval({ id }) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}g`} cx="0.5" cy="0.5" r="0.7">
          <stop offset="0" stopColor="#1ea37a" />
          <stop offset="1" stopColor="#0a4f45" />
        </radialGradient>
      </defs>
      <rect width="320" height="180" fill={`url(#${id}g)`} />
      {Array.from({ length: 6 }, (_, i) => (
        <ellipse key={i} cx="160" cy="90" rx={150 - i * 22} ry={80 - i * 12} fill="none" stroke="#fff" strokeOpacity="0.05" strokeWidth="11" />
      ))}
      <ellipse cx="160" cy="90" rx="145" ry="78" fill="none" stroke="#fff" strokeOpacity="0.9" strokeWidth="2.5" />
      <ellipse cx="160" cy="90" rx="72" ry="44" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="2" strokeDasharray="6 6" />
      <rect x="148" y="62" width="24" height="56" rx="2" fill="#d9c089" />
      <g stroke="#fff" strokeWidth="2">
        <line x1="148" y1="70" x2="172" y2="70" />
        <line x1="148" y1="110" x2="172" y2="110" />
      </g>
      <g fill="#fff">
        <rect x="155" y="64" width="2" height="6" /><rect x="159" y="64" width="2" height="6" /><rect x="163" y="64" width="2" height="6" />
        <rect x="155" y="110" width="2" height="6" /><rect x="159" y="110" width="2" height="6" /><rect x="163" y="110" width="2" height="6" />
      </g>
    </>
  );
}

function Cricket({ id }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1e293b" />
          <stop offset="1" stopColor="#0f172a" />
        </linearGradient>
        <linearGradient id={`${id}p`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3f8f4a" />
          <stop offset="1" stopColor="#2f6e38" />
        </linearGradient>
        <pattern id={`${id}n`} width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="12" stroke="#fff" strokeOpacity="0.16" strokeWidth="1.2" />
          <line x1="0" y1="0" x2="12" y2="0" stroke="#fff" strokeOpacity="0.16" strokeWidth="1.2" />
        </pattern>
      </defs>
      <rect width="320" height="180" fill={`url(#${id}g)`} />
      <rect width="320" height="180" fill={`url(#${id}n)`} />
      <path d="M118 180 146 40h28l28 140z" fill={`url(#${id}p)`} />
      <path d="M126 150h68M141 62h38" stroke="#fff" strokeOpacity="0.8" strokeWidth="2" />
      <g fill="#f5deb3">
        <rect x="152" y="40" width="3" height="20" rx="1" /><rect x="158.5" y="40" width="3" height="20" rx="1" /><rect x="165" y="40" width="3" height="20" rx="1" />
      </g>
      <rect x="151" y="38.5" width="18" height="2.5" rx="1" fill="#f5deb3" />
      <circle cx="214" cy="104" r="9" fill="#dc2626" />
      <path d="M207 98.5c4 3 10 3 14 0M207 109.5c4-3 10-3 14 0" stroke="#fff" strokeWidth="1.2" fill="none" transform="rotate(35 214 104)" />
    </>
  );
}

function Pickleball({ id }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2563eb" />
          <stop offset="1" stopColor="#1e3a8a" />
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill={`url(#${id}g)`} />
      <rect x="40" y="22" width="240" height="136" rx="3" fill="#3b82f6" opacity="0.6" />
      <g fill="none" stroke="#fff" strokeOpacity="0.9" strokeWidth="2.5">
        <rect x="40" y="22" width="240" height="136" rx="2" />
        <line x1="160" y1="16" x2="160" y2="164" strokeWidth="4" />
        <line x1="130" y1="22" x2="130" y2="158" />
        <line x1="190" y1="22" x2="190" y2="158" />
        <line x1="40" y1="90" x2="130" y2="90" />
        <line x1="190" y1="90" x2="280" y2="90" />
      </g>
      <g transform="translate(86 118) rotate(-28)">
        <rect x="-17" y="-26" width="34" height="38" rx="14" fill="#f97316" />
        <rect x="-4" y="10" width="8" height="24" rx="3" fill="#0f172a" />
      </g>
      <g transform="translate(232 58)">
        <circle r="11" fill="#facc15" />
        {[[-4, -4], [4, -4], [0, 0], [-4, 4], [4, 4], [0, -7], [0, 7], [-7, 0], [7, 0]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.3" fill="#a16207" />)}
      </g>
    </>
  );
}

function Generic({ id }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#334155" />
          <stop offset="1" stopColor="#0f172a" />
        </linearGradient>
      </defs>
      <rect width="320" height="180" fill={`url(#${id}g)`} />
      <circle cx="160" cy="90" r="40" fill="none" stroke="#b8f53b" strokeWidth="4" />
    </>
  );
}

const ART = { football: Football, oval: Oval, cricket: Cricket, pickleball: Pickleball };

export function SportArt({ sport, imageUrl, className = '', alt = '' }) {
  const id = useId().replace(/:/g, '');
  if (imageUrl) return <img className={`sport-art ${className}`} src={imageUrl} alt={alt} loading="lazy" />;
  const C = ART[sport] || Generic;
  return (
    <svg className={`sport-art ${className}`} viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" role="img" aria-label={alt}>
      <C id={id} />
    </svg>
  );
}

/** Small round glyph used in lists/cards. */
export function SportBadge({ sport, size = 44 }) {
  const color = sportColor(sport);
  const glyph = {
    football: <><circle cx="12" cy="12" r="8" /><path d="M12 8.5l3 2.2-1.1 3.6h-3.8L9 10.7z" fill="currentColor" /></>,
    oval: <><ellipse cx="12" cy="12" rx="9" ry="6.5" /><rect x="10.5" y="9" width="3" height="6" rx=".5" fill="currentColor" /></>,
    cricket: <><path d="M5 19 15.5 8.5l2 2L7 21z" /><path d="M16.5 7.5l2-2" /><circle cx="7" cy="7" r="2.5" fill="currentColor" /></>,
    pickleball: <><rect x="5" y="3" width="10" height="12" rx="5" /><path d="M10 15v6" /><circle cx="18" cy="17" r="2.5" fill="currentColor" /></>,
  }[sport] || <circle cx="12" cy="12" r="8" />;
  return (
    <span className="sport-badge" style={{ width: size, height: size, background: `${color}14`, color }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {glyph}
      </svg>
    </span>
  );
}
