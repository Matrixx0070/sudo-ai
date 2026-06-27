import React, { useState, useRef, useEffect, FormEvent } from 'react';

interface InputAreaProps {
  onSend: (text: string) => void;
  onSendAttachment: (file: File, caption: string) => void;
  disabled: boolean;
}

export function InputArea({ onSend, onSendAttachment, disabled }: InputAreaProps) {
  const [value, setValue] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Build (and revoke) an object URL for the selected image so the chip can
  // show a thumbnail without leaking the URL on every keystroke/re-render.
  useEffect(() => {
    if (file && file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewUrl(null);
    return undefined;
  }, [file]);

  const clearFile = () => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (disabled) return;
    const text = value.trim();
    if (file) {
      onSendAttachment(file, text);
      clearFile();
      setValue('');
      return;
    }
    if (!text) return;
    onSend(text);
    setValue('');
  };

  const canSend = !disabled && (!!value.trim() || !!file);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {file && (
        <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 self-start max-w-full">
          {previewUrl ? (
            <img src={previewUrl} alt={file.name} className="w-10 h-10 rounded object-cover flex-shrink-0" />
          ) : (
            <span className="text-lg flex-shrink-0" aria-hidden>📎</span>
          )}
          <span className="text-xs text-gray-300 truncate">{file.name}</span>
          <button
            type="button"
            onClick={clearFile}
            className="text-gray-400 hover:text-gray-100 text-sm leading-none px-1"
            aria-label="Remove attachment"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex gap-2 bg-gray-800 border border-gray-700 rounded-xl p-1 items-center">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.txt,.md,.csv,.json,.log"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={disabled}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="Attach a file"
          aria-label="Attach a file"
          className="text-gray-400 hover:text-gray-100 text-lg px-2.5 py-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          📎
        </button>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={file ? 'Add a caption (optional)…' : 'Message SUDO-AI...'}
          className="flex-1 bg-transparent border-none outline-none text-gray-100 text-sm px-2 py-2 font-family-inherit"
          autoComplete="off"
          autoFocus
          disabled={disabled}
        />
        <button
          type="submit"
          disabled={!canSend}
          className="bg-blue-500 text-white border-none rounded-lg px-4 py-2 text-sm font-semibold cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
        >
          Send
        </button>
      </div>
    </form>
  );
}
