using System.Collections;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DrawingWeb.Blazor;

// JSRuntime serializes arguments as object. Anonymous types and positional
// records can lose constructor parameter names in a trimmed WebAssembly app.
// Pass JsonElement for application data; reserve the runtime's own converters
// for ElementReference, DotNetObjectReference and stream references.
internal static class DrawingInterop
{
    internal static JsonElement Options(bool readOnly, bool grid, bool snap, double gridSize, string ariaLabel, string? pageId = null, bool guides = true)
        => JsonSerializer.SerializeToElement(new DrawingControlSettings
        {
            ReadOnly = readOnly, Grid = grid, Snap = snap, GridSize = gridSize,
            AriaLabel = ariaLabel, PageId = pageId, Guides = guides
        }, DrawingInteropJsonContext.Default.DrawingControlSettings);

    internal static JsonElement Mappings(IReadOnlyDictionary<string, string> mappings)
        => JsonSerializer.SerializeToElement(new Dictionary<string, string>(mappings), DrawingInteropJsonContext.Default.DictionaryStringString);

    internal static JsonElement Arguments(object?[] arguments)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { MaxDepth = 64 }))
        {
            int budget = 100_000;
            Write(writer, arguments, ref budget);
        }
        using var document = JsonDocument.Parse(buffer.GetBuffer().AsMemory(0, checked((int)buffer.Length)));
        return document.RootElement.Clone();
    }

    private static void Write(Utf8JsonWriter writer, object? value, ref int budget)
    {
        if (--budget < 0) throw new ArgumentException("Command arguments exceed the 100,000-value limit. Use a document stream for bulk data.");
        switch (value)
        {
            case null: writer.WriteNullValue(); break;
            case JsonElement element: element.WriteTo(writer); break;
            case JsonDocument document: document.RootElement.WriteTo(writer); break;
            case string text: writer.WriteStringValue(text); break;
            case bool boolean: writer.WriteBooleanValue(boolean); break;
            case byte number: writer.WriteNumberValue(number); break;
            case sbyte number: writer.WriteNumberValue(number); break;
            case short number: writer.WriteNumberValue(number); break;
            case ushort number: writer.WriteNumberValue(number); break;
            case int number: writer.WriteNumberValue(number); break;
            case uint number: writer.WriteNumberValue(number); break;
            case long number: writer.WriteNumberValue(number); break;
            case ulong number: writer.WriteNumberValue(number); break;
            case float number: writer.WriteNumberValue(number); break;
            case double number: writer.WriteNumberValue(number); break;
            case decimal number: writer.WriteNumberValue(number); break;
            case DrawingPoint point: JsonSerializer.Serialize(writer, point, DrawingInteropJsonContext.Default.DrawingPoint); break;
            case DrawingShape shape: JsonSerializer.Serialize(writer, shape, DrawingInteropJsonContext.Default.DrawingShape); break;
            case DrawingDocument document: JsonSerializer.Serialize(writer, document, DrawingJsonContext.Default.DrawingDocument); break;
            case DrawingStyle style: JsonSerializer.Serialize(writer, style, DrawingInteropJsonContext.Default.DrawingStyle); break;
            case IReadOnlyDictionary<string, string> strings:
                writer.WriteStartObject();
                foreach (var pair in strings) { writer.WritePropertyName(pair.Key); Write(writer, pair.Value, ref budget); }
                writer.WriteEndObject(); break;
            case IReadOnlyDictionary<string, JsonElement> elements:
                writer.WriteStartObject();
                foreach (var pair in elements) { writer.WritePropertyName(pair.Key); Write(writer, pair.Value, ref budget); }
                writer.WriteEndObject(); break;
            case IReadOnlyDictionary<string, object?> objects:
                writer.WriteStartObject();
                foreach (var pair in objects) { writer.WritePropertyName(pair.Key); Write(writer, pair.Value, ref budget); }
                writer.WriteEndObject(); break;
            case IDictionary dictionary:
                writer.WriteStartObject();
                foreach (DictionaryEntry pair in dictionary)
                {
                    if (pair.Key is not string key) throw new ArgumentException("Command object keys must be strings.");
                    writer.WritePropertyName(key); Write(writer, pair.Value, ref budget);
                }
                writer.WriteEndObject(); break;
            case IEnumerable sequence:
                writer.WriteStartArray();
                foreach (var item in sequence) Write(writer, item, ref budget);
                writer.WriteEndArray(); break;
            default:
                // Only the explicitly generated model set is accepted; no reflection fallback.
                var contract = DrawingJsonContext.Default.GetTypeInfo(value.GetType());
                if (contract is not null) { JsonSerializer.Serialize(writer, value, contract); break; }
                throw new ArgumentException("Unsupported command argument. Pass JSON scalars, arrays, dictionaries, DrawingWeb models, or JsonSerializer.SerializeToElement(value, sourceGeneratedJsonTypeInfo).");
        }
    }
}

internal sealed class DrawingControlSettings
{
    public bool ReadOnly { get; set; }
    public bool Grid { get; set; }
    public bool Snap { get; set; }
    public bool Guides { get; set; }
    public double GridSize { get; set; }
    public string AriaLabel { get; set; } = "Diagram editor";
    public string? PageId { get; set; }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(DrawingControlSettings))]
[JsonSerializable(typeof(Dictionary<string, string>))]
[JsonSerializable(typeof(DrawingPoint))]
[JsonSerializable(typeof(DrawingShape))]
[JsonSerializable(typeof(DrawingStyle))]
[JsonSerializable(typeof(DrawingImport))]
[JsonSerializable(typeof(List<DrawingDiagnostic>))]
[JsonSerializable(typeof(DrawingEditor.CreateResult))]
[JsonSerializable(typeof(DrawingEditor.WriteResult))]
internal partial class DrawingInteropJsonContext : JsonSerializerContext { }
