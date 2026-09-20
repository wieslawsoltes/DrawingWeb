# Visio compatibility matrix — 0.1.0-alpha.1

**No full Microsoft Visio compatibility or rendering equivalence is claimed.** This matrix describes the implemented profile and must accompany package releases. A synthetic round trip through the same writer/reader is not proof that every Microsoft Visio version accepts or renders that output identically. Independent desktop-Visio fixture validation remains required before asserting that.

| Area | Implemented | Boundary |
| --- | --- | --- |
| DrawingWeb JSON | Full normalized model import/export | Does not by itself contain the entire original OPC package |
| VSDX OPC | ZIP entries, relationship traversal, pages, masters, shape trees, common cells | Some package features remain opaque rather than interpreted |
| VSDX preservation | Original no-op bytes; unrelated entry payload preservation; supported scalar cell patches | Edited ZIP container and changed XML formatting need not remain byte-identical |
| VSDX geometry | Common move/line/relative cubic/quadratic/ellipse/arc paths and cached coordinates | Unsupported geometry rows are reported/approximated; not every NURBS/spline formula is evaluated |
| Groups, masters and containers | Affine groups, master insertion, independent container/list membership, swimlane pools and callouts | Native structure roles 1–6 and cached geometry are projected; full inheritance/add-on behavior is not implemented |
| Text | Rich runs, basic paragraphs/bullets, text blocks, cached fields and styled editing | Character/Paragraph/Field projection is a subset; full fields, typography, bidi and vertical fidelity remain incomplete |
| Styles and themes | Cached styles, original theme palettes and token bindings | Full theme/quick-style resolution is not implemented; export materializes styles and reports flattening |
| Layers | Visibility, lock, printability and basic layer references | Full Visio layer behavior and all UI controls are not implemented |
| Connectors | Shape references, endpoint coordinates, automatic routes, normalized ports | All Visio glue semantics, connection-point formulas and port identity are not round-tripped exactly |
| Shape data | Properties, keyed recordsets, ADO XML snapshots, native RowMaps, explicit refresh and rendered data graphics | Composite keys/provider schemas and native data-graphic masters are incomplete; text/geometry mapping projection is diagnosed |
| Database access | Two-way observable tables, REST revisions, server ADO.NET adapter | Browser does not run Visio ODBC/OLE DB strings; external database files are not opened implicitly |
| Formulas | Bounded expression engine, opt-in dependency projection, cross-shape/page cells and unit conversion | Not the full ShapeSheet language/constraint system; unsupported imported formulas retain caches |
| VDX | Basic XML import/export | Export approximates cubic curves as 24-segment polylines and emits diagnostics |
| VSD | Explicit unsupported-format error | Binary OLE VSD decoding not implemented |
| VSSX/VSTX and stencil-only packages | Dedicated template/stencil writers, unplaced masters and media, stencil-only opening | Supported package profiles, not universal stencil/template inheritance or desktop certification |
| Macros / signatures | Macro detection/rejection by default; explicit preservation opt-in | No macro execution; signed-package editing is rejected rather than silently invalidating signatures |
| Embedded objects / foreign data | Embedded PNG/JPEG/GIF/WebP, page/master media and opaque-part preservation | WebP export is diagnosed; no general EMF/WMF/TIFF/OLE/media renderer |
| SVG / PNG | Rich text, backgrounds, containers, callouts, raster images and data graphics | Shared layout with potentially different text measurement; not a raster capture of Visio |
| Comments / hyperlinks | Normalized replies/resolution and safe links; classic comment/author parts and hyperlink rows | Modern native threads, relative/internal destination equivalence and anchor geometry remain limited |
| Rulers / guides | Unit-aware rulers and visible page guides | Guides are not a complete native snapping/glue subsystem and are diagnosed on rebuild |

## Preservation mode

```ts
import { readVsdx } from '@wieslawsoltes/drawingweb/io';
import { DiagramEngine } from '@wieslawsoltes/drawingweb/core';
const source = await readVsdx(bytes);
const engine = new DiagramEngine(source.document);
engine.update(shapeId, { text: 'A supported plain-text edit' });
const output = await source.save(engine.document);
```

The source object holds the import baseline and all package parts. No-op saves return the original input exactly. Supported changes include certain position/rotation, plain-text, scalar style, shape property and page-name edits. The implementation checks changed fields, not just the intended command label. A fill edit does not rewrite an unrelated font reference.

Adding/removing/reparenting shapes, changing page topology, resizing/changing path geometry, changing layer/master definitions, mixed-rich-text rewrites, new semantic/data/comment/image/theme edits, unsupported connector-transform edits, unsupported property removal and signed-package edits are rejected by the preservation guard. The exact executable contract is in `VisioPackage.save` and its tests; applications should handle the error code rather than assume every edit is supported.

## Rebuild mode

`writeVsdx(document)` builds a new supported-subset OPC package. In the studio, this is a separate export choice with a confirmation. It is deliberately not an automatic fallback when preservation fails. Retained unknown source parts, native database definitions, complex formulas, theme information and unsupported rich content may be absent or normalized in a rebuilt file.

Imported cached geometry is often useful even when its generating formula is not supported. That does not mean subsequent edits preserve the original constraint system. Treat diagnostics as part of conversion results. Do not suppress warnings in an unattended business-document pipeline.

See [the detailed parity review](VISIO_PARITY_REVIEW.md) for feature-level contracts, limitations and interacting-edit invariants.

## Qualification still needed

Maintain a rights-cleared corpus from supported Microsoft Visio desktop versions and exporters. Check package validity in those applications, compare all pages against reference renderings, verify text/font fallback, inspect linked data round trips, and test save/reopen/edit cycles. Include master inheritance, recordsets, themes, containers, swimlanes, background pages, layers, glue formulas, unsupported geometry and deliberately hostile packages.

Initial automated tests cover synthetic OPC/VDX fixtures, geometry/metadata round trips, actual deflate decoding, security rejection, no-op preservation and unknown-part retention. They do **not** establish universal Visio compatibility.

## Primary format references

- Microsoft: [Introduction to the Visio file format (.vsdx)](https://learn.microsoft.com/en-us/office/client-developer/visio/introduction-to-the-visio-file-formatvsdx)
- Microsoft: [Visio XML schema reference](https://learn.microsoft.com/en-us/office/client-developer/visio/visio-xml-reference)
- Microsoft: [Connect element](https://learn.microsoft.com/en-us/office/client-developer/visio/connect-element-connects_type-complextypevisio-xml)

DrawingWeb is an original implementation informed by public format documentation. No proprietary implementation code, stencil artwork or fonts are distributed.
