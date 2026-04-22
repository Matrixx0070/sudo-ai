import React, { useId } from 'react';

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Toggle({ label, checked, onChange, disabled = false }: ToggleProps) {
  const id = useId();

  return (
    <label
      htmlFor={id}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '10px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        userSelect: 'none',
      }}
    >
      {/* Hidden native checkbox for accessibility */}
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          position: 'absolute',
          width: '1px',
          height: '1px',
          padding: 0,
          margin: '-1px',
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      />

      {/* Visual track */}
      <span
        aria-hidden="true"
        style={{
          position: 'relative',
          display: 'inline-block',
          width: '40px',
          height: '22px',
          borderRadius: '11px',
          backgroundColor: checked ? '#3b82f6' : '#374151',
          transition: 'background-color 180ms ease',
          flexShrink: 0,
        }}
      >
        {/* Thumb */}
        <span
          style={{
            position: 'absolute',
            top: '3px',
            left: checked ? '21px' : '3px',
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            backgroundColor: '#ffffff',
            transition: 'left 180ms ease',
            boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
          }}
        />
      </span>

      <span
        style={{
          fontSize: '13px',
          color: 'var(--text-primary, #f9fafb)',
          lineHeight: 1.4,
        }}
      >
        {label}
      </span>
    </label>
  );
}
