using System.Text.Json;
using DrawingWeb.Blazor;

int checks = 0;
void Check(bool condition, string name)
{
    if (!condition) throw new InvalidOperationException(name);
    checks++;
    Console.WriteLine("PASS " + name);
}

var document = new DrawingDocument { Title = "<script> is ordinary text" };
document.Pages[0].Shapes.Add(new DrawingShape
{
    Id = "a", Text = "Unicode Ω 😀", Source = new DrawingEndpoint("b", "north"),
    Transform = [1, 0, 0.2, 1, 2, 3]
});
var copy = DrawingDocument.FromJson(document.ToJson());
Check(copy.Title == document.Title, "source-generated title round trip");
Check(copy.Pages[0].Shapes[0].Text == "Unicode Ω 😀", "Unicode shape text");
Check(copy.Pages[0].Shapes[0].Source?.PortId == "north", "typed endpoint identity");
Check(copy.Pages[0].Shapes[0].Transform?[2] == 0.2, "affine transform contract");
Check(copy.Pages[0].Layers[0].Printable, "layer defaults");

using var extra = JsonDocument.Parse("{\"custom\":42}");
document.Pages[0].Shapes[0] = document.Pages[0].Shapes[0] with
{
    Extensions = new() { ["vendorExtension"] = extra.RootElement.Clone() }
};
var extended = DrawingDocument.FromJson(document.ToJson());
Check(extended.Pages[0].Shapes[0].Extensions!["vendorExtension"].GetProperty("custom").GetInt32() == 42, "unknown shape properties retained");

// Exercise every source-generated extension-data contract. In particular an
// init-only extension dictionary must not become a deserialization ctor arg.
const string foreign = """
{
  "schema":"drawingweb/1", "id":"foreign", "vendorDoc":{"rev":7},
  "pages":[{
    "id":"p", "vendorPage":[1,2,3],
    "layers":[{"id":"default", "vendorLayer":"process"}],
    "shapes":[{
      "id":"a", "vendorShape":null,
      "style":{"fill":"#fff", "vendorStyle":{"gradient":["#fff","#000"]}},
      "cells":{"Width":{"value":"2", "formula":"1+1", "vendorCell":true}},
      "ports":[{"id":"east","x":1,"y":0.5,"vendorPort":"input"}],
      "points":[{"x":1,"y":2,"vendorPoint":0.75}],
      "source":{"shapeId":"b","portId":"west","vendorEndpoint":{"glue":4}},
      "children":[{"id":"child","vendorChild":"preserve"}]
    }]
  }],
  "masters":[{"id":"m","name":"Custom","category":"Local","shape":{"id":"s"},"vendorMaster":"v1"}]
}
""";
var imported = DrawingDocument.FromJson(foreign);
// Change an ordinary property, then verify foreign fields survive real editing.
imported.Title = "Edited";
var roundTrip = DrawingDocument.FromJson(imported.ToJson());
var page = roundTrip.Pages[0];
var shape = page.Shapes[0];
Check(roundTrip.Extensions!["vendorDoc"].GetProperty("rev").GetInt32() == 7, "unknown document object retained");
Check(page.Extensions!["vendorPage"].GetArrayLength() == 3, "unknown page array retained");
Check(page.Layers[0].Extensions!["vendorLayer"].GetString() == "process", "unknown layer data retained");
Check(shape.Extensions!["vendorShape"].ValueKind == JsonValueKind.Null, "explicit extension null retained");
Check(shape.Style.Extensions!["vendorStyle"].GetProperty("gradient")[1].GetString() == "#000", "unknown style object retained");
Check(shape.Cells["Width"].Extensions!["vendorCell"].GetBoolean(), "unknown cell data retained");
Check(shape.Ports[0].Extensions!["vendorPort"].GetString() == "input", "unknown port data retained");
Check(shape.Points![0].Extensions!["vendorPoint"].GetDouble() == 0.75, "unknown point data retained");
Check(shape.Source!.Extensions!["vendorEndpoint"].GetProperty("glue").GetInt32() == 4, "unknown endpoint data retained");
Check(shape.Children![0].Extensions!["vendorChild"].GetString() == "preserve", "nested group extension retained");
Check(roundTrip.Masters[0].Extensions!["vendorMaster"].GetString() == "v1", "unknown master data retained");
using (var serialized = JsonDocument.Parse(roundTrip.ToJson()))
{
    Check(!serialized.RootElement.TryGetProperty("extensions", out _), "extension dictionary is flattened, not wrapped");
    Check(serialized.RootElement.GetProperty("title").GetString() == "Edited", "typed edits survive extension-data round trip");
}
Check(new DrawingDocument().ToJson().Length > 0, "default document serializes without extension constructor binding");

var million = new string('x', 1024 * 1024);
using var metadata = JsonDocument.Parse("\"" + million + "\"");
document.Metadata["large"] = metadata.RootElement.Clone();
Check(DrawingDocument.FromJson(document.ToJson()).Metadata["large"].GetString()!.Length == million.Length, "one-megabyte source-generated model");
Check(typeof(DrawingEditor).GetMethod("DisposeAsync") is not null, "awaitable lifecycle API");
Check(typeof(DrawingInput).BaseType!.FullName!.Contains("InputBase"), "EditForm integration type");
Check(typeof(DbDiagramDataSource).GetMethod("WriteAsync") is not null, "provider-neutral data API");
// Extended feature contracts must survive source-generated serialization on both TFMs.
var featureDoc = new DrawingDocument();
featureDoc.Pages[0].Unit = "mm";
featureDoc.Pages[0].Guides = new DrawingGuides { X = [96], Y = [192] };
using var keyValue = JsonDocument.Parse("\"row-1\"");
using var numberValue = JsonDocument.Parse("42");
var rich = new DrawingRichText { Paragraphs = [new DrawingTextParagraph { Bullet = "bullet", Runs = [new DrawingTextRun { Text = "Styled Ω", Style = new DrawingRunStyle { Bold = true, Underline = true, FontFamily = "Arial" }, Extensions = new() { ["vendorRun"] = numberValue.RootElement.Clone() } }] }] };
featureDoc.Pages[0].Shapes.Add(new DrawingShape
{
    Id = "feature", Text = "Styled Ω", RichText = rich,
    TextBlock = new DrawingTextBlock { X = 4, Y = 5, Width = 150, Height = 50, Rotation = 0.2 },
    Hyperlinks = [new DrawingHyperlink { Address = "https://example.com", Description = "Docs" }],
    DataLinks = [new DrawingDataLink { RecordsetId = "records", RowKey = keyValue.RootElement.Clone(), Mappings = new() { ["text"] = "label" } }],
    DataGraphicId = "graphic", SheetId = 12,
    Theme = new DrawingThemeBinding { Fill = "accent", Font = true },
    Image = new DrawingEmbeddedImage { Source = "data:image/png;base64,AA==", Alt = "Model serialization only" }
});
featureDoc.Pages[0].Shapes.Add(new DrawingShape { Id = "container", Kind = "container", Container = new DrawingContainer { MemberIds = ["feature"], AutoResize = true } });
featureDoc.Recordsets = [new DrawingRecordset { Id = "records", Name = "Records", Columns = [new DrawingDataColumn { Name = "id", Type = "string" }], Rows = [new() { ["id"] = keyValue.RootElement.Clone() }] }];
featureDoc.DataGraphics = [new DrawingDataGraphic { Id = "graphic", Rules = [new DrawingDataGraphicRule { Id = "progress", Type = "bar", Field = "progress", Min = 0, Max = 100, Thresholds = [new DrawingDataGraphicThreshold { Max = 50, Color = "#008800" }] }] }];
featureDoc.Comments = [new DrawingComment { PageId = featureDoc.Pages[0].Id, ShapeId = "feature", Text = "Review", Author = "Ada", Replies = [new DrawingCommentReply { Text = "Checked", Author = "Grace" }] }];
featureDoc.Theme = new DrawingTheme { Colors = new() { ["accent"] = "#4472c4" } };
var features = DrawingDocument.FromJson(featureDoc.ToJson());
var fs = features.Pages[0].Shapes[0];
Check(fs.RichText!.Paragraphs[0].Runs[0].Style!.Bold == true, "rich-run style contract");
Check(fs.RichText.Paragraphs[0].Runs[0].Style!.Italic is null, "absent run style inherits rather than becoming false");
Check(fs.RichText.Paragraphs[0].Runs[0].Extensions!["vendorRun"].GetInt32() == 42, "inherited extension-data contract retains unknown run fields");
Check(fs.TextBlock!.Rotation == 0.2, "transformed text block contract");
Check(fs.Hyperlinks![0].Address == "https://example.com", "hyperlink contract");
Check(fs.DataLinks![0].RowKey.GetString() == "row-1", "typed data-link key contract");
Check(fs.DataLinks[0].Mappings["text"] == "label", "data projection mapping contract");
Check(fs.DataGraphicId == "graphic", "data graphic assignment contract");
Check(fs.SheetId == 12, "native ShapeSheet numeric identity contract");
Check(fs.Theme!.Fill == "accent", "shape theme binding contract");
Check(fs.Image!.Alt == "Model serialization only", "embedded image contract");
Check(features.Pages[0].Shapes[1].Container!.MemberIds[0] == "feature", "semantic membership contract");
Check(features.Pages[0].Shapes[1].Container!.AutoResize, "automatic container fitting flag contract");
Check(features.Recordsets![0].Rows[0]["id"].GetString() == "row-1", "embedded recordset contract");
Check(features.DataGraphics![0].Rules[0].Thresholds![0].Max == 50, "data graphic threshold contract");
Check(features.Comments![0].Replies[0].Author == "Grace", "comment reply thread contract");
Check(features.Theme!.Colors["accent"] == "#4472c4", "document theme contract");
Check(features.Pages[0].Unit == "mm" && features.Pages[0].Guides!.Y[0] == 192, "ruler units and guide contract");
Check(JsonSerializer.SerializeToElement(rich, DrawingJsonContext.Default.DrawingRichText).GetProperty("paragraphs").GetArrayLength() == 1, "standalone feature source generation");
Check(typeof(DrawingEditor).GetMethod("CreateContainerAsync") is not null && typeof(DrawingEditor).GetMethod("SetCellAsync") is not null, "extended async Blazor API");
Console.WriteLine($"{checks} package-restored .NET contract checks passed.");
