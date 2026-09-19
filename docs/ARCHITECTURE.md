# Architecture and mathematical contracts

## Ownership and dependency direction

```
Studio / custom app / Blazor RCL
             |
     DrawingControl / bridge
             |
   CanvasRenderer   DiagramBinding --- ObservableTable --- DataSource
             |          |                                 REST / ADO.NET
       DiagramEngine ---+
             |
   model / geometry / layout / formula
             |
       VSDX / VDX / JSON / SVG adapters
```

The core is DOM-independent. The browser layer acquires `CanvasRenderingContext2D`, `Path2D`, `ResizeObserver` and input listeners only on construction. A control owns an engine it creates; an injected engine remains caller-owned. Bindings and subscriptions have deterministic `dispose()`. The Blazor bridge owns both its control and engine and removes them when the host is detached.

## Model and transaction semantics

A document consists of pages, layers, nested shapes, masters and JSON metadata. Identity is stable string identity, not array position. Shape positions use parent-local CSS pixels; angles are clockwise radians. Source and target connectors may reference normalized shape ports or free coordinates. Original Visio cells are retained as cached-value/formula/unit records.

Each successful outer transaction validates, freezes and publishes a new snapshot, increments a monotonic revision and records one undo entry. Nested transactions have savepoints. Exceptions or invalid geometry roll back to the appropriate snapshot. Notifications are queued so reentrant subscribers observe revisions in order. Subscriber exceptions do not retroactively undo committed state. History is bounded; scalar updates structurally share unaffected branches.

Do not mutate snapshots or perform `await` inside a transaction. Capture a revision before asynchronous work and pass it to `replaceDocument(next, expectedRevision)`. A mismatch is an explicit conflict. Undo is a new revision, never a rollback of the revision counter.

ID lookup keeps shape ancestry indexes. Scalar property updates avoid rebuilding the topology index, while matrix lookup reads the current path to avoid stale transforms within a batch. Topology mutations rebuild the index as needed. Large flat-array updates and whole-document validation are still CPU work; this alpha is not an O(1) persistent-vector implementation.

## Affine geometry

Matrices are six-tuples `[a,b,c,d,e,f]`, representing

```
x' = a*x + c*y + e
y' = b*x + d*y + f
```

Child world transforms are parent matrices multiplied by local transforms. Grouping and ungrouping retain world-space matrices; duplication recursively remaps internal endpoint references. Path resizing transforms actual path coordinates instead of accumulating hidden scale matrices. Rotation/reflection/skew are preserved in the normalized affine representation; export may bake affine transforms into geometry when a Visio XForm alone cannot represent them.

## Rendering and interaction

A retained display list stores current world matrices, routes, opacity, locked state and bounds. A uniform spatial hash maps ordinary items into occupied cells, with a separate oversized-item bucket. Viewport queries are sorted by paint order. Path2D instances are cached by shape/path signature. DPR scaling is applied once at the canvas boundary.

Pointer gestures maintain transient preview transforms. A completed gesture performs one engine mutation/history operation rather than repeatedly changing the document during every pointer event. RequestAnimationFrame coalesces invalidation. Hit testing uses the spatial broad phase followed by stroke/path or line-segment tests. Text is rendered with local installed fonts and browser metrics; no font files are bundled or implicitly downloaded.

The control has a named application surface, a mirrored shape list, an active descendant, live selection announcements, keyboard actions, and ordinary focus traversal. This is test coverage for specific semantics, not a claim of a completed hardware/screen-reader accessibility audit. Fine-grained text shaping, every Visio rich-text run and pixel-identical line wrapping are outside the current profile.

## Orthogonal routing

The router inflates obstacles by clearance, creates candidate X/Y coordinates around obstacle edges and endpoints, and searches a rectilinear visibility grid with A*. Search states include incoming axis. The objective is Manhattan path length plus a bend penalty. The heuristic is Manhattan distance, which does not overestimate the remaining cost when bend penalties are nonnegative.

Grid size and visited states are bounded. Exhaustion returns an explicit `obstructed` result and a deterministic dogleg; callers must not interpret that fallback as an obstacle-free certificate. The initial alpha recomputes routes on document revisions and does not implement hierarchical incremental route caches for enormous graphs. Routing uses rectangular bounds, not exact arbitrary-shape Minkowski obstacles.

## Layout

Directed strongly connected components are computed with Tarjan's algorithm. The condensed DAG is ranked topologically. Nodes within each rank receive deterministic spacing in a rightward or downward arrangement. Cycles are supported through condensation; this is not a complete crossing-minimization, swimlane, constraint-solving or orthogonal-embedding optimizer. Applying a layout is undoable as one transaction.

## Formula subsystem

A bounded lexer and Pratt parser implement a documented expression subset without JavaScript evaluation. Physical units normalize to pixels and angles to radians. Lazy conditionals avoid evaluating unused branches. FormulaSheet maintains dependency/dependent maps and invalidates cached values transitively. Cycles and unknown references are errors.

This engine is reusable for application rules; the VSDX reader primarily consumes cached cell values. Arbitrary ShapeSheet formulas are preserved but are not all automatically reevaluated after edits. Macro names, sheet functions and host objects do not become executable JavaScript.

## Formats and source preservation

The OPC reader resolves package relationships rather than assuming every page has a particular filename. ZIP/XML decoding is bounded. A source package retains original bytes and individual entries. No-op save returns the original bytes. A supported edit parses and patches only affected cells in affected XML parts, then writes a new ZIP. Unchanged entry payloads remain exact; recompression/container offsets may differ. Changed XML may normalize formatting/prefix details, so this is not a binary-patch promise for edited XML.

Normalized JSON is the full-fidelity format for DrawingWeb's own model. Rebuilding VSDX from it is a supported-subset conversion, not a lossless encoding of every possible imported Visio feature. Keep the original VisioPackage alive for preservation-aware save.

## Packaging

One npm version exposes ESM, CommonJS, declarations, public subpaths and a generated browser-global registry. The same compiled ESM assets are copied into the Razor class library before packing. NuGet consumers receive local static web assets at `_content/DrawingWeb.Blazor/engine/`. Build and packing fail when these assets are absent. JS and NuGet versions must match.

The studio and package-restored Server/WASM samples are integration consumers, not alternate rendering engines. The source package contains no vendored font files or Microsoft stencils.
