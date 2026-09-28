import React, { useId, useMemo } from 'react';

/*
 * Reaction-face avatars. Every profile gets a stable face from a hash of its id:
 * a base colour, an optional diagonal split or crescent in a second colour, and an
 * expression, nudged off-centre and tilted a little so a list doesn't look stamped out.
 * A colour the operator picked for the profile always wins as the base.
 */

export const FACE_COLORS = [
  '#ff6b8b', // pink
  '#a78bfa', // violet
  '#fbbf24', // yellow
  '#4ade80', // green
  '#f59e0b', // amber
  '#38bdf8', // sky
  '#fb7185', // coral
  '#2dd4bf', // teal
  '#fb923c', // orange
  '#c084fc', // lilac
];

const INK = '#1c1a24';

type Eyes = 'dots' | 'wide' | 'wink' | 'happy' | 'sleepy';
type Mouth = 'smile' | 'grin' | 'flat' | 'o' | 'smirk';
type Style = 'plain' | 'split' | 'crescent';

export interface Face {
  base: string;
  accent: string;
  style: Style;
  angle: number;
  crescent: [number, number];
  eyes: Eyes;
  mouth: Mouth;
  dx: number;
  dy: number;
  tilt: number;
}

/** FNV-1a, then mulberry32: small, stable, well spread. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

export function faceOf(seed: string, color?: string, overrides: Partial<Face> = {}): Face {
  const r = rng(seed);
  // Always draw the colour, even when one is given: skipping the draw would shift every
  // later trait, so choosing a colour would swap the whole face.
  const hashed = pick(r, FACE_COLORS);
  const base = color || hashed;
  const others = FACE_COLORS.filter((c) => c.toLowerCase() !== base.toLowerCase());
  const angle = Math.round(r() * 360);
  return {
    base,
    accent: pick(r, others),
    style: pick(r, ['plain', 'plain', 'split', 'crescent', 'crescent'] as const),
    angle,
    crescent: [Math.cos((angle * Math.PI) / 180) * 3.2, Math.sin((angle * Math.PI) / 180) * 3.2],
    eyes: pick(r, ['dots', 'dots', 'wide', 'wink', 'happy', 'sleepy'] as const),
    mouth: pick(r, ['smile', 'smile', 'grin', 'flat', 'o', 'smirk'] as const),
    dx: Math.round((r() - 0.5) * 6),
    dy: Math.round((r() - 0.35) * 5),
    tilt: Math.round((r() - 0.5) * 24),
    ...overrides,
  };
}

const EYES: Record<Eyes, React.ReactNode> = {
  dots: (
    <>
      <circle cx="13" cy="15" r="1.9" />
      <circle cx="23" cy="15" r="1.9" />
    </>
  ),
  wide: (
    <>
      <circle cx="13" cy="15" r="2.5" />
      <circle cx="23" cy="15" r="2.5" />
    </>
  ),
  wink: (
    <>
      <circle cx="13" cy="15" r="1.9" />
      <path d="M21 15.2h4" fill="none" strokeWidth="1.9" />
    </>
  ),
  happy: (
    <>
      <path d="M10.8 16.2q2.2-3.2 4.4 0" fill="none" strokeWidth="1.8" />
      <path d="M20.8 16.2q2.2-3.2 4.4 0" fill="none" strokeWidth="1.8" />
    </>
  ),
  sleepy: (
    <>
      <path d="M11 15.6q2 1.6 4 0" fill="none" strokeWidth="1.8" />
      <path d="M21 15.6q2 1.6 4 0" fill="none" strokeWidth="1.8" />
    </>
  ),
};

const MOUTHS: Record<Mouth, React.ReactNode> = {
  smile: <path d="M13 21.5q5 5 10 0" fill="none" strokeWidth="1.9" />,
  grin: <path d="M12.6 20.6h10.8q-.6 6.2-5.4 6.2t-5.4-6.2z" stroke="none" />,
  flat: <path d="M14.2 23.2h7.6" fill="none" strokeWidth="1.9" />,
  o: <circle cx="18" cy="23.2" r="2.1" stroke="none" />,
  smirk: <path d="M14 23.4q4.4 1.8 8.2-2.2" fill="none" strokeWidth="1.9" />,
};

export const FaceSvg: React.FC<{ face: Face; size: number; className?: string; title?: string }> = ({
  face: f,
  size,
  className = 'avatar',
  title,
}) => {
  const clip = useId();
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 36 36"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <clipPath id={clip}>
          <circle cx="18" cy="18" r="18" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {f.style === 'crescent' ? (
          <>
            <rect width="36" height="36" style={{ fill: f.accent }} />
            <circle cx={18 + f.crescent[0]} cy={18 + f.crescent[1]} r="17" style={{ fill: f.base }} />
          </>
        ) : (
          <rect width="36" height="36" style={{ fill: f.base }} />
        )}
        {f.style === 'split' && (
          <path d="M-8 -8H44L-8 44Z" style={{ fill: f.accent }} transform={`rotate(${f.angle} 18 18)`} opacity="0.95" />
        )}
      </g>
      <g transform={`translate(${f.dx} ${f.dy}) rotate(${f.tilt} 18 18)`} fill={INK} stroke={INK} strokeLinecap="round">
        {EYES[f.eyes]}
        {MOUTHS[f.mouth]}
      </g>
    </svg>
  );
};

/** A profile's face. */
export const Avatar: React.FC<{ s: { id: string; color?: string }; size?: number }> = ({ s, size = 28 }) => {
  const face = useMemo(() => faceOf(s.id, s.color || undefined), [s.id, s.color]);
  return <FaceSvg face={face} size={size} />;
};

/** Small illustration for empty states: a huddle of faces with a mood to match. */
export const FaceHuddle: React.FC<{ mood?: 'waiting' | 'puzzled' | 'calm' }> = ({ mood = 'waiting' }) => {
  const set = {
    waiting: [
      faceOf('huddle-a', FACE_COLORS[1], { style: 'split', eyes: 'dots', mouth: 'smile', tilt: -10, dx: 0, dy: 0 }),
      faceOf('huddle-b', FACE_COLORS[2], { style: 'crescent', eyes: 'happy', mouth: 'grin', tilt: 4, dx: 0, dy: 0 }),
      faceOf('huddle-c', FACE_COLORS[3], { style: 'plain', eyes: 'wink', mouth: 'smirk', tilt: 10, dx: 0, dy: 0 }),
    ],
    puzzled: [
      faceOf('huddle-p', FACE_COLORS[5], { style: 'crescent', eyes: 'wide', mouth: 'o', tilt: -6, dx: 0, dy: 0 }),
    ],
    calm: [
      faceOf('huddle-s', FACE_COLORS[7], { style: 'split', eyes: 'sleepy', mouth: 'flat', tilt: -8, dx: 0, dy: 0 }),
      faceOf('huddle-t', FACE_COLORS[0], { style: 'plain', eyes: 'sleepy', mouth: 'smile', tilt: 8, dx: 0, dy: 0 }),
    ],
  }[mood];
  return (
    <div className="huddle" aria-hidden="true">
      {set.map((f, i) => (
        <FaceSvg key={i} face={f} size={set.length === 3 && i === 1 ? 56 : 44} className="huddle-face" />
      ))}
    </div>
  );
};
