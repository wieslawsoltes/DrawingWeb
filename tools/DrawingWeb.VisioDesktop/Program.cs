using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DrawingWeb.VisioDesktop;

// Local-desktop automation only. Never attach to, or terminate, the user's Visio instance.
// No web listener, SQL execution, macro invocation, or credential storage is provided.
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 0 || args is ["--help"])
        {
            Console.WriteLine("""
            DrawingWeb native Visio qualification adapter
            snapshot <input.vsd|vss|vst|vsdx|vssx|vstx|vdx|vsx|vtx> <new-output-directory> --allow-native-visio
            Requires Windows, an interactive desktop, and an installed/licensed Visio 2013 or later.
            Opens a COPY with macros, events/add-on formula execution and auto-refresh prompts disabled.
            Produces a converted OPC file, per-page native PNG/SVG, and SHA-256/semantic manifest.
            This is not a sandbox. Use a network-isolated disposable Windows VM for untrusted files.
            No permission is implied to execute document code, add-ons, embedded OLE or data refresh.
            """);
            return 0;
        }
        try
        {
            if (args.Length != 4 || args[0] != "snapshot" || args[3] != "--allow-native-visio")
                throw new ArgumentException("Use --help. Native desktop execution requires explicit --allow-native-visio.");
            var input = Path.GetFullPath(args[1]); var output = Path.GetFullPath(args[2]);
            if (!File.Exists(input)) throw new FileNotFoundException("Input not found.", input);
            if (new FileInfo(input).Length > 128 * 1024 * 1024) throw new IOException("Input exceeds 128 MiB.");
            var extension = Path.GetExtension(input).ToLowerInvariant();
            var kind = extension switch
            {
                ".vsd" or ".vsdx" or ".vdx" => "vsdx",
                ".vss" or ".vssx" or ".vsx" => "vssx",
                ".vst" or ".vstx" or ".vtx" => "vstx",
                _ => throw new ArgumentException("Unsupported input extension. Macro-enabled OPC formats are not accepted.")
            };
            if (Directory.Exists(output) || File.Exists(output)) throw new IOException("Output must not exist; existing files are never replaced.");
            if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Native Visio qualification requires Windows.");
            if (!Environment.UserInteractive) throw new PlatformNotSupportedException("Use an interactive Windows desktop, not a Windows service.");
            Snapshot(input, output, kind);
            Console.WriteLine("Native capture completed: " + output);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"VISIO_DESKTOP: {error.GetType().Name}: {error.Message}");
            return 1;
        }
    }

    [SupportedOSPlatform("windows")]
    private static void Snapshot(string input, string output, string kind)
    {
        // Stage alongside the destination, then atomically rename. A failure leaves no success manifest.
        var parent = Directory.GetParent(output)?.FullName ?? throw new IOException("Output needs a parent directory.");
        Directory.CreateDirectory(parent);
        var staging = Path.Combine(parent, ".drawingweb-visio-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        object? application = null, documents = null, document = null;
        var report = new CaptureManifest { InputSha256 = Hash(input), InputName = Path.GetFileName(input) };
        try
        {
            var progId = Type.GetTypeFromProgID("Visio.InvisibleApp", throwOnError: true)!;
            application = Activator.CreateInstance(progId) ?? throw new COMException("Could not create an isolated Visio instance.");
            dynamic app = application;
            app.EventsEnabled = (short)0; // Includes RUNADDON operands, per Microsoft's Visio contract.
            app.AlertResponse = (short)2; // IDCANCEL, never an automatic Yes to a destructive operation.
            report.VisioVersion = Convert.ToString(app.Version, CultureInfo.InvariantCulture) ?? "unknown";
            if (!int.TryParse(report.VisioVersion.Split('.')[0], out var major) || major < 15)
                throw new NotSupportedException("Visio 2013 (15.0) or later is required for OPC conversion.");
            documents = app.Documents;
            const short flags = 1 | 8 | 64 | 128 | 256 | 1024; // Copy, DontList, Hidden, MacrosDisabled, NoWorkspace, DeclineAutoRefresh.
            document = ((dynamic)documents).OpenEx(input, flags);
            dynamic doc = document;
            var converted = "converted." + kind;
            doc.SaveAs(Path.Combine(staging, converted));
            if (!File.Exists(Path.Combine(staging, converted))) throw new IOException("Visio did not produce the converted file.");
            report.Converted = converted;
            object? pages = null, masters = null;
            int shapesRemaining = 100_000;
            try
            {
                pages = doc.Pages;
                int count = Convert.ToInt32(((dynamic)pages).Count, CultureInfo.InvariantCulture);
                if (count > 1000) throw new IOException("Page count exceeds 1,000.");
                for (var i = 1; i <= count; i++)
                {
                    object? page = null, sheet = null, shapes = null;
                    try
                    {
                        page = ((dynamic)pages).Item[(short)i]; dynamic nativePage = page;
                        sheet = nativePage.PageSheet;
                        var pageReport = new PageCapture
                        {
                            Id = Convert.ToInt32(nativePage.ID, CultureInfo.InvariantCulture), Name = (string)nativePage.NameU,
                            Width = ReadCell(sheet, "PageWidth").Result ?? 0, Height = ReadCell(sheet, "PageHeight").Result ?? 0,
                            Png = $"page-{i:D4}.png", Svg = $"page-{i:D4}.svg"
                        };
                        nativePage.Export(Path.Combine(staging, pageReport.Png));
                        nativePage.Export(Path.Combine(staging, pageReport.Svg));
                        if (!File.Exists(Path.Combine(staging, pageReport.Png)) || !File.Exists(Path.Combine(staging, pageReport.Svg)))
                            throw new IOException("Native page export did not produce both reference images.");
                        shapes = nativePage.Shapes;
                        ReadShapes(shapes, pageReport.Shapes, 0, ref shapesRemaining);
                        report.Pages.Add(pageReport);
                    }
                    finally { Release(shapes); Release(sheet); Release(page); }
                }
                masters = doc.Masters;
                int masterCount = Convert.ToInt32(((dynamic)masters).Count, CultureInfo.InvariantCulture);
                if (masterCount > 10_000) throw new IOException("Master count exceeds 10,000.");
                for (var i = 1; i <= masterCount; i++)
                {
                    object? master = null, shapes = null;
                    try
                    {
                        master = ((dynamic)masters).Item[(short)i]; dynamic nativeMaster = master;
                        var capture = new MasterCapture { Id = Convert.ToInt32(nativeMaster.ID), Name = (string)nativeMaster.NameU };
                        shapes = nativeMaster.Shapes; ReadShapes(shapes, capture.Shapes, 0, ref shapesRemaining); report.Masters.Add(capture);
                    }
                    finally { Release(shapes); Release(master); }
                }
            }
            finally { Release(masters); Release(pages); }
            // Do not save dirty state back to the input. It was opened as a copy in the first place.
            doc.Saved = true; doc.Close(); Release(document); document = null;
            app.Quit(); Release(documents); documents = null; Release(application); application = null;
            if (report.InputSha256 != Hash(input)) throw new IOException("Input changed during native capture.");
            foreach (var file in Directory.EnumerateFiles(staging)) report.Files[Path.GetFileName(file)] = Hash(file);
            File.WriteAllText(Path.Combine(staging, "manifest.json"), JsonSerializer.Serialize(report, CaptureJsonContext.Default.CaptureManifest));
            Directory.Move(staging, output);
        }
        finally
        {
            try { if (document is not null) { ((dynamic)document).Saved = true; ((dynamic)document).Close(); } }
            catch (COMException) { /* Best effort on a disconnected COM server; preserve original error. */ }
            finally
            {
                Release(document); Release(documents);
                try { if (application is not null) ((dynamic)application).Quit(); }
                catch (COMException) { }
                finally { Release(application); }
                if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            }
        }
    }

    [SupportedOSPlatform("windows")]
    private static void ReadShapes(object collection, List<ShapeCapture> output, int depth, ref int remaining)
    {
        if (depth > 64) throw new IOException("Shape nesting exceeds 64 levels.");
        int count = Convert.ToInt32(((dynamic)collection).Count, CultureInfo.InvariantCulture);
        if (count > short.MaxValue) throw new IOException("Shape collection exceeds the native short-index profile.");
        for (var i = 1; i <= count; i++)
        {
            if (--remaining < 0) throw new IOException("Shape count exceeds 100,000.");
            object? shape = null, children = null;
            try
            {
                shape = ((dynamic)collection).Item[(short)i]; dynamic native = shape;
                var capture = new ShapeCapture { Id = Convert.ToInt32(native.ID), Name = (string)native.NameU, Text = (string)native.Text };
                foreach (var cell in new[] { "PinX", "PinY", "Width", "Height", "LocPinX", "LocPinY", "Angle", "BeginX", "BeginY", "EndX", "EndY", "FillForegnd", "LineColor", "Char.Color", "Char.Size", "User.msvStructureType", "Relationships" })
                    capture.Cells[cell] = ReadCell(shape, cell);
                children = native.Shapes; ReadShapes(children, capture.Children, depth + 1, ref remaining); output.Add(capture);
            }
            finally { Release(children); Release(shape); }
        }
    }

    [SupportedOSPlatform("windows")]
    private static CellCapture ReadCell(object sheet, string name)
    {
        object? cell = null;
        try
        {
            if (Convert.ToInt16(((dynamic)sheet).CellExistsU[name, (short)0]) == 0) return new CellCapture { Exists = false };
            cell = ((dynamic)sheet).CellsU[name]; dynamic native = cell;
            double? result = null;
            // Strings need not have a meaningful numeric result. Always retain FormulaU.
            try { var number = Convert.ToDouble(native.ResultIU, CultureInfo.InvariantCulture); if (double.IsFinite(number)) result = number; }
            catch (COMException) { }
            return new CellCapture { Exists = true, Formula = (string)native.FormulaU, Result = result };
        }
        finally { Release(cell); }
    }

    [SupportedOSPlatform("windows")]
    private static void Release(object? value) { if (value is not null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    private static string Hash(string path) { using var file = File.OpenRead(path); return Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant(); }
}

internal sealed class CaptureManifest
{
    public string Schema { get; init; } = "drawingweb-visio-capture/1";
    public string InputName { get; init; } = "";
    public string InputSha256 { get; init; } = "";
    public string VisioVersion { get; set; } = "";
    public string Converted { get; set; } = "";
    public List<PageCapture> Pages { get; init; } = [];
    public List<MasterCapture> Masters { get; init; } = [];
    public Dictionary<string, string> Files { get; init; } = [];
}
internal sealed class PageCapture
{
    public int Id { get; init; }
    public string Name { get; init; } = "";
    public double Width { get; init; }
    public double Height { get; init; }
    public string Png { get; init; } = "";
    public string Svg { get; init; } = "";
    public List<ShapeCapture> Shapes { get; init; } = [];
}
internal sealed class MasterCapture
{
    public int Id { get; init; }
    public string Name { get; init; } = "";
    public List<ShapeCapture> Shapes { get; init; } = [];
}
internal sealed class ShapeCapture
{
    public int Id { get; init; }
    public string Name { get; init; } = "";
    public string Text { get; init; } = "";
    public Dictionary<string, CellCapture> Cells { get; init; } = [];
    public List<ShapeCapture> Children { get; init; } = [];
}
internal sealed class CellCapture
{
    public bool Exists { get; init; }
    public string? Formula { get; init; }
    public double? Result { get; init; }
}
[JsonSerializable(typeof(CaptureManifest))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
internal partial class CaptureJsonContext : JsonSerializerContext { }
