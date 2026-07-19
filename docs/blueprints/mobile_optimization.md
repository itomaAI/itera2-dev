# Mobile Optimization Notes (Issue #12)

## Context
Itera OS targets smartphone browsers (observed viewport ~413×599). Multiple Manager/Operation classes increase memory pressure.

## Action Items
- [ ] Lazy-load `ProcessManager` and `GuestCompiler` only when first app spawns.
- [ ] Profile `NodeStore` / `ContentStore` footprint on low-end devices.
- [ ] Consider flattening `VfsOperation` subclasses if bundle exceeds 500KB.
- [ ] Replace CDN deps (e.g., html-to-image) with VFS-bundled assets (see fix/process).

## Measurement
Use `performance.memory` (Chrome) and `MetaOS.device` APIs to log baseline.