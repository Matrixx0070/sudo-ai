import { useEffect } from 'react';

/**
 * AssetPreloader
 *
 * Renders nothing — exists solely to warm the browser image cache on mount.
 * Critical assets are fetched eagerly so that room reveals feel instant.
 *
 * Assets preloaded:
 *   - /office/structure/room-frame.png   — shared room chrome, used 6 times
 *   - /office/floors/floor-tile-1.png … floor-tile-12.png — 12 floor tiles
 */

const CRITICAL_ASSETS: string[] = [
  '/office/structure/room-frame.png',
  ...Array.from({ length: 12 }, (_, i) => `/office/floors/floor-tile-${i + 1}.png`),
];

export function AssetPreloader(): null {
  useEffect(() => {
    for (const src of CRITICAL_ASSETS) {
      const img = new Image();
      img.src = src;
    }
    // Intentionally no cleanup — cached images persist for the session lifetime
  }, []);

  return null;
}

export default AssetPreloader;
