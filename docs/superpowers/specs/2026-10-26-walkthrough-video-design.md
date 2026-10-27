# Walkthrough video — design

Status: approved in conversation, 2026-10-26. Sub-project 2 of 3. Builds on
the code diagram (`2026-10-26-code-diagram-design.md`).

## Goal

Turn a repository's diagram into a short MP4 tour, inside the extension, with
no external tools. Everything the video asserts about the code is checked
against the import graph, as with the diagram's labels.

## Presets

| | Onboarding | Share |
|---|---|---|
| Length | 60–90 s | 20–30 s |
| Stops | ≤ 14, ~5 s each | ≤ 6, ~3 s each |
| Format default | 16:9 (1920×1080) | 9:16 (1080×1920); 1:1 (1080×1080) available |
| Opening | Title card | Hook card |

## 1. Tour script — `packages/core/src/tour.ts`, `tour-script.ts`

Pure data, no DOM.

- `planTour(graph, view, labels | undefined, preset): Tour` — deterministic.
  Starts at the entry and boxes with no incoming link (ordered by out-degree),
  then walks links outward breadth-first; a cluster whose boxes are all
  unvisited may be taken as one stop. Captions from labels, exported names and
  lead comments ("book.js — Book experience. Uses 14 modules, including …").
- `TOUR_PROMPT`, `tourRequest(graph, view, labels)` — outline, labels, candidate
  stops (box ids and clusters) and links. Never code.
- `validateTour(graph, view, raw, preset): { tour, dropped, warning? }` —
  stops must name a real box or cluster; highlighted links must be real;
  captions ≤ 120 chars; file paths named in captions must exist
  (`checkGrounding`). Fewer than 3 valid stops → `planTour` fallback with a
  warning.

```ts
interface TourStop { target: string; kind: 'box' | 'cluster'; caption: string;
  links: Array<{ from: string; to: string }>; ms: number }
interface Tour { title: string; hook?: string; preset: 'onboarding' | 'share';
  stops: TourStop[]; totalMs: number }
```

## 2. Rendering — extension

- `diagram-video.ts`: `frame(ctx, t, scene)` draws one frame on a 2D canvas as a
  pure function of time. Scene = layout (via `layoutToFit` at the video aspect),
  tour, palette, size. Timeline: title/hook → overview build-in → stops (camera
  ease to target, highlight, links draw in, caption types in as lower third) →
  outro (zoom out, counts, repo URL, "Made with GitScribe").
- `timeline(tour)` → segments with start/end; `cameraAt(t)` eased. Pure, tested.
- `video-encode.ts`: WebCodecs `VideoEncoder` H.264 (`avc1.640028`), 30 fps,
  keyframe every 2 s, ~6 Mbps, muxed by `mediabunny@1.61.3` into an in-memory
  MP4. If H.264 is unsupported → VP9 WebM with a notice. Progress + cancel.
  Runs in the panel page (WebCodecs is not available in the worker).

## 3. Surface

- **Make video** in the Diagram tab once a diagram exists → options: preset,
  format, script (code-only / AI). AI goes through the same review gate as
  labelling (what is sent, destination, size). Preview plays `frame(t)` in real
  time; Render downloads `<repo>-tour.mp4`. Dropped AI claims are reported.
- Video code and mediabunny are lazy-loaded on first use.

## Non-goals

Voiceover, music, MCP tool (sub-project 3), saved or editable tours.

## Testing

- `tour.test.ts`: real stops and links only; preset length bounds; invented
  stop/link cut; caption naming a fake file rejected; garbage → fallback.
- `video-timeline.test.ts`: segment at t, camera easing endpoints, total length.
- Live: encode a 2 s clip in headless Chromium; check MP4 `ftyp` header,
  duration and dimensions; render the paintBrush tour and inspect frames.
