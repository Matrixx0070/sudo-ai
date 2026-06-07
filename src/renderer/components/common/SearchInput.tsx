import React, { useEffect, useRef, useState, useCallback } from 'react';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  debounceMs = 300,
}: SearchInputProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRef = useRef(value);
  latestRef.current = value;

  // Local display state so the input stays responsive while upstream onChange
  // is debounced. Kept in sync with the `value` prop for external changes
  // (e.g. the Clear button or a parent-driven reset).
  const [displayValue, setDisplayValue] = useState(value);
  useEffect(() => {
    setDisplayValue(value);
  }, [value]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      setDisplayValue(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        onChange(next);
      }, debounceMs);
    },
    [onChange, debounceMs],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width: '100%',
      }}
    >
      {/* Search icon */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '10px',
          display: 'flex',
          alignItems: 'center',
          color: 'var(--text-secondary, #9ca3af)',
          pointerEvents: 'none',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </span>

      <input
        type="search"
        aria-label={placeholder}
        value={displayValue}
        onChange={handleChange}
        placeholder={placeholder}
        style={{
          width: '100%',
          padding: '7px 12px 7px 32px',
          fontSize: '13px',
          color: 'var(--text-primary, #f9fafb)',
          backgroundColor: '#111827',
          border: '1px solid #1f2937',
          borderRadius: '8px',
          outline: 'none',
          fontFamily: 'Inter, system-ui, sans-serif',
          transition: 'border-color 150ms ease',
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = 'var(--accent, #3b82f6)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = '#1f2937';
        }}
      />

      {/* Clear button — shown only when there is a value */}
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          style={{
            position: 'absolute',
            right: '8px',
            display: 'flex',
            alignItems: 'center',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px',
            color: 'var(--text-secondary, #9ca3af)',
            borderRadius: '4px',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M9 3L3 9M3 3l6 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
