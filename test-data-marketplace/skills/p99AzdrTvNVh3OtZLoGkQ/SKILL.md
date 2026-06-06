---
name: spotify-control
description: Control Spotify playback (play, pause, skip, volume) via spotify-cli or MPRIS D-Bus.
trigger: /spotify, play spotify, pause spotify, skip track, next song, spotify volume, what's playing
allowed-tools: [exec.run]
---

# Skill: Spotify Control

## Purpose
Control Spotify desktop playback: play, pause, skip tracks, adjust volume,
and display the currently playing song — using `spotify-cli`, `playerctl`, or MPRIS.

## When to use
- User wants to play, pause, or skip Spotify tracks
- User wants to know what song is currently playing
- User wants to adjust Spotify volume
- User wants to play a specific playlist or track

## How to use

1. Detect available control method in order of preference:
   - `playerctl --version` — universal MPRIS controller (recommended)
   - `spotify-cli --version` — Spotify-specific CLI
   - `dbus-send --system` — raw D-Bus MPRIS commands (Linux fallback)
   - On macOS: `osascript` with Spotify AppleScript

2. **Play / Pause:**
   - playerctl: `playerctl --player=spotify play-pause`
   - spotify-cli: `spotify-cli toggle`
   - macOS: `osascript -e 'tell application "Spotify" to playpause'`

3. **Skip to next track:**
   - playerctl: `playerctl --player=spotify next`
   - spotify-cli: `spotify-cli next`
   - macOS: `osascript -e 'tell application "Spotify" to next track'`

4. **Previous track:**
   - playerctl: `playerctl --player=spotify previous`
   - macOS: `osascript -e 'tell application "Spotify" to previous track'`

5. **Get currently playing track:**
   - playerctl: `playerctl --player=spotify metadata --format "{{artist}} — {{title}}"`
   - spotify-cli: `spotify-cli status`
   - macOS: `osascript -e 'tell application "Spotify" to return (artist of current track & " — " & name of current track)'`

6. **Volume control:**
   - playerctl: `playerctl --player=spotify volume <0.0–1.0>` (e.g., `0.5` = 50%)
   - macOS: `osascript -e 'tell application "Spotify" to set sound volume to 50'`

7. **Play a specific track or playlist (spotify-cli only):**
   - `spotify-cli play spotify:track:<track_id>`
   - `spotify-cli play spotify:playlist:<playlist_id>`

8. Report the result of each action with current playback status.

## Requirements
- **Linux**: Spotify desktop app running + one of:
  - `playerctl` (`apt install playerctl`) — recommended
  - `spotify-cli` (pip install spotify-cli or see GitHub)
- **macOS**: Spotify desktop app running (AppleScript requires no extra install).
- Spotify must be actively running as a desktop application.
- MPRIS-based control does not require a Spotify API key.

## Example
```
/spotify play
/spotify pause
/spotify next
/spotify what's playing
/spotify volume 70
```
