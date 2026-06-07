import { useCallback, useEffect, useState } from 'react';

export function useAuthToken(): string {
  const [token, setToken] = useState<string>('');

  useEffect(() => {
    const getToken = (): string => {
      // 1. URL hash #token=...
      const hash = window.location.hash;
      if (hash && hash.startsWith('#token=')) {
        const t = decodeURIComponent(hash.slice(7));
        if (t) {
          try {
            localStorage.setItem('sudo_admin_token', t);
          } catch {
            // ignore
          }
          // redact from URL bar
          try {
            history.replaceState(null, '', window.location.pathname + window.location.search);
          } catch {
            // ignore
          }
          return t;
        }
      }

      // 2. URL query ?token=...
      try {
        const params = new URLSearchParams(window.location.search);
        const qt = params.get('token');
        if (qt) {
          try {
            localStorage.setItem('sudo_admin_token', qt);
          } catch {
            // ignore
          }
          // strip token from URL bar, preserving other query params
          try {
            params.delete('token');
            const rest = params.toString();
            history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : ''));
          } catch {
            // ignore
          }
          return qt;
        }
      } catch {
        // ignore
      }

      // 3. localStorage
      try {
        const stored = localStorage.getItem('sudo_admin_token');
        if (stored) return stored;
      } catch {
        // ignore
      }

      return '';
    };

    setToken(getToken());
  }, []);

  return token;
}
