/**
 * @file useFilePicker.ts — Synchronous cwd file scan for @mention autocomplete.
 * filter === null → returns [] (disabled).
 * On error → returns [].
 */

import { useMemo } from 'react';
import fs from 'node:fs';

export function useFilePicker(filter: string | null): string[] {
  return useMemo(() => {
    if (filter === null) return [];

    let entries: string[];
    try {
      entries = fs.readdirSync(process.cwd());
    } catch {
      return [];
    }

    const lower = filter.toLowerCase();
    return entries
      .filter(e => e.toLowerCase().startsWith(lower))
      .slice(0, 20);
  }, [filter]);
}
