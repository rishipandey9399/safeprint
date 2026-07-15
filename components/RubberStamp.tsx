"use client";

import { useId } from "react";

interface Props {
  /** Text arced along the top of the ring. */
  top: string;
  /** Text arced along the bottom of the ring. */
  bottom: string;
  /** Short center label (a word, date, or glyph). */
  center: string;
  /** Degrees of rotation — real stamps land slightly crooked. */
  angle?: number;
  size?: number;
  className?: string;
}

/**
 * A CSS/SVG impression of the round bureaucratic ink stamp that governs every
 * attested photocopy in India. Ink is roughened with a turbulence displacement
 * so it reads as pressed-by-hand, not printed. Color follows `currentColor`.
 */
export default function RubberStamp({
  top,
  bottom,
  center,
  angle = -8,
  size = 190,
  className = "",
}: Props) {
  const uid = useId().replace(/:/g, "");
  const rough = `rough-${uid}`;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label={`${top} ${center} ${bottom}`}
      style={{ transform: `rotate(${angle}deg)`, color: "inherit" }}
    >
      <defs>
        <filter id={rough} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="1" seed="7" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="1.7" />
        </filter>
        <path id={`top-${uid}`} d="M18,100 A82,82 0 0 1 182,100" fill="none" />
        <path id={`bot-${uid}`} d="M184,100 A84,84 0 0 1 16,100" fill="none" />
      </defs>

      <g filter={`url(#${rough})`} fill="none" stroke="currentColor" opacity="0.9">
        <circle cx="100" cy="100" r="92" strokeWidth="4.5" />
        <circle cx="100" cy="100" r="76" strokeWidth="1.6" />
      </g>

      <g filter={`url(#${rough})`} fill="currentColor" opacity="0.9">
        <text fontSize="17" fontWeight="700" letterSpacing="1.5" textAnchor="middle">
          <textPath href={`#top-${uid}`} startOffset="50%">
            {top}
          </textPath>
        </text>
        <text fontSize="14" fontWeight="700" letterSpacing="1.2" textAnchor="middle">
          <textPath href={`#bot-${uid}`} startOffset="50%">
            {bottom}
          </textPath>
        </text>

        {/* flanking stars, the way official seals separate the arcs */}
        <text x="100" y="150" fontSize="13" textAnchor="middle">
          ★
        </text>
        <text x="100" y="58" fontSize="13" textAnchor="middle">
          ★
        </text>

        <text
          x="100"
          y="108"
          fontSize={center.length > 3 ? 22 : 30}
          fontWeight="700"
          letterSpacing="1"
          textAnchor="middle"
          style={{ fontFamily: '"Courier New", monospace' }}
        >
          {center}
        </text>
      </g>
    </svg>
  );
}
