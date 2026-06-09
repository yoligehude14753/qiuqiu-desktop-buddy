# Changelog

## 0.9.2

- Fixed the core "can't understand the screen" issue: detect macOS Screen Recording permission and guide the user to grant it when frames come back empty.
- Capture across all displays and pick the most content-rich frame, so a match on a second monitor is no longer missed.
- Detect blank/wallpaper-only frames (no permission or no windows) and skip commenting instead of talking nonsense.
- Reworked the screen-reading prompt to read-before-classify (grounded `seen` field) and to reliably enter sports mode on real match footage; lowered temperature for stable classification.
- Bundled the service endpoints into the app (screen reading via Kimi, speech via built-in CosyVoice): users only paste one self-generated Kimi key and everything else works out of the box.
- Replaced the editable TTS URL with a built-in CosyVoice endpoint and a real Chinese voice picker (温柔女 / 知性女 / 磁性男 / 童声), defaulting to a warm female voice.
- Routed speech through the public Cloudflare gateway (tts2.yoliyoli.uk) instead of the Tailscale relay: cut synth latency from 12-30s back to ~2s and made it reachable for any user, not just the tailnet.

## 0.9.1

- Added a voice test button for macOS system speech.
- Added clearer startup guidance when Kimi API Key is missing.
- Prevented the app from entering a misleading running state without a saved Key.
- Switched release artifact name to ASCII for stable GitHub downloads.

## 0.9.0

- First public prototype of Qiuqiu Desktop Buddy.
- Added floating transparent Electron desktop window.
- Added user-provided Kimi API Key configuration.
- Added Kimi K2.6 screen understanding and JSON motion plan generation.
- Added sprite-based avatar actions, Live2D runtime option, system speech, local history, stats, pause, quit, mouse pass-through, and window recall.

