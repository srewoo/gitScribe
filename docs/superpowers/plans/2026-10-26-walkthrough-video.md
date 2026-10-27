# Walkthrough Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a checked, diagram-based MP4 tour of a repository inside the extension.

**Architecture:** Core plans and validates a `Tour` (pure). The panel draws each frame as a pure function of time on a canvas and encodes with WebCodecs + mediabunny.

**Tech Stack:** TypeScript strict, node:test, WebCodecs, `mediabunny@1.61.3`, canvas 2D.

**Spec:** `docs/superpowers/specs/2026-10-26-walkthrough-video-design.md`

## Global Constraints

- Tour stops and highlighted links must exist in the graph; captions naming files must name real files.
- Model input: outline, labels, candidate stops and links. Never code.
- Onboarding 60–90 s, ≤ 14 stops; Share 20–30 s, ≤ 6 stops.
- `mediabunny` pinned to `1.61.3`. Lazy-loaded.
- New files ≤ 300 lines. Do not commit.

---

### Task 1: Tour planning + validation (core)
Create `core/src/tour.ts`, `core/src/tour-script.ts`, `core/test/tour.test.ts`; export from index.
Produces `planTour`, `tourRequest`, `validateTour`, `TOUR_PROMPT`, `Tour`, `TourStop`, `TourPreset`.
Tests per spec §Testing, written first.

### Task 2: Timeline + frame drawing (extension)
Create `extension/src/video-timeline.ts` (pure: `timeline`, `segmentAt`, `cameraAt`, `ease`),
`extension/src/diagram-video.ts` (`frame(ctx, t, scene)`), `extension/test/video-timeline.test.ts`.

### Task 3: Encoder (extension)
Create `extension/src/video-encode.ts`: `encodeTour(scene, { onProgress, signal }) → Promise<{ blob, type, fallback? }>`.
Add `mediabunny@1.61.3`. Live check: 2 s encode in headless Chromium, verify `ftyp` and size.

### Task 4: UI
Create `extension/src/video-view.ts`; add Make-video controls to the Diagram pane; background `tourScript` message
(model call, same key handling as `labelDiagram`). Preview + render + report.

### Task 5: Docs + live
README Video section. Render the paintBrush tour in both presets; extract frames and inspect.
