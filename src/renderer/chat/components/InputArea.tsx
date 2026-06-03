import React, { useState, FormEvent } from 'react';

interface InputAreaProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function InputArea({ onSend, disabled }: InputAreaProps) {
  const [value, setValue] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 bg-gray-800 border border-gray-700 rounded-xl p-1 items-center">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Message SUDO-AI..."
        className="flex-1 bg-transparent border-none outline-none text-gray-100 text-sm px-4 py-2 font-family-inherit"
        autoComplete="off"
        autoFocus
        disabled={disabled}
      />
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="bg-blue-500 text-white border-none rounded-lg px-4 py-2 text-sm font-semibold cursor-pointer whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
      >
        Send
      </button>
    </form>
  );
}
