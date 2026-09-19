using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
namespace DrawingWeb.Samples;
public sealed class DemoForm { [Required] public string Diagram { get; set; } = ""; }
public sealed record WorkflowRow(string Id, string Label, double X, double Y);
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(List<WorkflowRow>))]
public partial class DemoJson : JsonSerializerContext { }
