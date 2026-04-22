import React from 'react';

interface MetricGaugeProps {
  value: number;  // 0-100
  label: string;
  color?: string;
  size?: number;  // default 80
}

export function MetricGauge({
  value,
  label,
  color = '#3b82f6',
  size = 80,
}: MetricGaugeProps) {
  const clamped = Math.min(100, Math.max(0, value));
  const strokeWidth = size * 0.1;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const cx = size / 2;
  const cy = size / 2;

  // Color thresholds: green >=70, yellow >=40, red <40 (unless overridden)
  const resolvedColor =
    color === '#3b82f6'
      ? clamped >= 70
        ? '#22c55e'
        : clamped >= 40
          ? '#eab308'
          : '#ef4444'
      : color;

  const fontSize = size * 0.2;
  const labelFontSize = size * 0.145;

  return (
    <figure
      role="img"
      aria-label={`${label}: ${clamped}%`}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        margin: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        style={{ display: 'block' }}
      >
        {/* Track */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="#1f2937"
          strokeWidth={strokeWidth}
        />
        {/* Progress arc */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={resolvedColor}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cy})`}
          style={{ transition: 'stroke-dashoffset 600ms ease, stroke 400ms ease' }}
        />
        {/* Value label */}
        <text
          x={cx}
          y={cy + fontSize * 0.35}
          textAnchor="middle"
          fill="var(--text-primary, #f9fafb)"
          fontSize={fontSize}
          fontWeight="700"
          fontFamily="Inter, system-ui, sans-serif"
        >
          {clamped}%
        </text>
      </svg>

      <figcaption
        style={{
          fontSize: `${labelFontSize}px`,
          color: 'var(--text-secondary, #9ca3af)',
          textAlign: 'center',
          fontFamily: 'Inter, system-ui, sans-serif',
          maxWidth: `${size}px`,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </figcaption>
    </figure>
  );
}
