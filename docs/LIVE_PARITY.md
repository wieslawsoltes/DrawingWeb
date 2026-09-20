# Live master, ShapeSheet and field contracts

This alpha.3 increment implements a defined executable subset, not the complete Visio runtime.
All changes are available to the npm engine, native control, sample and self-contained Blazor RCL.
No imported expression starts executing merely because a file was opened.

## Master inheritance

```ts
import { DiagramEngine, MasterService, createShape } from '@wieslawsoltes/drawingweb';
const engine = new DiagramEngine();
const definition = createShape('roundRect', {text: 'Task', style: {fill: '#dbeafe'}});
const masterId = engine.registerMaster('Task', 'Workflow', definition);
const shapeId = engine.instantiateMaster(masterId, engine.document.pages[0]!.id, 100, 100);
const masters = new MasterService(engine);
engine.update(shapeId, {style: {fill: '#fef3c7'}}); // Only fill becomes local.
masters.update(masterId, {shape: {...definition, text: 'Review task'}});
masters.restore(shapeId, {style: ['fill']}); // Rejoin this channel.
masters.detach(shapeId); // Keep materialized values, detach the subtree.
```

Each binding stores the master definition's source-shape identity and explicit inherited channels.
Style fields, cells, and text can be inherited independently. Local writes remove only changed
channels. Definition updates and instance propagation form one transaction and one undo record.
Copy remaps instance IDs, not their definition IDs. Source shape IDs must remain stable when editing
definitions. Removing a bound source is rejected until its instances are detached. Adding/deleting
master subshapes and universal native constraint/master/style-chain authoring are not implemented.
New definition channels require an explicit restore to enroll them; geometry and ports remain local.
Formula-result and text-field display caches do not constitute authoring overrides.

Bindings survive normalized JSON and typed Blazor round trips. Native Visio import resolves cached
XML inheritance per cell, preserving sibling cells in a partially overridden row, named row identity,
Inh local cached values, deletion tombstones, and inherited children. Live bindings are automatically
created for new DrawingWeb master instances, not inferred for every imported native instance.
VSDX reconstruction currently materializes live channels as local shapes and emits a diagnostic;
use JSON to keep DrawingWeb live bindings and source-package preserve mode to keep native parts.

## User writes are different from formula authoring

```ts
import { ShapeSheetService } from '@wieslawsoltes/drawingweb/shapesheet';
const sheet = new ShapeSheetService(engine);
sheet.setCell(shapeId, 'User.Size', 2);
sheet.setCell(shapeId, 'Width', 2, 'SETATREF(User.Size)');
sheet.setUserValue(shapeId, 'Width', 3); // Updates User.Size; keeps the Width formula.
// engine.resize(...) takes the same user-write path for explicitly enrolled geometry.
sheet.setCell(shapeId, 'Width', 3, 'GUARD(User.Size)');
// setUserValue now rejects FORMULA_GUARD atomically, without mutating the drawing.
// setCell is explicit authoring and can replace the guarded formula.
```

The geometry profile includes Width, Height, PinX, PinY and Angle in inches/radians. It supports
unconditional SETATREF chains (ten cells max), SETATREFEXPR stored user values, SETATREFEVAL
write-time folding, parent and page-local Sheet.N references. Conditional redirect evaluation,
cross-sheet assignments with unresolved local expression scopes, page/document writes, extra affine
transforms, text-block/control-point/connector-endpoint user-write semantics and arbitrary native
actions remain explicit errors or unsupported boundaries, not guessed approximations. GUARD is not
a substitute for model-level edit permissions; explicit formula authoring can replace a formula.

## Formula-preserving text fields

```ts
import { TextFieldService } from '@wieslawsoltes/drawingweb/fields';
engine.update(shapeId, {richText: {paragraphs: [{runs: [
  {text: 'Amount: '}, {text: 'cached', field: {formula: 'Prop.Amount', format: '#,##0.00'}}
]}]}});
const fields = new TextFieldService(engine, sheet);
fields.activate([shapeId]);
engine.update(shapeId, {data: {Amount: 1234.5}}); // Shows Amount: 1,234.50.
fields.deactivate([shapeId]); // Keeps formula and display cache.
fields.dispose(); sheet.dispose();
```

Fields retain native Value.F, cached Value.V/Value.U, Format and fld indices on import/export.
Explicit format pictures are emitted as FORMAT expressions. Supported pictures are `@`, `0`,
`0.00` (up to twelve zero decimal places), `#,##0.00`, and optional percent. Units/date/calendar
pictures and native nonzero numeric format IDs retain cached display with diagnostics. Locale for
this numeric profile is deliberately en-US, not inferred from the document or computer.

Fields use the existing pure-expression subset and PAGENAME/PAGENUMBER/FORMAT. PAGECOUNT and
DOCTITLE are DrawingWeb convenience functions in this profile; cross-application evaluation of
those extensions is not certified. Native language-specific/universal page-name distinctions are
not separately modeled. Unsupported expressions retain display caches and yield diagnostics.
Field recalculation runs in the same transaction as data/geometry edits. Activation is service state,
cleared on document replacement, not serialized permission to execute imported expressions.

## Office palette and font import

`readOfficeTheme(xml)` reads a DrawingML theme's color scheme and major/minor Latin font names.
`readOfficeThemePackage(bytes)` enumerates candidate theme parts in THMX/VSDX-family packages;
a caller must choose between multiple candidates rather than guessing page variants.

sRGB and system lastClr colors are supported, including ordered tint/shade/alpha/alphaMod transforms.
Unknown colors/transforms are rejected or diagnosed. The required dark/light/accent1 slots must
resolve; additional missing slots are reported. Fonts are named, never bundled. Quick Style/effect
matrices, color/connector variants, theme indices, gradients and script-specific font substitution
are not reconstructed. Explicit application uses DrawingWeb's existing token/materialized style API.

## Blazor and workspace

The Developer ribbon exposes master editing/restoration/detachment, field insertion/activation/freezing,
and user-value assignment; Design includes Office theme import. Commands operate on the actual engine.
The RCL exposes the same operations through source-generated payloads. Owned field/sheet services are
disposed with the interop handle and the sample workspace. The release-mode Server/WASM self-test
executes the new APIs; refer to the actual qualification run, not this document, for pass/fail status.

## Primary references

- https://learn.microsoft.com/en-us/office/client-developer/visio/about-the-shapesheet-spreadsheet
- https://learn.microsoft.com/en-us/office/client-developer/visio/setatref-function
- https://learn.microsoft.com/en-us/office/client-developer/visio/setatrefexpr-function
- https://learn.microsoft.com/en-us/office/client-developer/visio/guard-function
- https://learn.microsoft.com/en-us/office/client-developer/visio/cell-element-field-sectionvisio-xml
- https://learn.microsoft.com/en-us/office/client-developer/visio/fld-element-text_type-complextypevisio-xml
- https://learn.microsoft.com/en-us/office/client-developer/visio/format-function
- https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.tint
- https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.shade
