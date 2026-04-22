/**
 * Remotion configuration for SUDO-AI v3.
 * Docs: https://www.remotion.dev/docs/config
 */

import { Config } from '@remotion/cli/config';

// Use the Rust-based FFmpeg bundled with Remotion for consistent output.
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setConcurrency(2); // Limit to 2 concurrent render threads to manage memory.
Config.setChromiumOpenGlRenderer('angle');

// Entry point — must export RemotionRoot from this file.
// Run: npx remotion studio src/remotion/Root.tsx
