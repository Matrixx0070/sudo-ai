/**
 * Runtime environment detection.
 * isElectron — true when the Electron preload has injected window.sudo.
 * isWeb      — true when running in a plain browser (web server mode).
 */
export const isElectron: boolean =
  typeof window !== 'undefined' && typeof window.sudo !== 'undefined';

export const isWeb: boolean = !isElectron;
