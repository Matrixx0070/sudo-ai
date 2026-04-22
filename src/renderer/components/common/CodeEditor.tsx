import React, { useRef, useState, useCallback } from 'react';

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: 'json' | 'text' | 'markdown';
  height?: string;
  readOnly?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language = 'text',
  height = '300px',
  readOnly = false,
}: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const lines = value.split('\n');
  const lineCount = Math.max(lines.length, 1);

  const handleScroll = useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    const st = e.currentTarget.scrollTop;
    setScrollTop(st);
    if (scrollRef.current) scrollRef.current.scrollTop = st;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (readOnly) return;

      // Tab key inserts 2 spaces instead of moving focus
      if (e.key === 'Tab') {
        e.preventDefault();
        const el = e.currentTarget;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const newVal =
          value.substring(0, start) + '  ' + value.substring(end);
        onChange(newVal);
        // Restore cursor after React re-render
        requestAnimationFrame(() => {
          el.selectionStart = start + 2;
          el.selectionEnd = start + 2;
        });
      }
    },
    [readOnly, value, onChange],
  );

  const MONO = '"Fira Code", "Cascadia Code", "JetBrains Mono", Consolas, monospace';
  const LINE_H = 20; // px — must match font-size + line-height ratio

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        backgroundColor: '#0a0e1a',
        border: '1px solid #1f2937',
        borderRadius: '8px',
        overflow: 'hidden',
        height,
        fontFamily: MONO,
        fontSize: '13px',
        lineHeight: `${LINE_H}px`,
      }}
      aria-label={`${language} code editor`}
    >
      {/* Line numbers gutter */}
      <div
        ref={scrollRef}
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: `${String(lineCount).length * 9 + 20}px`,
          minWidth: '40px',
          backgroundColor: '#0d1117',
          borderRight: '1px solid #1f2937',
          color: '#4b5563',
          fontSize: '12px',
          lineHeight: `${LINE_H}px`,
          padding: `8px 8px 8px 0`,
          textAlign: 'right',
          userSelect: 'none',
          overflowY: 'hidden',
          pointerEvents: 'none',
        }}
      >
        <div style={{ paddingTop: `${scrollTop}px` }}>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} style={{ height: `${LINE_H}px` }}>
              {i + 1}
            </div>
          ))}
        </div>
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={`${language} editor content`}
        aria-multiline="true"
        aria-readonly={readOnly}
        style={{
          flex: 1,
          resize: 'none',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          padding: '8px 12px',
          color: language === 'json' ? '#a5f3fc' : 'var(--text-primary, #f9fafb)',
          fontFamily: MONO,
          fontSize: '13px',
          lineHeight: `${LINE_H}px`,
          whiteSpace: 'pre',
          overflowWrap: 'normal',
          overflowX: 'auto',
          overflowY: 'auto',
          cursor: readOnly ? 'default' : 'text',
          caretColor: 'var(--accent, #3b82f6)',
        }}
      />

      {/* Language label */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          bottom: '6px',
          right: '10px',
          fontSize: '11px',
          color: '#4b5563',
          pointerEvents: 'none',
          fontFamily: MONO,
        }}
      >
        {language}
      </div>
    </div>
  );
}
