# Changelog

## 0.1.0-alpha.3

- Fix cell-granular native master/style inheritance, Inh cached values, deleted-row tombstones,
  partial master child collections, style cycles and inheritance recursion limits.
- Add persistent live master channels, atomic definition edits, per-channel local overrides,
  restore/detach, and cached-field-safe propagation. Geometry remains instance-local.
- Add GUARD-respecting user writes, SETATREF assignment routing, SETATREFEXPR storage,
  SETATREFEVAL write-time folding, parent references and rollback on cyclic/unsupported writes.
- Read and write native Field rows/fld markers without flattening formulas; opt-in live fields
  and explicit deterministic numeric formatting with cached fallback diagnostics.
- Add DrawingML palette/Latin font import and explicitly supported ordered color transforms.
- Add corresponding typed, source-generated Blazor models/APIs and functional ribbon controls.
- Add optional local Windows/installed-Visio legacy conversion, PNG/SVG reference capture,
  a hashed manifest, an import conformance gate, and a no-resampling PNG difference tool.
- Add regression tests and retain explicit parity boundaries; full native desktop qualification
  and portable binary/metafile/complete ShapeSheet/Quick Style support are not claimed.


## 0.1.0-alpha.2 — semantic workspace expansion

Added semantic containers/lists and auto-fitting membership locks, cross-functional pools, callouts, comments/replies, hyperlinks, rich runs/paragraphs/editing, shared Canvas/SVG layout, embedded raster media, background pages, original themes and derived data graphics. Added typed recordsets, stable-key linking/refresh, ADO XML and native Visio recordset/row-map projection. Added opt-in unit-aware ShapeSheet dependency projection and VSSX/VSTX package profiles, including unplaced master media.

Replaced the compact sample toolbar with an eight-tab ribbon, Backstage, command search, rulers, Shapes/templates/masters, external data and Format/Layers/Review/ShapeSheet task panes. Added typed Blazor feature models and APIs without disabling WebAssembly trimming. Expanded coverage to 88 Node tests and 43 local offline-browser checks, plus clean npm-consumer qualification of 12 subpaths. New regression checks cover semantic movement, membership locks, duplication, stable keyed refresh, cached unsupported formulas, native text runs and row maps, template/stencil packages, ribbon commands, comments, rich editing, embedded image pixels and independent print visibility. CI additionally exercises HTTP/IndexedDB and package-restored Blazor hosts.

Fixed synchronous page reconciliation during document replacement, page removal and redo. Both plain and rich in-place editors cancel on document replacement, including replacements reusing shape IDs. Native browser qualification now treats observer console errors as failures.

Full Microsoft Visio parity and independent desktop fidelity certification remain outstanding; see the detailed parity review.

## 0.1.0-alpha.1

Initial independently implemented release: immutable transactional engine, affine geometry, master instantiation, spatially culled Canvas editor, orthogonal routing, SCC layout, sandboxed formulas, two-way table binding, REST revisions, CSV, IndexedDB, ZIP/XML/VSDX/VDX/SVG, package-preserving VSDX scalar editing, compact live-data studio, ESM/CommonJS/types/global distributions, Blazor .NET 8/.NET 10 components, streamed revision-aware interop and package-restored samples.

Regression coverage includes nested transaction rollback; history/data feedback; affine grouping; duplicate endpoint remapping; ZIP limits and CRCs; forbidden XML entities; unknown-part preservation; a font-reference corruption bug fixed by patching only changed style cells; asynchronous stream conflicts; one-megabyte snapshots; native disposal; and real pointer/text/connector interactions.

This alpha is not full Microsoft Visio parity. The compatibility matrix is part of the release contract.
