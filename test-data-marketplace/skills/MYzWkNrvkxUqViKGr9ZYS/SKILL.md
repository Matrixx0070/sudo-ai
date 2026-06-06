---
name: screenshot
description: Capture a screenshot of the full screen or a specific window using scrot or screencapture.
trigger: /screenshot, take screenshot, capture screen, screenshot window, grab screen
allowed-tools: [exec.run]
---

# Skill: Screenshot

## Purpose
Capture screenshots of the desktop, a specific window, or a selected region.
Saves the result as a PNG file and reports the path.
Works on Linux (via `scrot` or `gnome-screenshot`) and macOS (via `screencapture`).

## When to use
- User wants to capture the current state of the screen
- User wants to document a UI bug or visual issue
- User wants to share what is currently displayed on screen
- Automated workflow needs a visual snapshot

## How to use

1. Detect the operating system:
   - Linux: check for `scrot`, `gnome-screenshot`, or `import` (ImageMagick)
   - macOS: `screencapture` is always available

2. Determine capture mode from `$ARGUMENTS`:
   - `full` (default) — entire screen
   - `window` — active window or named window
   - `region` — interactive region select (requires display)
   - `delay:<N>` — delay N seconds before capture

3. **Linux — scrot (preferred):**
   - Full screen: `scrot /tmp/screenshot-<timestamp>.png`
   - Active window: `scrot --focused /tmp/screenshot-<timestamp>.png`
   - With delay: `scrot --delay 3 /tmp/screenshot-<timestamp>.png`
   - Region (interactive): `scrot --select /tmp/screenshot-<timestamp>.png`

4. **Linux — gnome-screenshot (fallback):**
   - Full screen: `gnome-screenshot --file=/tmp/screenshot-<timestamp>.png`
   - Window: `gnome-screenshot --window --file=/tmp/screenshot-<timestamp>.png`

5. **macOS — screencapture:**
   - Full screen: `screencapture /tmp/screenshot-<timestamp>.png`
   - Window (interactive): `screencapture -W /tmp/screenshot-<timestamp>.png`
   - Region (interactive): `screencapture -s /tmp/screenshot-<timestamp>.png`
   - With delay: `screencapture -T 3 /tmp/screenshot-<timestamp>.png`

6. Confirm the file was created and report the full path.
   Offer to open or share the file if relevant.

## Requirements
- **Linux**: `scrot` (`apt install scrot`) or `gnome-screenshot` or ImageMagick `import`.
- **macOS**: `screencapture` (built-in, no install needed).
- A graphical display must be available (`DISPLAY` env var set on Linux).
- Headless servers require Xvfb: `Xvfb :99 & export DISPLAY=:99`

## Example
```
/screenshot
/screenshot full
/screenshot window
/screenshot delay:3
```
