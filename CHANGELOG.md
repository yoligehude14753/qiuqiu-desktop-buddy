# Changelog

## 0.9.6

- Simplified back to the design that worked: per-frame screen-reading with the original (June-7) neutral prompt — a general desktop companion that only switches to football mode when there is actually a match on screen.
- Removed the entire proactive/autonomy engine (greeting / curiosity / scene-change). This was the source of the "consecutive openings" and meaningless filler. The buddy now only speaks based on the current screen.
- Client-side dedup so it never repeats the same/similar line consecutively.
- Removed the home-team line from the per-frame prompt (it was leaking football into non-sports screens).
- Voice = CosyVoice2/longxiaochun_v2 via the public gateway, audio returned inline with the comment. Football costume + GOAL/confetti only when actually watching sports.
- Default screen model = Qwen3-VL (no key, ~2s); Kimi K2.6 selectable.

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

