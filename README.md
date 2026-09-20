# DrawingWeb

A reusable, data-bound diagram engine, an accessible browser drawing control, and a self-contained Blazor component library. The ribbon-based studio is an actual consumer of the engine: canvas edits, property edits, table edits and undo all operate on the same model.

**Version:** `0.1.0-alpha.3` · **License:** MIT · **JavaScript runtime dependencies:** none.

- [Studio / GitHub Pages](https://wieslawsoltes.github.io/DrawingWeb/)
- [Blazor WebAssembly sample](https://wieslawsoltes.github.io/DrawingWeb/blazor/)
- [npm package](https://www.npmjs.com/package/@wieslawsoltes/drawingweb)
- [NuGet package](https://www.nuget.org/packages/DrawingWeb.Blazor)
- [Build and release runs](https://github.com/wieslawsoltes/DrawingWeb/actions)

## Compatibility is a contract, not a marketing claim

DrawingWeb implements documented **VSDX and VDX interchange profiles** and a preservation-first VSDX editing contract. It is **not fully Microsoft Visio compatible**. Binary VSD, the complete ShapeSheet language, complete Visio text/theme/geometry fidelity, native ODBC/OLE DB execution, complete stencil inheritance, native data-graphic masters and macro execution are not implemented. No desktop Microsoft Visio visual-fidelity certification has been performed.

An unchanged imported VSDX is returned byte-for-byte. Supported scalar edits patch selected XML cells while preserving unrelated package parts. Unsupported edits are rejected in preservation mode rather than silently destroying source content. A separate, explicitly labeled rebuild mode writes only supported DrawingWeb content. See [the compatibility matrix](docs/COMPATIBILITY.md).

## Packages and modules

The package follows the ESM / CommonJS / TypeScript declaration / browser-global layout used in RichTextWeb and GridWeb, with public subpath entry points:

| Entry point | Responsibility |
| --- | --- |
| `@wieslawsoltes/drawingweb/core` | Immutable documents, validated transactions, history, selection, grouping, masters |
| `/geometry`, `/layout` | Affine geometry, spatial indexing, connector routing, graph layout |
| `/formula`, `/shapesheet` | Sandboxed expressions and opt-in transactional cell dependencies/projection |
| `/features`, `/text` | Containers/lists/swimlanes, callouts, comments, themes, recordsets and shared rich-text layout/editing |
| `/data` | Typed observable tables, two-way binding, REST/ETag transport, CSV, IndexedDB CAS |
| `/io` | OPC/ZIP/XML, VSDX preservation, VDX and vector SVG export |
| `/web` | Retained Canvas 2D renderer, drawing control, custom element registration |
| `/mvvm` | Observable properties, asynchronous commands and diagram view model |
| `/bridge` | Streaming, revision-aware native Blazor interop |
| `DrawingWeb.Blazor` | .NET 8 / .NET 10 Razor components, source-generated models, server-side ADO.NET adapter |

The modules are independently importable **subpaths of one versioned npm package**, not separately published packages. DOM globals are not touched merely by importing the core or web modules in Node/SSR. The browser global exposes `DrawingWeb` and `DrawingWebBridge`.

## JavaScript / TypeScript

```sh
npm install @wieslawsoltes/drawingweb@0.1.0-alpha.3
```

```ts
import {
  DiagramEngine, DrawingControl, ObservableTable, DiagramBinding,
  createDocument, createShape,
} from '@wieslawsoltes/drawingweb';

const engine = new DiagramEngine(createDocument('Order processing'));
const pageId = engine.document.pages[0]!.id;
const rows = new ObservableTable('id', [], [
  { id: 'order', label: 'Validate order', x: 100, y: 100 },
  { id: 'stock', label: 'Reserve stock', x: 420, y: 100 },
]);
const binding = new DiagramBinding(engine, rows, {
  pageId,
  mappings: { text: 'label', x: 'x', y: 'y' },
  twoWay: true,
  factory: () => createShape('roundRect', { width: 200, height: 80 }),
});
engine.add(pageId, createShape('connector', {
  source: { shapeId: 'order' }, target: { shapeId: 'stock' },
  style: { fill: 'none', endArrow: true },
}));
const host = document.querySelector<HTMLElement>('#diagram')!;
const control = new DrawingControl(host, { engine, grid: true, snap: true });
control.fit();
rows.update('order', { label: 'Validated' }); // updates the shape
engine.move(['order'], 20, 0);               // writes x back to the row
engine.undo();                              // row follows the undone geometry

// On unmount: a control does not dispose an engine it borrowed.
binding.dispose(); control.dispose(); rows.dispose(); engine.dispose();
```

The host must have a measurable height, for example `height: 600px`. Call `registerDrawingElement()` for `<drawing-web>` or integrate `DrawingControl` directly into your own component lifecycle. No global stylesheet is required by the control; studio styling is separate.

## Blazor

```sh
dotnet add package DrawingWeb.Blazor --version 0.1.0-alpha.3
```

```razor
@using DrawingWeb.Blazor

<DrawingEditor @ref="editor"
               @bind-Document="diagram"
               @bind-RowsJson="rows"
               Bindings="bindings"
               KeyField="id"
               Height="600px"
               Ready="OnReady" />

@code {
    private DrawingEditor? editor;
    private DrawingDocument diagram = new();
    private string rows = "[{\"id\":\"a\",\"label\":\"A bound process\",\"x\":100,\"y\":100}]";
    private readonly IReadOnlyDictionary<string, string> bindings =
        new Dictionary<string, string> { ["text"] = "label", ["x"] = "x", ["y"] = "y" };
    private Task OnReady() => editor!.FitAsync();
}
```

`DrawingEditor` supports JSON or typed-document binding, commands, selection, import/export, streamed row binding, read-only state and revision-aware replacement. `DrawingInput` integrates with `EditForm` and validation. `DrawingDataEditor<TItem>` adds source-generated typed row binding. The RCL contains all JS assets; use your host's generated `.styles.css` link for CSS isolation. Server and WebAssembly samples restore the **packed NuGet**, not a project reference. See [Blazor integration](blazor/README.md).

Application interop payloads use explicit JSON contracts rather than reflection over anonymous types. The published WebAssembly consumer is tested with assembly trimming enabled. Initialization errors are reported once per control instance; remove and recreate the control to retry initialization.

## What the editor does

The workspace has File/Backstage, eight ribbon tabs, command search, a Shapes/templates/masters pane, zoom-aware rulers, page tabs, external data, and Format/Layers/Review/ShapeSheet task panes. Commands act on the same transactional model rather than a UI-only mockup.

New semantics include independent container/list membership, auto-fitting and membership locks; horizontal/vertical swimlane pools; attached callouts; comment replies/resolution; hyperlinks; rich-text runs/paragraphs and in-place formatting; original theme tokens; conditional data graphics; keyed recordsets with exact auto-link and explicit refresh; background pages; embedded raster pictures; and VSSX/VSTX package profiles. `/shapesheet` provides opt-in unit-aware cell evaluation and dependency projection, not the full Visio constraint language. See [the detailed functionality/parity review](docs/VISIO_PARITY_REVIEW.md).

Multi-page documents; 11 original stencils; arbitrary vector paths; affine groups; selection/marquee; drag, resize and rotate; attached connectors; obstacle-aware routing; freehand simplification; text editing; layers; z-order; alignment; duplicate/copy/paste; deterministic undo/redo; pan/zoom; keyboard navigation; SVG/PNG export; validated import; property inspector; editable external-data table; CSV; local compare-and-swap persistence. The renderer caches paths/display items and spatially culls the viewport. It is Canvas 2D, **not WebGPU**, and no million-entity frame-time claim is made.

Database access uses application-owned REST endpoints or the server-side `DbDiagramDataSource` provider-neutral ADO.NET adapter. Credentials and SQL are never accepted from a drawing file or browser configuration. See [database integration](docs/DATA.md).

## Build, test, run

```sh
npm ci --ignore-scripts
npm run check
python -m pip install playwright
python -m playwright install chromium
npm run test:browser
node scripts/serve.mjs site
```

Open `http://localhost:4173/`. `npm run dev` serves the repository; open `/sample/` after building. Core/format tests run under Node. Browser tests interact with real Chromium. The package smoke test installs the tarball into a clean offline consumer and checks ESM, CommonJS, subpath exports and declarations.

```sh
mkdir -p artifacts/nuget
dotnet pack blazor/DrawingWeb.Blazor/DrawingWeb.Blazor.csproj -c Release -o artifacts/nuget
dotnet run --project blazor/samples/Server -f net10.0
# The Server consumer also targets .NET 8:
# dotnet run --project blazor/samples/Server -f net8.0
# Browser-only host:
dotnet run --project blazor/samples/WebAssembly
```

Build JS before packing the RCL. Both .NET 8 and .NET 10 SDK/runtime families are used by release validation. Authoritative .NET results are the package-restored CI runs, not an inferred local success.

## Release qualification and documentation

[Parity review](docs/VISIO_PARITY_REVIEW.md) · [Architecture](docs/ARCHITECTURE.md) · [Visio compatibility](docs/COMPATIBILITY.md) · [Data adapters](docs/DATA.md) · [Security](docs/SECURITY.md) · [Publishing](docs/PUBLISHING.md) · [Changelog](CHANGELOG.md).

Publishing is gated by native tests, browser tests, clean npm-consumer checks, .NET builds, packed-NuGet consumer builds, and Server/WASM browser checks. The integration tests include actual EditForm edits and an intentionally failing native initialization to verify bounded error reporting and disposal. `NPM_TOKEN` and `NUGET_API_KEY` are used only in the publishing jobs. Registry links above identify package destinations; a workflow file alone is not evidence of successful publication. Consult the release run and registry version for the actual status.


## Live inheritance and native qualification (alpha.3)

`MasterService` propagates bound style/cell/text channels while retaining per-channel local overrides.
`ShapeSheetService.setUserValue()` adds GUARD and bounded SETATREF/SETATREFEXPR/SETATREFEVAL
write semantics to the supported geometry profile. `TextFieldService` explicitly activates retained
native text-field formulas; unsupported fields keep their cached display. `readOfficeTheme()` and
`readOfficeThemePackage()` import an explicit DrawingML color palette and Latin font names.

See [live-feature contracts](docs/LIVE_PARITY.md) for API examples and exact limitations, and
[native desktop qualification](docs/NATIVE_VISIO.md) for the optional Windows/installed-Visio
legacy conversion and reference capture tool. These additions do not establish full Visio parity.
