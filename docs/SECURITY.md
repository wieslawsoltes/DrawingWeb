# Security and trust boundaries

Treat documents, CSV, rows, database responses and embedded package parts as untrusted input. The normalized model rejects duplicate IDs, cyclic/non-plain JSON objects, prototype keys and non-finite geometry. ZIP reading enforces input/output/count/ratio limits, CRCs, supported compression methods and safe paths. ZIP64/encryption and unsupported binary VSD are rejected. XML DTDs and external entities are not resolved. Formula evaluation does not use eval, Function or host-language interpolation.

Imported text is rendered as text. Editable shape styles are assigned as individual CSS properties rather than interpolated into CSS declaration lists. SVG values and text are XML-escaped; imported raw markup is not appended to the DOM. Opaque package content is retained for saving but never executed. Macro packages are rejected by default; an explicit preservation option does not make their contents executable.

The engine has finite resource limits, not an exhaustive adversarial denial-of-service proof. Browser rendering, decompression and large object allocation can still consume substantial resources within configured limits. Use application file-size limits, cancellation boundaries, origin isolation and worker/server boundaries appropriate to your threat model. The async import bridge rejects a result if the document changed while decoding.

Do not place database credentials or SQL supplied by a file in the browser. REST endpoints need authorization, CSRF protections appropriate to the hosting model, validation, rate limits and server-side row access control. `DbDiagramDataSource` receives trusted SQL templates and a connection factory from the host and binds browser values as parameters. Its revision guard is not a substitute for authorization. Provider-specific SQL and isolation behavior require integration tests against the actual database.

A diagram layer, visual cover or hidden shape is not secure redaction. The original VSDX package may retain metadata, hidden shapes and opaque parts. Preserve/export operations do not remove confidential source material unless explicitly implemented by the host.

Blazor uses streams for whole documents and binary files, but a stream is still buffered into memory by current import/export operations. Configure limits. Streamed user data is not a reason to increase SignalR's message size without bounds. Revision checks reject stale echoes. Disposal suppresses callbacks after a native host is removed, and borrowed engines remain caller-owned.

Report reproducible security issues privately to the repository owner before public disclosure when appropriate. Include the affected version, a minimized rights-cleared input and expected/observed behavior; do not upload live credentials or private production drawings.
