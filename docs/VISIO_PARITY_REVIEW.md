# Visio parity review and implementation contract

## Alpha.3 status

The newer [live-feature contract](LIVE_PARITY.md) and [native desktop adapter](NATIVE_VISIO.md)
supersede alpha.2 limitations specifically for live DrawingWeb master channels, selected ShapeSheet
user-write semantics, supported opt-in native text fields, and explicit Office palette/font import.
The table below remains the alpha.2 baseline for other features. Full native Quick Style matrices,
portable legacy decoding/metafile rendering and complete Visio actions/constraints remain open.
The desktop adapter delegates conversion/rendering to a separately installed, licensed Visio on
Windows; it is not a portable implementation or evidence that native qualification has run.

## Review result

The first published alpha provided a drawing editor and a conservative Visio interchange profile, not full Visio parity. This continuation adds semantic containers and lists, cross-functional pools, callouts, rich text, comments, linked recordsets, data graphics, background pages, embedded raster images, stencil/template packages, opt-in ShapeSheet projection, and corresponding browser and Blazor commands. The studio now uses a ribbon-oriented workspace instead of the previous compact toolbar.

**Full Microsoft Visio parity remains an open acceptance target, not a completed or certified property of this release.** An implemented DrawingWeb feature, a native XML projection, and an independently verified Visio round trip are three different things. The following matrix deliberately separates them.

| Area | Executable DrawingWeb behavior | Native interoperability and remaining boundary |
| --- | --- | --- |
| Containers | Membership independent of visual parentage; nested move/copy/delete closure; fit, automatic resize, membership locks, disband; atomic undo | `msvStructureType` and `DEPENDSON` relationship roles 1–6 are read/written. Ordinary native lists accept arbitrary shape members. This is not complete native container style/category/overlap behavior. |
| Swimlanes | Horizontal/vertical pools, named lanes, membership, reordering and member translation | Structure relationships are projected; DrawingWeb pool/orientation hints supplement cached geometry. Native Visio cross-functional-flowchart add-on behavior is not reproduced. |
| Callouts | Target identity, live leader rendering, target remapping, safe detachment on deletion | Native callout relationships plus cached geometry; not all Visio callout control handles or styles. |
| Rich text | Styled runs, paragraph alignment/bullets/spacing, text blocks, shared Canvas/SVG wrapping, in-place formatted editing | Character/Paragraph rows and cp/pp markers are projected; field markers display cached text. Field values are cached, not universally recalculated. Full bidi/vertical/font shaping, tabs and advanced typography are not certified. Rich editing can flatten cached field semantics. |
| Images | Embedded PNG/JPEG/GIF/WebP, fit modes, bounded decoding and PNG export | ForeignData media relationships for pages and masters. WebP emits an interoperability warning. EMF/WMF/TIFF/OLE/media/DWG import/rendering is not implemented. |
| Background pages | Referenced background chains with cycle rejection; rendering, duplication and deletion cleanup | Native page background references; complete print/page setup behavior is not reproduced. |
| Layers | Visibility, locks and inherited printability; live task pane | Common layer fields, not every native multi-layer policy. |
| ShapeSheet | Safe expression parser, explicitly enrolled cells, dependency graph, cross-shape/page references, inch-based geometry projection, cycle rollback, inspectable cached unsupported cells | A supported subset, not the complete ShapeSheet language, actions, constraints or live master inheritance. Import does not execute formulas automatically. |
| Themes | Original token palettes, shape bindings and materialized cached styles | Full Office theme/Quick Style reconstruction is not implemented. Export warns when flattening a theme to cached styles. |
| Data graphics | Conditional colors, text badges, bars and threshold icons; live Canvas/SVG/PNG evaluation | Native Visio data-graphic master authoring is not implemented. Rebuild export reports this limitation. |
| Linked recordsets | Typed keys, exact automatic linking, explicit refresh, missing-row reporting, transactional rollback, no-op refresh stability | Embedded ADO XML, DataRecordSets, DataColumn names, RowMap and supported primary-key mappings. Composite key/provider schemas remain limited. Geometry/text mappings are projected with diagnostics; native property mappings are distinct. |
| Database transport | Existing two-way observable tables, REST/ETag, IndexedDB compare-and-swap and server ADO.NET service remain available | A document-supplied ODBC/OLE DB/SQL connection is never executed. Authentication, providers, server SQL and retries remain application-owned. |
| Comments | Shape/page anchoring, replies, resolution, deletion and copy/page lifecycle behavior | Classic comments/author OPC parts are projected. Replies are flattened with diagnostics. Modern threaded-comment parts and full native anchor geometry are not reconstructed. |
| Hyperlinks | Validated absolute web/mail/telephone links and normalized diagram destinations | Native hyperlink rows are read/written; unsafe imported links remain inert. Full relative-link resolution and native internal destination equivalence remain limited. |
| Masters/stencils/templates | Reusable masters, insertion with ID remapping, unplaced-master media, dedicated VSSX/VSTX writers and stencil-only opening | Supported package profiles; not the complete stencil UI, inherited formula/style system or all Visio stencil artwork. |
| Visio files | VSDX supported-subset reconstruction and preservation; VDX basic profile; VSSX/VSTX profiles | Binary OLE VSD/VSS/VST are not decoded. VBA execution, add-ons, signatures/re-signing and COM automation are not implemented. |
| Workspace | File/Backstage, Home/Insert/Design/Data/Process/Review/View/Developer ribbon, Shapes/templates/masters, rulers, page tabs, external data and task panes, command search | Original implementation with familiar workflows, not a pixel-identical Microsoft product. Full command catalogs, specialist diagram solutions and every keyboard/accessibility convention remain incomplete. |

## Invariants and difficult interactions covered by tests

Container membership does not reparent a shape. Operations expand semantic membership while removing redundant visual roots so descendants are not moved twice. Group/ungroup update outside memberships, and locks reject a mutation before publishing a new document. Automatic container fitting participates in the same outer transaction and history record. New identities remap connectors, container members and callout targets together. Source numeric shape IDs are validated as positive unsigned 32-bit values.

A recordset row uses a typed key, not its position in the current array. Refresh does not bind a missing key to an unrelated row. Exact auto-linking rejects ambiguous matches; projection errors roll back atomically. An unchanged refresh does not create another undo entry. Native list containers are not assumed to be DrawingWeb swimlane pools. Strikethrough uses the native Strikethru cell rather than the small-caps Style bit. Native text changes take precedence over application-only metadata.

ShapeSheet cells are enrolled explicitly. Dependency evaluation is bounded and detects cycles; all results are evaluated before geometry projection. `deactivate` preserves cells/formulas but relinquishes projection authority. Replacing the document clears enrollment. Unsupported imported expressions are reported and retain their cached values. In alpha.3, enrolled geometry reacts to explicit UI changes through the new user-write path. GUARD rejects writes; SETATREF redirects supported writes; an ordinary literal is replaced. This is still not a complete Visio constraint solver.

Canvas and SVG share the rich text layout algorithm. Canvas uses actual measured text; headless SVG uses a deterministic approximation unless a measurer is supplied. Consequently this architecture does not claim pixel-identical text across renderers or machines. Raster decoding is bounded and PNG export fails explicitly when a required image cannot be decoded.

## Preservation versus reconstruction

Keep the `VisioPackage` returned by import. Unchanged saves return original bytes, including unsupported package parts. Supported scalar changes patch only their corresponding native cells. New feature edits are **not** silently accepted by preservation mode: changing rich content, memberships, recordsets, comments, image data, theme definitions or page topology requires an explicit supported-subset rebuild. Rebuild emits diagnostics for DrawingWeb-only or flattened features. An unsupported preservation edit never automatically falls back to reconstruction.

The normalized JSON model retains DrawingWeb semantics, not every original OPC part. Export the original package explicitly before discarding an imported source session. Application-owned database credentials and provider services are not serialized into this model.

## Qualification performed and still required

The local JavaScript qualification currently contains 88 passing Node tests and 43 offline browser checks. Packaging tests install the npm tarball into an isolated consumer and exercise ESM, CommonJS, declarations and 12 public subpaths. CI additionally qualifies HTTP ES modules/IndexedDB, the packed NuGet on .NET 8 and .NET 10, and release-mode Server and trimmed WebAssembly browser hosts. Consult the actual run for results; this document does not predeclare a CI result.

The new suite contains synthetic native-format fixtures (including reverse membership roles, ordinary lists, native row maps and package MIME/relationship names), not a complete independent desktop corpus. Before asserting full interoperability, open exported files in supported Visio desktop versions; compare each page against reference images; verify semantic editing, keys and refresh; and perform save/reopen/edit cycles on rights-cleared complex documents. Physical touch, screen readers, provider-specific database isolation, production CSP, reconnect behavior and high-entity-count benchmarks need separate qualification.

## Primary references used

- [Visio file format introduction](https://learn.microsoft.com/en-us/office/client-developer/visio/introduction-to-the-visio-file-formatvsdx)
- [Visio XML reference](https://learn.microsoft.com/en-us/office/client-developer/visio/visio-xml-reference)
- [Relationships cell and DEPENDSON roles](https://learn.microsoft.com/en-us/office/client-developer/visio/relationships-cell-shape-layout-section)
- [DataRecordSet XML schema](https://learn.microsoft.com/en-us/office/client-developer/visio/datarecordset-element-datarecordsets_type-complextypevisio-xml)
- [Linking shapes to data](https://learn.microsoft.com/en-us/office/vba/visio/concepts/about-linking-shapes-to-data)
- [DataRecordset object](https://learn.microsoft.com/en-us/office/vba/api/visio.datarecordset)

No Microsoft implementation code, fonts, stencil artwork or trademarks are bundled as product assets.
