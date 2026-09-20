# DrawingWeb.Blazor

`DrawingWeb.Blazor` `0.1.0-alpha.2` targets .NET 8 and .NET 10. The Razor class library contains the real DrawingWeb engine, web control and interop as local static web assets. No CDN or font download is required. Build the JavaScript distribution before packing from source.

## Controls

`DrawingEditor` is the direct editor/viewer. Bind either `Value` (JSON string) or `Document` (`DrawingDocument`), not both. `DrawingInput` derives from `InputBase<string>` and supplies `ValueExpression`, modified-field notification, CSS state and validation integration in `EditForm`. `DrawingDataEditor<TItem>` projects typed rows using caller-supplied source-generated `JsonTypeInfo<List<TItem>>`.

Native creation begins after the first interactive render; prerendering does not attempt JS interop. `Ready` fires after initial document/options/row binding have been applied. Importing the native module does not itself create a control. Wait for `Ready` before invoking operations; `IsReady` describes native creation and `IsDisposed` describes teardown state.

```razor
@using DrawingWeb.Blazor
<EditForm Model="model" OnSubmit="Save">
    <DataAnnotationsValidator />
    <DrawingInput @ref="input" @bind-Value="model.Json" Height="600px" />
    <ValidationMessage For="@(() => model.Json)" />
    <button type="submit">Save</button>
</EditForm>
@code {
    private DrawingInput? input;
    private Model model = new();
    private async Task Save() {
        await input!.FlushAsync();
        // Validate and persist model.Json through your application service.
    }
    private sealed class Model {
        [System.ComponentModel.DataAnnotations.Required]
        public string Json { get; set; } = new DrawingDocument().ToJson();
    }
}
```

Required validation checks the serialized string, not semantic drawing emptiness. Add domain validation for required shapes, topology or metadata. Flush before validation, saving or navigation when an in-place text editor may still be active.

## Revision and streaming behavior

Browser edits increment a monotonic engine revision. Notifications contain the revision rather than a truncated copy of the document. .NET retrieves a full `IJSStreamReference` snapshot; outbound values and input files use `DotNetStreamReference`. `MaxDocumentBytes` defaults to 64 MiB and `MaxFileBytes` to 128 MiB. Current operations still buffer whole payloads in memory, so set lower limits for your workload.

A delayed controlled-value echo is not allowed to overwrite newer native edits. Ordinary replacements use a compare-and-swap revision. Increase `ValueRevision` to make a deliberate external replacement authoritative. Typed-object echoes are compared against the serialized typed emission to avoid resetting history just because property ordering differs from native JSON. Application mutations to the typed model produce a different serialization and are applied as a new value.

`RowsJson`/`RowsJsonChanged`, `KeyField`, `Bindings` and `TwoWayDataBinding` provide declarative data binding. `BindRowsJsonAsync` and `BindRowsAsync<T>` expose the imperative path. The mappings use native paths such as `text`, `x`, `y`, `data.owner`, and `style.fill`. Data callbacks retrieve full streamed rows, not diagnostic snapshots. Database credentials and native drivers belong in a server service; see `DbDiagramDataSource` and [data integration](../docs/DATA.md).

## Operations and trimming

Await `Ready`, then use `GetDocumentAsync`, `GetJsonAsync`, `FlushAsync`, `AddShapeAsync`, `UpdateShapeAsync`, `SelectAsync`, `UndoAsync`, `RedoAsync`, `FitAsync` or `FocusAsync`. `ExecuteAsync` exposes a bounded command set: fit, fitSelection, focus, zoom, select, page, tool, undo, redo, delete, duplicate, group, ungroup, add, update, align, front, back, layout and addPage. Unknown commands fail rather than invoking arbitrary JS properties.

Application data crosses JS interop as `JsonElement` using explicit source-generated contracts. Browser-managed element, callback and stream references retain the framework's built-in converters. The package does not require disabling WebAssembly trimming or preserving anonymous-type constructor metadata.

`ExecuteAsync` accepts JSON scalars, arrays, string-keyed dictionaries, `JsonElement`/`JsonDocument`, and DrawingWeb document, shape, style and point models. For custom DTOs, use `JsonSerializer.SerializeToElement(value, sourceGeneratedJsonTypeInfo)` before calling it. Arbitrary anonymous or reflection-serialized DTO arguments are deliberately rejected with an actionable error. Command collections have a 64-level nesting and 100,000-value traversal limit; use document streams for bulk data.

`ImportAsync(Stream, fileName)` and `ExportAsync(format)` support JSON, VSDX, VDX, SVG and PNG as appropriate. `vsdx` uses source preservation when an imported source package is available; `vsdx-rebuild` is an explicit supported-subset rebuild. `DrawingImport` and `DrawingExport` include diagnostics. An import is rejected if edits happen while the stream/decoder is in flight.

ReadOnly blocks control mutation commands. Engine methods remain an application API, not an authorization boundary. The `Error`, `Changed`, `SelectionChanged` and `DataChanged` callbacks surface operational state. Avoid slow synchronous callbacks; no document callback gate is held across user callbacks, so a callback may legitimately call `FlushAsync` without deadlocking that gate.

## Styling and hosting

Set a measurable `Height`. Include the host application's generated `YourApplication.styles.css` so Razor CSS isolation includes the package styles. The native engine assets are served at `_content/DrawingWeb.Blazor/engine/`; `ModulePath` is available for explicit hosting customization. Standard Blazor static-web-assets hosting must be enabled.

The samples use only `PackageReference` to DrawingWeb.Blazor. Their additional restore source points to `artifacts/nuget`, produced by packing this repository. Both samples share the same exercise component, including initial value application, one-megabyte replacement, typed binding, two-way rows, native undo/redo, command patches, binary export, JSON import, an actual EditForm edit and removal/recreation.

```sh
npm ci --ignore-scripts
npm run build
mkdir -p artifacts/nuget
dotnet pack blazor/DrawingWeb.Blazor -c Release -o artifacts/nuget
dotnet run --project blazor/samples/Server -f net10.0
# Alternative Server target:
# dotnet run --project blazor/samples/Server -f net8.0
# Browser-only host:
dotnet run --project blazor/samples/WebAssembly
```

## Lifecycle and failure handling

Disposal is idempotent and awaitable through a shared task. It marks the component disposed before asynchronous cleanup, cancels pending data operations, awaits native initialization and releases the control, callback reference and module. Creation acknowledgements are not canceled mid-flight, so a handle created during removal can still be observed and released. Native host removal also disconnects the handle via MutationObserver. Late callbacks are suppressed. Expected circuit disconnections during teardown are tolerated; other cleanup failures remain observable.

An initialization failure is terminal for that control instance and is reported once through `Error` with code `INITIALIZATION`. Parent rerenders do not retry the failed task or recursively report it. Remove/recreate the component, or change its Razor `@key`, to retry after correcting the cause. Disposal still releases any imported module and callback reference; it does not rethrow the already-reported initialization failure. Errors applying later parameters are reported as `PARAMETER_UPDATE`, with duplicate failure notifications suppressed until a successful application.

Both published-host test suites include a deliberately failing sample module. They check one failure notification, no repeated creation during parent renders, no false `Ready`, safe removal and continued operation of the healthy editor.

Physical touch devices, screen readers, disconnection/reconnection policies, production CSP and application-specific database providers still need deployment qualification. The package is not a full Microsoft Visio implementation; its format boundary is in [COMPATIBILITY.md](../docs/COMPATIBILITY.md).

## Typed semantic and ShapeSheet API

The library also supplies trim-safe feature models for containers, rich text, comments, hyperlinks, recordsets/links, data graphics, themes and guides. They are part of `DrawingDocument`/`DrawingShape`, including extension-data preservation.

After `Ready`, the `DrawingEditor` partial API exposes `CreateContainerAsync`, `SetContainerMembersAsync`, `LockContainerAsync`, `FitContainerAsync`, `DisbandContainerAsync`, `CreateSwimlanesAsync`, `ReorderLaneAsync`, `CreateCalloutAsync`, `AddHyperlinkAsync`, `AddCommentAsync`, `ReplyCommentAsync`, `ResolveCommentAsync`, `SetRichTextAsync`, `ApplyThemeAsync`, `RegisterDataGraphicAsync`, `ApplyDataGraphicAsync`, `UpsertRecordsetAsync`, `LinkDataAsync`, `RefreshDataAsync`, `AutoLinkAsync`, `SetCellAsync`, `ActivateShapeSheetAsync`, `DeactivateShapeSheetAsync`, `GetCellsAsync`, `DuplicatePageAsync`, `RegisterMasterAsync` and `InsertMasterAsync`. `ExportAsync` additionally accepts `vstx` and `vssx`; a stencil export requires at least one master.

`SetCellAsync` takes a `JsonElement` cached/literal value and an optional formula. Length results use Visio inches (96 drawing pixels per inch). Enrollment persists until deactivation or document replacement; it is not equivalent to a complete native constraint system. `GetCellsAsync` can return cached values with diagnostics for unsupported formulas.

Public feature payloads are serialized through the generated model contract, not reflection or anonymous-type preservation. The shared release-mode Server/WASM exercise creates rich content, a container/callout/comment/link, evaluates a Width cell, refreshes a keyed recordset and exports a stencil. See the current Actions run for qualification results. Feature availability does not change the Visio preservation/rebuild boundary.
