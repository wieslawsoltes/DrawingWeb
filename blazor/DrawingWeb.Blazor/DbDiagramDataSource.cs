using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Text;
using System.Text.Json;
namespace DrawingWeb.Blazor;

public sealed record DiagramDataSnapshot(List<Dictionary<string, JsonElement>> Rows, string Revision);
public sealed record DiagramDataMutation(string Type, JsonElement Key, Dictionary<string, JsonElement>? Row = null);
public sealed class DiagramDataConflictException(string message) : Exception(message) { }

/// <summary>Application-owned SQL and fixed parameter names. Never populate these strings from browser input.</summary>
public sealed record DiagramSqlContract(
    string SelectRows, string SelectRevision, string UpsertRow, string DeleteRow, string AdvanceRevision,
    string KeyField, IReadOnlyDictionary<string, string> FieldParameters,
    string KeyParameter = "@key", string RevisionParameter = "@expectedRevision",
    int MaxRows = 100_000, int CommandTimeoutSeconds = 30);

/// <summary>
/// Provider-neutral ADO.NET adapter. Each write checks and advances an application revision within one
/// serializable transaction. Supply provider SQL explicitly; all browser-controlled values are parameters.
/// This is a server-side service, not a browser database driver or a Visio ODBC connection-string executor.
/// </summary>
public sealed class DbDiagramDataSource
{
    private readonly Func<CancellationToken, ValueTask<DbConnection>> _connection;
    private readonly DiagramSqlContract _sql;
    public DbDiagramDataSource(Func<CancellationToken, ValueTask<DbConnection>> connectionFactory, DiagramSqlContract sql)
    {
        ArgumentNullException.ThrowIfNull(connectionFactory); ArgumentNullException.ThrowIfNull(sql);
        if (sql.MaxRows < 1 || sql.CommandTimeoutSeconds < 1 || string.IsNullOrWhiteSpace(sql.KeyField)) throw new ArgumentException("Invalid database contract.", nameof(sql));
        _connection = connectionFactory; _sql = sql;
    }
    private DbCommand Command(DbConnection connection, DbTransaction transaction, string sql)
    {
        var command = connection.CreateCommand(); command.Transaction = transaction;
        command.CommandText = sql; command.CommandTimeout = _sql.CommandTimeoutSeconds; return command;
    }
    private static void Parameter(DbCommand command, string name, object? value)
    {
        var parameter = command.CreateParameter(); parameter.ParameterName = name; parameter.Value = value ?? DBNull.Value; command.Parameters.Add(parameter);
    }
    private async Task<DiagramDataSnapshot> ReadAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellation)
    {
        string revision;
        await using (var command = Command(connection, transaction, _sql.SelectRevision))
            revision = Convert.ToString(await command.ExecuteScalarAsync(cancellation), CultureInfo.InvariantCulture) ?? "";
        if (string.IsNullOrEmpty(revision)) throw new InvalidOperationException("SelectRevision must return a nonempty application revision.");
        await using var select = Command(connection, transaction, _sql.SelectRows);
        await using var reader = await select.ExecuteReaderAsync(cancellation);
        var rows = new List<Dictionary<string, JsonElement>>();
        while (await reader.ReadAsync(cancellation))
        {
            if (rows.Count >= _sql.MaxRows) throw new InvalidOperationException("The database result exceeds MaxRows.");
            var row = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            for (var i = 0; i < reader.FieldCount; i++) row.Add(reader.GetName(i), JsonValue(reader.GetValue(i)));
            if (!row.ContainsKey(_sql.KeyField)) throw new InvalidOperationException("SelectRows did not include the configured key field.");
            rows.Add(row);
        }
        return new(rows, revision);
    }
    public async Task<DiagramDataSnapshot> ReadAsync(CancellationToken cancellation = default)
    {
        await using var connection = await _connection(cancellation);
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellation);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellation);
        var result = await ReadAsync(connection, transaction, cancellation); await transaction.CommitAsync(cancellation); return result;
    }
    public async Task<DiagramDataSnapshot> WriteAsync(IReadOnlyList<DiagramDataMutation> changes, string expectedRevision, CancellationToken cancellation = default)
    {
        ArgumentNullException.ThrowIfNull(changes);
        if (changes.Count > _sql.MaxRows || string.IsNullOrWhiteSpace(expectedRevision)) throw new ArgumentException("A bounded change set and expected revision are required.");
        await using var connection = await _connection(cancellation);
        if (connection.State != ConnectionState.Open) await connection.OpenAsync(cancellation);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.Serializable, cancellation);
        await using (var check = Command(connection, transaction, _sql.SelectRevision))
        {
            var current = Convert.ToString(await check.ExecuteScalarAsync(cancellation), CultureInfo.InvariantCulture);
            if (!string.Equals(current, expectedRevision, StringComparison.Ordinal)) throw new DiagramDataConflictException("The database revision changed. Refresh and resolve the conflict.");
        }
        foreach (var change in changes)
        {
            if (change.Type is not ("upsert" or "delete") || change.Key.ValueKind is not (JsonValueKind.String or JsonValueKind.Number)) throw new ArgumentException("Invalid mutation or row key.");
            await using var command = Command(connection, transaction, change.Type == "delete" ? _sql.DeleteRow : _sql.UpsertRow);
            Parameter(command, _sql.KeyParameter, DbValue(change.Key));
            if (change.Type == "upsert")
            {
                var row = change.Row ?? throw new ArgumentException("An upsert requires a row.");
                if (!row.TryGetValue(_sql.KeyField, out var rowKey) || rowKey.ValueKind != change.Key.ValueKind || rowKey.ToString() != change.Key.ToString()) throw new ArgumentException("The row key does not match the mutation key.");
                foreach (var mapping in _sql.FieldParameters)
                {
                    if (mapping.Value == _sql.KeyParameter) continue;
                    if (!row.TryGetValue(mapping.Key, out var value)) throw new ArgumentException($"Missing field: {mapping.Key}");
                    Parameter(command, mapping.Value, DbValue(value));
                }
            }
            await command.ExecuteNonQueryAsync(cancellation);
        }
        if (changes.Count > 0)
        {
            await using var advance = Command(connection, transaction, _sql.AdvanceRevision);
            Parameter(advance, _sql.RevisionParameter, expectedRevision);
            if (await advance.ExecuteNonQueryAsync(cancellation) != 1) throw new DiagramDataConflictException("The revision compare-and-swap did not update exactly one row.");
        }
        var result = await ReadAsync(connection, transaction, cancellation);
        if (changes.Count > 0 && result.Revision == expectedRevision) throw new InvalidOperationException("AdvanceRevision must change the application revision.");
        await transaction.CommitAsync(cancellation); return result;
    }
    private static object? DbValue(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Null => null, JsonValueKind.String => value.GetString(), JsonValueKind.True => true,
        JsonValueKind.False => false, JsonValueKind.Number => value.TryGetInt64(out var integer) ? (object)integer : value.GetDecimal(),
        JsonValueKind.Array or JsonValueKind.Object => value.GetRawText(), _ => throw new ArgumentException("Undefined JSON value.")
    };
    private static JsonElement JsonValue(object value)
    {
        using var memory = new MemoryStream();
        using (var writer = new Utf8JsonWriter(memory))
        {
            switch (value)
            {
                case null or DBNull: writer.WriteNullValue(); break;
                case bool boolean: writer.WriteBooleanValue(boolean); break;
                case byte[] bytes: writer.WriteBase64StringValue(bytes); break;
                case DateTime date: writer.WriteStringValue(date); break;
                case DateTimeOffset date: writer.WriteStringValue(date); break;
                case Guid guid: writer.WriteStringValue(guid); break;
                case string text: writer.WriteStringValue(text); break;
                case byte or sbyte or short or ushort or int or uint or long or ulong or decimal:
                    writer.WriteNumberValue(Convert.ToDecimal(value, CultureInfo.InvariantCulture)); break;
                case float or double: writer.WriteNumberValue(Convert.ToDouble(value, CultureInfo.InvariantCulture)); break;
                default: writer.WriteStringValue(Convert.ToString(value, CultureInfo.InvariantCulture)); break;
            }
        }
        using var json = JsonDocument.Parse(memory.ToArray()); return json.RootElement.Clone();
    }
}
