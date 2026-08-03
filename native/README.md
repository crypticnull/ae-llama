# AE Llama Hub — native AEGP plugin (phase 2, experimental)

C++ AEGP scaffold for the parts CEP can't do. Current scope: a
**Window ▸ AE Llama Panel** menu command that opens the CEP panel. Planned
here (see roadmap): in-process llama.cpp inference (`llama.h` linked
directly, no server subprocess) and render-hook integrations.

> **Status: scaffold, not yet compiled against a real SDK.** The CEP panel
> is fully functional without it — build this only when you need native
> features.

## Requirements

- **Adobe After Effects SDK** (May 2023 or newer) — download from
  https://developer.adobe.com/after-effects/ (free Adobe ID required).
  The SDK's license does not permit committing it to this repo; unpack it
  anywhere and point `AE_SDK_ROOT` at the folder that contains `Examples/`.
- Visual Studio 2022 (Desktop C++ workload) and CMake 3.21+.

## Build (x64)

```powershell
$env:AE_SDK_ROOT = 'C:\SDKs\AfterEffectsSDK'
cmake -S native -B native\build -A x64
cmake --build native\build --config Release
```

Output: `native\build\Release\AELlamaHub.aex`

## Install

Copy `AELlamaHub.aex` into
`C:\Program Files\Adobe\Adobe After Effects <year>\Support Files\Plug-ins\`
(admin required) and restart AE. A new **AE Llama Panel** item appears in
the **Window** menu.

## Notes for later phases

- In-process inference: link `llama.cpp` as a static lib, run generation on
  a worker thread, marshal results back via `AEGP_RegisterIdleHook` (AEGP
  suites are main-thread-only).
- Render hooks: `AEGP_RegisterRenderQueueMonitor` for queue events;
  frame-level work belongs in an effect plugin (different plugin kind).
