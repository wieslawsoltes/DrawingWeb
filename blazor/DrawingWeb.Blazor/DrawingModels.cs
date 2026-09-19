using System.Text.Json;
using System.Text.Json.Serialization;
namespace DrawingWeb.Blazor;

/// <summary>Lossless normalized DrawingWeb document. Coordinates use CSS pixels and clockwise radians.</summary>
public sealed record DrawingDocument
{
    public string Schema { get; init; } = "drawingweb/1";
    public string Id { get; init; } = $"d-{Guid.NewGuid()}";
    public string Title { get; set; } = "Untitled diagram";
    public List<DrawingPage> Pages { get; init; } = [new()];
    public List<DrawingMaster> Masters { get; init; } = [];
    public Dictionary<string, JsonElement> Metadata { get; init; } = [];
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extensions { get; init; }
    public string ToJson() => JsonSerializer.Serialize(this, DrawingJsonContext.Default.DrawingDocument);
    public static DrawingDocument FromJson(string json) => JsonSerializer.Deserialize(json, DrawingJsonContext.Default.DrawingDocument) ?? throw new JsonException("The document was null.");
}
public sealed record DrawingPage
{
    public string Id { get; init; } = $"p-{Guid.NewGuid()}";
    public string Name { get; set; } = "Page 1";
    public double Width { get; set; } = 1200;
    public double Height { get; set; } = 800;
    public string Background { get; set; } = "#ffffff";
    public List<DrawingShape> Shapes { get; init; } = [];
    public List<DrawingLayer> Layers { get; init; } = [new()];
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extensions { get; init; }
}
public sealed record DrawingShape
{
    public string Id { get; init; } = $"s-{Guid.NewGuid()}";
    public string Kind { get; set; } = "rectangle";
    public string Text { get; set; } = "";
    public double X { get; set; }
    public double Y { get; set; }
    public double Width { get; set; } = 160;
    public double Height { get; set; } = 70;
    public double Rotation { get; set; }
    public DrawingStyle Style { get; set; } = new();
    public double[]? Transform { get; set; }
    public string? LayerId { get; set; }
    public bool? Locked { get; set; }
    public bool? Visible { get; set; }
    public string? MasterId { get; set; }
    public Dictionary<string, JsonElement> Data { get; init; } = [];
    public Dictionary<string, DrawingCell> Cells { get; init; } = [];
    public List<DrawingPort> Ports { get; init; } = [];
    public List<DrawingShape>? Children { get; set; }
    public string? Path { get; set; }
    public List<DrawingPoint>? Points { get; set; }
    public DrawingEndpoint? Source { get; set; }
    public DrawingEndpoint? Target { get; set; }
    public string? Routing { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extensions { get; init; }
}
public sealed record DrawingStyle
{
    public string Fill { get; set; } = "#f0eefb";
    public string Stroke { get; set; } = "#a69bbf";
    public double StrokeWidth { get; set; } = 1.25;
    public double Opacity { get; set; } = 1;
    public string Color { get; set; } = "#413a56";
    public string FontFamily { get; set; } = "system-ui, sans-serif";
    public double FontSize { get; set; } = 13;
    public bool Bold { get; set; }
    public bool Italic { get; set; }
    public string Align { get; set; } = "center";
    public List<double> Dash { get; set; } = [];
    public bool StartArrow { get; set; }
    public bool EndArrow { get; set; }
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extensions { get; init; }
}
public sealed record DrawingLayer
{
    public string Id { get; init; } = "default";
    public string Name { get; set; } = "Drawing";
    public bool Visible { get; set; } = true;
    public bool Locked { get; set; }
    public bool Printable { get; set; } = true;
}
public sealed record DrawingCell(string Value, string? Formula = null, string? Unit = null);
public sealed record DrawingPoint(double X, double Y);
public sealed record DrawingPort(string Id, double X, double Y, string? Direction = null);
public sealed record DrawingEndpoint(string? ShapeId = null, string? PortId = null, double? X = null, double? Y = null);
public sealed record DrawingMaster(string Id, string Name, string Category, DrawingShape Shape);
public sealed record DrawingChange(long Revision, string Json);
public sealed record DrawingDataChange(long Revision, string Json);
public sealed record DrawingErrorEvent(string Code, string Message);
public sealed record DrawingDiagnostic(string Code, string Severity, string Message, string? Part = null, string? ShapeId = null);
public sealed record DrawingExport(byte[] Bytes, long Revision, IReadOnlyList<DrawingDiagnostic> Diagnostics);
public sealed record DrawingImport(long Revision, List<DrawingDiagnostic> Diagnostics);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(DrawingDocument))]
[JsonSerializable(typeof(List<DrawingShape>))]
[JsonSerializable(typeof(List<Dictionary<string, JsonElement>>))]
[JsonSerializable(typeof(Dictionary<string, JsonElement>))]
public partial class DrawingJsonContext : JsonSerializerContext { }
