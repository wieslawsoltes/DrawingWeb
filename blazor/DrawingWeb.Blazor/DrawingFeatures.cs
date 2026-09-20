using System.Text.Json;
using System.Text.Json.Serialization;

namespace DrawingWeb.Blazor;

/// <summary>Forward-compatible feature contract. Unknown members survive a typed round trip.</summary>
public abstract record DrawingFeature
{
    [JsonExtensionData] public Dictionary<string, JsonElement>? Extensions { get; set; }
}
public sealed record DrawingRichText : DrawingFeature
{
    public List<DrawingTextParagraph> Paragraphs { get; set; } = [];
}
public sealed record DrawingTextParagraph : DrawingFeature
{
    public List<DrawingTextRun> Runs { get; set; } = [];
    public string? Align { get; set; }
    public string? Bullet { get; set; }
    public double? Indent { get; set; }
    public double? SpaceBefore { get; set; }
    public double? SpaceAfter { get; set; }
}
public sealed record DrawingTextRun : DrawingFeature
{
    public string Text { get; set; } = "";
    public DrawingRunStyle? Style { get; set; }
    public DrawingTextField? Field { get; set; }
}
/// <summary>Null values inherit the shape's text style rather than overriding it.</summary>
public sealed record DrawingRunStyle : DrawingFeature
{
    public string? FontFamily { get; set; }
    public double? FontSize { get; set; }
    public string? Color { get; set; }
    public bool? Bold { get; set; }
    public bool? Italic { get; set; }
    public bool? Underline { get; set; }
    public bool? Strike { get; set; }
}
/// <summary>Live master channels; geometry remains local. Removing a channel creates a local override.</summary>
public sealed record DrawingMasterBinding : DrawingFeature
{
    public string SourceShapeId { get; set; } = "";
    public List<string> Style { get; set; } = [];
    public List<string> Cells { get; set; } = [];
    public bool Text { get; set; } = true;
}
/// <summary>Omitted lists do not restore channels. Omit the entire argument to restore all channels.</summary>
public sealed record DrawingMasterChannels : DrawingFeature
{
    public List<string>? Style { get; set; }
    public List<string>? Cells { get; set; }
    public bool? Text { get; set; }
}
public sealed record DrawingMasterPatch : DrawingFeature
{
    public string? Name { get; set; }
    public string? Category { get; set; }
    public DrawingShape? Shape { get; set; }
}
public sealed record DrawingTextField : DrawingFeature
{
    public string Formula { get; set; } = "";
    public string? Format { get; set; }
    public string? NativeFormat { get; set; }
    public string? Value { get; set; }
    public string? Unit { get; set; }
}
public sealed record DrawingTextBlock : DrawingFeature
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Width { get; set; }
    public double Height { get; set; }
    public double? Rotation { get; set; }
}
public sealed record DrawingContainer : DrawingFeature
{
    public List<string> MemberIds { get; set; } = [];
    public double Padding { get; set; } = 24;
    public double HeaderSize { get; set; } = 32;
    public bool AutoResize { get; set; }
    public bool Locked { get; set; }
    public string Orientation { get; set; } = "horizontal";
    public string? Layout { get; set; }
}
public sealed record DrawingContainerOptions : DrawingFeature
{
    public string? Name { get; set; }
    public double? X { get; set; }
    public double? Y { get; set; }
    public double? Width { get; set; }
    public double? Height { get; set; }
    public double? Padding { get; set; }
    public double? HeaderSize { get; set; }
    public bool? AutoResize { get; set; }
    public bool? Locked { get; set; }
    public string? Orientation { get; set; }
}
public sealed record DrawingEmbeddedImage : DrawingFeature
{
    public string Source { get; set; } = "";
    public string Fit { get; set; } = "contain";
    public string Alt { get; set; } = "";
}
public sealed record DrawingHyperlink : DrawingFeature
{
    public string Id { get; set; } = $"link-{Guid.NewGuid()}";
    public string Description { get; set; } = "";
    public string? Address { get; set; }
    public string? SubAddress { get; set; }
    public string? PageId { get; set; }
    public string? ShapeId { get; set; }
    public bool? NewWindow { get; set; }
}
public sealed record DrawingComment : DrawingFeature
{
    public string Id { get; set; } = $"comment-{Guid.NewGuid()}";
    public string PageId { get; set; } = "";
    public string? ShapeId { get; set; }
    public DrawingPoint? Position { get; set; }
    public string Author { get; set; } = "Author";
    public string Text { get; set; } = "";
    public string CreatedUtc { get; set; } = DateTimeOffset.UtcNow.ToString("O");
    public bool Resolved { get; set; }
    public List<DrawingCommentReply> Replies { get; set; } = [];
}
public sealed record DrawingCommentReply : DrawingFeature
{
    public string Id { get; set; } = $"reply-{Guid.NewGuid()}";
    public string Author { get; set; } = "Author";
    public string Text { get; set; } = "";
    public string CreatedUtc { get; set; } = DateTimeOffset.UtcNow.ToString("O");
}
public sealed record DrawingRecordset : DrawingFeature
{
    public string Id { get; set; } = $"recordset-{Guid.NewGuid()}";
    public string Name { get; set; } = "Data";
    public string KeyField { get; set; } = "id";
    public List<DrawingDataColumn> Columns { get; set; } = [];
    public List<Dictionary<string, JsonElement>> Rows { get; set; } = [];
    public string? Revision { get; set; }
}
public sealed record DrawingDataColumn : DrawingFeature
{
    public string Name { get; set; } = "";
    public string Type { get; set; } = "string";
    public string? Label { get; set; }
    public bool? Required { get; set; }
}
public sealed record DrawingDataLink : DrawingFeature
{
    public string RecordsetId { get; set; } = "";
    /// <summary>A JSON string or finite number, preserving typed row identity.</summary>
    public JsonElement RowKey { get; set; }
    public Dictionary<string, string> Mappings { get; set; } = [];
}
public sealed record DrawingDataGraphic : DrawingFeature
{
    public string Id { get; set; } = $"graphic-{Guid.NewGuid()}";
    public string Name { get; set; } = "Data graphic";
    public List<DrawingDataGraphicRule> Rules { get; set; } = [];
}
public sealed record DrawingDataGraphicRule : DrawingFeature
{
    public string Id { get; set; } = $"rule-{Guid.NewGuid()}";
    public string Type { get; set; } = "text";
    public string Field { get; set; } = "";
    public string? Label { get; set; }
    public string? Color { get; set; }
    public string? Background { get; set; }
    public double? Min { get; set; }
    public double? Max { get; set; }
    public List<DrawingDataGraphicCase>? Cases { get; set; }
    public List<DrawingDataGraphicThreshold>? Thresholds { get; set; }
}
public sealed record DrawingDataGraphicCase : DrawingFeature
{
    public JsonElement Value { get; set; }
    public string Color { get; set; } = "#4472c4";
    public string? Label { get; set; }
}
public sealed record DrawingDataGraphicThreshold : DrawingFeature
{
    public double Max { get; set; }
    public string Color { get; set; } = "#4472c4";
    public string? Label { get; set; }
}
public sealed record DrawingTheme : DrawingFeature
{
    public string Id { get; set; } = "custom";
    public string Name { get; set; } = "Custom theme";
    public Dictionary<string, string> Colors { get; set; } = [];
    public string FontFamily { get; set; } = "Arial";
}
public sealed record DrawingThemeBinding : DrawingFeature
{
    public string? Fill { get; set; }
    public string? Stroke { get; set; }
    public string? Color { get; set; }
    public bool? Font { get; set; }
}
public sealed record DrawingGuides : DrawingFeature
{
    public List<double> X { get; set; } = [];
    public List<double> Y { get; set; } = [];
}
public sealed record DrawingRefreshResult
{
    public List<string> Updated { get; set; } = [];
    public List<string> Missing { get; set; } = [];
}
public sealed record DrawingSheetCell
{
    public DrawingDiagnostic? Error { get; set; }
    public string ShapeId { get; set; } = "";
    public string Name { get; set; } = "";
    public JsonElement Value { get; set; }
    public string? Formula { get; set; }
}
