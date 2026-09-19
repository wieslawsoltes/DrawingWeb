# Data binding and database integration

## Binding contract

`ObservableTable` stores immutable row snapshots keyed by a string or finite numeric key. Field schemas can enforce types, nullability and read-only fields. Replacing rows validates the replacement before committing it. Nested transactions have savepoints and publish one change batch.

`DiagramBinding` projects whitelisted shape-property paths onto row field names. Example mappings are `{ text: 'label', x: 'x', 'data.owner': 'owner', 'style.fill': 'color' }`. Shape IDs remain stable; a key change is a delete/insert rather than an implicit rename. Changes carry origins so projection writes do not feed back recursively. Geometry undo/redo is reflected into bound rows. Configure `removeMissingShapes`, `removeRowsOnShapeDelete` and `twoWay` deliberately.

A binding error is reported on `binding.errors`. A failed projection is not a distributed rollback of an already committed external database transaction. Validate row schemas and projection-compatible values at the application boundary; subscribe to errors and reconcile failures explicitly. The engine and table are not a distributed ACID database.

## REST / ETag data source

```ts
import { ObservableTable, RestDataSource, DataConnection } from '@wieslawsoltes/drawingweb/data';
const table = new ObservableTable('id');
const connection = new DataConnection(table, new RestDataSource('/api/workflow'));
await connection.refresh();
table.update('order-1', { label: 'Approved' });
await connection.save();
```

The endpoint protocol is:

```
GET /api/workflow
200 OK
ETag: "42"
{ "rows": [{ "id": "order-1", "label": "Review" }], "revision": "42" }

PATCH /api/workflow
If-Match: "42"
{ "changes": [{ "type": "upsert", "key": "order-1",
                "row": { "id": "order-1", "label": "Approved" } }] }
```

The server returns a complete authoritative row snapshot and a new revision. HTTP 409/412 are explicit conflicts. `DataConnection` protects refresh against local changes and preserves edits made while a save is in flight as new pending mutations. `discardAndRefresh()` is an explicit destructive choice; ordinary refresh never silently discards pending edits. `AbortSignal` propagates to HTTP requests. The core protocol supports CRUD projection, not arbitrary Visio native recordset replication.

## Server-side ADO.NET

The NuGet package includes `DbDiagramDataSource`. It accepts a `DbConnection` factory and a `DiagramSqlContract`; provider drivers are owned by your server application. This is usable with an ADO.NET provider that supports the required transaction behavior, rather than shipping one database vendor or exposing database credentials in WebAssembly.

A SQLite-style contract for an application-owned workflow table is:

```sql
CREATE TABLE drawing_revision (id INTEGER PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO drawing_revision VALUES (1, 0);
CREATE TABLE workflow (id TEXT PRIMARY KEY, label TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL);
```

```csharp
var contract = new DiagramSqlContract(
    SelectRows: "SELECT id, label, x, y FROM workflow ORDER BY id",
    SelectRevision: "SELECT CAST(value AS TEXT) FROM drawing_revision WHERE id=1",
    UpsertRow: "INSERT INTO workflow(id,label,x,y) VALUES(@key,@label,@x,@y) " +
               "ON CONFLICT(id) DO UPDATE SET label=excluded.label,x=excluded.x,y=excluded.y",
    DeleteRow: "DELETE FROM workflow WHERE id=@key",
    AdvanceRevision: "UPDATE drawing_revision SET value=value+1 " +
                     "WHERE id=1 AND CAST(value AS TEXT)=@expectedRevision",
    KeyField: "id",
    FieldParameters: new Dictionary<string,string> {
        ["label"]="@label", ["x"]="@x", ["y"]="@y"
    });
// Your application supplies an authenticated, configured connection factory.
var source = new DbDiagramDataSource(connectionFactory, contract);
var snapshot = await source.ReadAsync(cancellationToken);
var next = await source.WriteAsync(changes, snapshot.Revision, cancellationToken);
```

Templates and table/column names are trusted server configuration. All row values become parameters; they are never concatenated into SQL. Writes check the current revision, apply mutations, perform one revision compare-and-swap and read the resulting snapshot inside a serializable transaction. A failed operation leaves disposal to roll the transaction back. Cancellation is propagated. Provider locking/isolation/retry semantics must be qualified against your database; the adapter does not claim that all providers implement serializable transactions identically.

Expose this service through your authenticated API. Return JSON using web/camelCase naming. Map `DiagramDataConflictException` to 412, validate `If-Match` as a strong ETag and return the new quoted ETag. Add authorization and row-level policy before calling the adapter. No API endpoint should accept the SQL contract or connection string from the browser.

## Blazor binding

Use `RowsJson` / `RowsJsonChanged` for bounded streamed JSON, `BindRowsAsync<T>` with source-generated `JsonTypeInfo<List<T>>`, or `DrawingDataEditor<TItem>` with `@bind-Items`. Typed row binding does not rely on unbounded JSON passing in an ordinary SignalR callback. Native row notifications carry revisions; the full snapshot is retrieved through a JS stream.

The underlying native engine remains accessible through the bridge for advanced integration. Keep application ownership explicit: the engine owns drawing snapshots; your view model/database owns business policy. Do not use shape coordinates as a substitute for stable record keys.

## Local storage and CSV

`BrowserDocumentStore.save(key, document, expectedRevision)` performs a read/compare/write in one IndexedDB transaction, including cross-tab conflicts. The studio reports unavailable storage or conflicts instead of claiming it saved. Imported VSDX source packages are held in memory and require file export; storing only normalized JSON would lose the original package-preservation context.

CSV reading supports BOM, quoted delimiters, escaped quotes and multiline fields. Export protects spreadsheet-formula prefixes by default. Set `protectFormulas: false` only when your consumer explicitly requires literal executable spreadsheet expressions. CSV remains a table interchange format, not a fully typed schema.
