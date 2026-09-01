# Clean Impact Showcase Design

Date: 2026-08-27
Branch: `fix/stabilize-editor`
Status: Approved in conversation

## Objective

Create a second, persistent Repurpose Studio project that demonstrates the editor's main visual and audio tracks without changing the existing user project. The result should feel like a clean professional edit with short, deliberate feature-reel accents and include a playable MP4 export.

## Source Safety

- Treat `IMG_6849.MOV` and its SRT as read-only inputs.
- Record the MOV size, last-write time, and SHA-256 before and after the workflow.
- Record the existing `Downloads/repurpose-projects/hoje-18h30-tem-26-aug-26.json` size, last-write time, and SHA-256 before and after the workflow.
- Never open the existing `hoje-18h30-tem-26-aug-26` project for editing.
- Create and persist a separate project through the editor UI.
- Keep generated screenshots and the MP4 outside Git.

## Editing Direction

The approved direction is **Clean Impact**, combining the restraint of the clean-professional option with two short feature-reel moments.

- Format: vertical 9:16, about 10 seconds.
- Base layout: Screen above Face, approximately 57/43.
- Captions: Inter, white text, coral active-word emphasis, strong but compact weight.
- Video rhythm: retain the full message, add two visible edit boundaries, and use a short jump cut only if it does not damage speech.
- Color: light contrast and saturation adjustments, no aggressive grade.
- Overlays: one image accent near the first third and one short video accent near the final third.
- Music: one low-gain full-length bed derived by looping the deterministic 3-second fixture into a temporary duration-matched WAV outside Git.
- SFX: generate the editor's built-in offline SFX track and keep it below narration.
- Export: 1080x1920 H.264/AAC MP4.

## UI Workflow

1. Start at the project hub and create a new provisional project.
2. Load the real `IMG_6849.srt` from the user's Downloads folder as the raw transcript, wait for the route to change from `new-*` to the durable project ID, and record that ID before further editing. Then load the same SRT as the final transcript. Record its resolved path only in ignored execution evidence.
3. Select the protected MOV for both Screen and Face.
4. Wait for compatibility and preview-proxy preparation to finish.
5. Set the split ratio and light Screen/Face grade.
6. Select Inter and configure the caption palette and placement.
7. Add edit boundaries at useful phrase transitions.
8. Place `tests/fixtures/generated/overlay.png` and `tests/fixtures/generated/overlay.mp4` at separate timeline points.
9. Use ffmpeg to loop `tests/fixtures/generated/music.wav` into a temporary WAV matching the persisted project duration, import it through the UI, and reduce its gain.
10. Generate the local SFX track and reduce its gain if needed.
11. Save, reload, reopen from the hub, and verify playback.
12. Export the complete project and validate the MP4.

## External Repository Boundary

- Use the offline SFX feature already integrated from the MIT-licensed subset of `soundeffects-claude-code`.
- Do not install or invoke Whisper, OpenAI, or the original Claude plugin.
- Do not integrate `leadgenman-video-skills`; its six workflows remain external to the web editor.

## Verification

- The hub lists both the original project and the new showcase project.
- Reload and hub reopen preserve clips, captions, overlays, music, SFX, grade, and split ratio.
- Play advances both decoded media and the composited canvas without browser errors.
- Timeline visibly contains video, captions, overlay, music, and SFX tracks.
- The exported file decodes in Chrome and ffprobe reports 1080x1920 H.264 video, AAC audio, and duration within 0.05 seconds of the persisted project duration.
- Export requests use authoritative working paths and never `quality=proxy`.
- The original MOV and existing project JSON size, timestamp, and SHA-256 remain unchanged after all cleanup and export work.

## Failure Handling

If an import, local SFX render, or export fails, capture the exact UI/API error and stop changing the new project until the cause is understood. Do not compensate by modifying the original project or source media.
