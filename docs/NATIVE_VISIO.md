# Optional native Visio desktop bridge and qualification

The portable npm/Blazor engine does not decode binary VSD/VSS/VST or reproduce the entire native
Visio typography, metafile, ShapeSheet, COM/VBA/add-on stack. The optional `tools/DrawingWeb.VisioDesktop`
CLI supplies a separate **installed-Visio-backed** conversion/reference-capture path on Windows.
It is not a portable decoder, not included in the browser bundle, and not a hosted Office service.
An installed, licensed Visio 2013+ and an interactive Windows desktop are required.

## Build and capture

```powershell
dotnet build tools/DrawingWeb.VisioDesktop -c Release
dotnet run --project tools/DrawingWeb.VisioDesktop -c Release -- snapshot C:\fixtures\flow.vsd C:\captures\flow --allow-native-visio
```

Input: VSD/VSS/VST, VSDX/VSSX/VSTX, VDX/VSX/VTX. The output directory must not already exist.
The adapter launches its own InvisibleApp, never attaches to the user's active Visio session,
opens a copy, saves a converted VSDX/VSSX/VSTX as appropriate, renders native PNG/SVG per page,
and captures page sizes, shape hierarchy/text and an explicit list of geometry/style/formula cells.
Stencil captures also enumerate native master shape hierarchies. A manifest contains source SHA-256,
Visio version, converted filename, and output hashes. Publication is an atomic directory rename
only after capture succeeds. The input hash is checked again before reporting success.

The manifest is an integrity record, not a signature proving who ran Visio. The conversion is performed
by Microsoft's installed application; its installed filters, fonts, export settings, document type
behavior and licensing determine the native result. COM compilation/help tests do not exercise Visio.
Native execution and desktop save/reopen/edit certification have not been performed by this change.

## Safety and deployment boundaries

`EventsEnabled=0` suppresses Visio event processing and RUNADDON operands. OpenEx uses Copy, DontList,
Hidden, MacrosDisabled, NoWorkspace and DeclineAutoRefresh; AlertResponse uses Cancel rather than
silently accepting a prompt. The CLI never invokes macros, refreshes recordsets, executes SQL,
activates embedded OLE objects or supplies drawing-derived credentials. It does not expose arbitrary
COM dispatch as an HTTP endpoint. Macro-enabled OPC extensions are rejected.

These flags are **not an OS sandbox or a guarantee against every native/COM add-in/network side effect**.
Use a disposable network-isolated VM for untrusted files, with no user credentials or add-ins, and
an external process/job timeout. The adapter does not kill arbitrary VISIO.EXE processes. Office
Automation is not a supported replacement for an unattended multi-tenant rendering server. A failure
or blocked modal operation requires owner-supervised desktop handling, not relaxed macro security.

## Import conformance gate

```sh
npm run build
node scripts/qualify-visio.mjs /path/to/capture
```

The script verifies each manifest file hash and imports the converted package. It compares page size,
shape count/native identity/text and selected untransformed 2D dimensions/angles. It writes normalized
JSON, DrawingWeb SVG per page and a report to a new `drawingweb-comparison` directory. Missing native
IDs, differences and import warnings cause a nonzero exit; shape matching never guesses from text.
This comparison does not cover native master edits, data refresh, every cell, or rendering.

For reference-render comparison, produce a DrawingWeb PNG with matching page bounds/export resolution.
Then run the separate no-resampling image gate (Pillow is a development-only Python requirement):

```sh
python scripts/compare-png.py reference.png drawingweb.png new-diff-directory
# Optional explicit, recorded tolerances; default is pixel-exact equality:
python scripts/compare-png.py reference.png drawingweb.png new-diff-directory --threshold 2 --allowed-fraction 0.001
```

Dimensions must match. Both alpha channels are composited over white. The report records mismatched
pixels/fraction, mean absolute channel error, maximum channel error and the chosen tolerances.
`difference.png` retains the actual RGB difference. No automatic registration, scaling or font
substitution hides differences. The script returns failure when the configured threshold is exceeded.
A successful simple fixture cannot establish blanket Visio compatibility.

## Unfulfilled independent acceptance work

Run rights-cleared native complex documents on representative Visio versions, fonts, locales and
providers; capture source renderings; test importing, saving, reopening and semantic editing; compare
native and DrawingWeb outputs; exercise master edits/constraints/fields, native threaded comments,
Quick Styles, data-graphic masters, metafiles/OLE and specialist solutions. This repository supplies
the capture/comparison tools, not a fabricated record of those native acceptance runs.

## Primary references

- https://learn.microsoft.com/en-us/office/vba/api/visio.invisibleapp
- https://learn.microsoft.com/en-us/office/vba/api/visio.documents.openex
- https://learn.microsoft.com/en-us/office/vba/api/visio.visopensaveargs
- https://learn.microsoft.com/en-us/office/vba/api/visio.application.eventsenabled
- https://learn.microsoft.com/en-us/office/vba/api/visio.invisibleapp.alertresponse
- https://learn.microsoft.com/en-us/office/vba/api/visio.page.export
