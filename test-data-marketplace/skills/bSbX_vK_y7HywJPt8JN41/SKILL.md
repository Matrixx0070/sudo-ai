---
name: hue-lights
description: Control Philips Hue smart lights via the Hue Bridge local REST API.
trigger: /hue, hue lights, turn on lights, dim lights, change light color, hue scene, lights off
allowed-tools: [web.fetch]
---

# Skill: Hue Lights

## Purpose
Control Philips Hue smart bulbs and groups via the Hue Bridge local HTTP API.
Turn lights on/off, change color, set brightness, activate scenes, and query light status.

## When to use
- User wants to turn lights on or off
- User wants to dim or brighten lights to a specific level
- User wants to change light color (hue/saturation or color temperature)
- User wants to activate a Hue scene (e.g., "Reading", "Movie", "Relax")
- User wants to see the current state of lights

## How to use

1. Check that `HUE_BRIDGE_IP` and `HUE_USER` (API username) are set in the environment.
   If `HUE_USER` is missing, guide user through registration (see Requirements).
   Base URL: `http://$HUE_BRIDGE_IP/api/$HUE_USER`

2. **List all lights:**
   - GET `<base>/lights`
   - Present: light ID, name, on/off state, brightness.

3. **Turn a light on or off:**
   - PUT `<base>/lights/<id>/state`
   - Body: `{ "on": true }` or `{ "on": false }`

4. **Set brightness (1–254):**
   - PUT `<base>/lights/<id>/state`
   - Body: `{ "on": true, "bri": <1-254> }`
   - Natural language: "50%" → `bri: 127`, "100%" → `bri: 254`

5. **Set color (hue/saturation):**
   - PUT `<base>/lights/<id>/state`
   - Body: `{ "on": true, "hue": <0-65535>, "sat": <0-254>, "bri": <1-254> }`
   - Named colors: red≈0, yellow≈12750, green≈25500, blue≈46920, purple≈56100

6. **Set color temperature (white tones, 153–500 mireds):**
   - PUT `<base>/lights/<id>/state`
   - Body: `{ "on": true, "ct": <153-500> }` (153=cool white, 370=warm white)

7. **Control a group (room):**
   - GET `<base>/groups` to list rooms.
   - PUT `<base>/groups/<id>/action` — same body as light state.

8. **Activate a scene:**
   - GET `<base>/scenes` to list available scenes.
   - PUT `<base>/groups/<group_id>/action` with `{ "scene": "<scene_id>" }`

## Requirements
- `HUE_BRIDGE_IP` — local IP address of the Hue Bridge (e.g., `192.168.1.10`).
- `HUE_USER` — Hue API username (40-char string).
  To create: press the Bridge link button, then POST `http://<bridge_ip>/api` with `{"devicetype":"sudo-ai"}`.
- Hue Bridge and controlling device must be on the same local network.

## Example
```
/hue turn on living room
/hue dim bedroom to 30%
/hue set kitchen color blue
/hue scene "Relax" in lounge
/hue lights off all
```
