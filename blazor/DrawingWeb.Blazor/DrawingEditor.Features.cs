using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.JSInterop;

namespace DrawingWeb.Blazor;

public partial class DrawingEditor
{
    private async Task<string> FeatureIdAsync(string command, params object?[] arguments)
    {
        EnsureReady();
        return await _module!.InvokeAsync<string>("command", _token, _handle, command, DrawingInterop.Arguments(arguments));
    }
    private async Task<T> FeatureResultAsync<T>(string command, JsonTypeInfo<T> contract, params object?[] arguments)
    {
        EnsureReady();
        var json = await _module!.InvokeAsync<JsonElement>("command", _token, _handle, command, DrawingInterop.Arguments(arguments));
        return JsonSerializer.Deserialize(json, contract) ?? throw new JsonException($"Missing result for {command}.");
    }
    public Task<string> CreateContainerAsync(IReadOnlyList<string>? members = null, DrawingContainerOptions? options = null)
        => FeatureIdAsync("container", members, options);
    public Task SetContainerMembersAsync(string containerId, IReadOnlyList<string> members)
        => ExecuteAsync("setMembers", containerId, members);
    public Task LockContainerAsync(string containerId, bool locked = true) => ExecuteAsync("containerLock", containerId, locked);
    public Task FitContainerAsync(string containerId) => ExecuteAsync("fitContainer", containerId);
    public Task DisbandContainerAsync(string containerId) => ExecuteAsync("disband", containerId);
    public Task SelectContainerContentsAsync(string containerId) => ExecuteAsync("selectContents", containerId);
    public Task<string> CreateSwimlanesAsync(IReadOnlyList<string> names, string orientation = "horizontal")
        => FeatureIdAsync("swimlanes", names, orientation);
    public Task ReorderLaneAsync(string poolId, string laneId, int offset) => ExecuteAsync("reorderLane", poolId, laneId, offset);
    public Task<string> CreateCalloutAsync(string targetId, string text) => FeatureIdAsync("callout", targetId, text);
    public Task<string> AddHyperlinkAsync(string shapeId, DrawingHyperlink hyperlink) => FeatureIdAsync("hyperlink", shapeId, hyperlink);
    public Task RemoveHyperlinkAsync(string shapeId, string hyperlinkId) => ExecuteAsync("removeHyperlink", shapeId, hyperlinkId);
    public Task<string> AddCommentAsync(string text, string author = "Author", string? shapeId = null, DrawingPoint? position = null)
        => FeatureIdAsync("comment", text, author, shapeId, position);
    public Task ReplyCommentAsync(string commentId, string text, string author = "Author") => ExecuteAsync("replyComment", commentId, text, author);
    public Task ResolveCommentAsync(string commentId, bool resolved = true) => ExecuteAsync("resolveComment", commentId, resolved);
    public Task DeleteCommentAsync(string commentId) => ExecuteAsync("deleteComment", commentId);
    public Task SetRichTextAsync(string shapeId, DrawingRichText text) => ExecuteAsync("richText", shapeId, text);
    public Task EditRichTextAsync(string shapeId) => ExecuteAsync("editRichText", shapeId);
    public Task ApplyThemeAsync(DrawingTheme theme, IReadOnlyList<string>? shapeIds = null) => ExecuteAsync("theme", theme, shapeIds);
    public Task RegisterDataGraphicAsync(DrawingDataGraphic graphic) => ExecuteAsync("registerDataGraphic", graphic);
    public Task ApplyDataGraphicAsync(IReadOnlyList<string> shapeIds, string? graphicId = null) => ExecuteAsync("applyDataGraphic", shapeIds, graphicId);
    public Task<DrawingRefreshResult> UpsertRecordsetAsync(DrawingRecordset recordset)
        => FeatureResultAsync("recordset", DrawingJsonContext.Default.DrawingRefreshResult, recordset);
    public Task LinkDataAsync(string shapeId, DrawingDataLink link) => ExecuteAsync("linkData", shapeId, link);
    public Task UnlinkDataAsync(string shapeId, string? recordsetId = null) => ExecuteAsync("unlinkData", shapeId, recordsetId);
    public Task<DrawingRefreshResult> RefreshDataAsync(string recordsetId, IReadOnlyList<string>? shapeIds = null)
        => FeatureResultAsync("refreshData", DrawingJsonContext.Default.DrawingRefreshResult, recordsetId, shapeIds);
    public async Task<int> AutoLinkAsync(string shapeField, string recordsetId, string column, IReadOnlyDictionary<string, string> mappings)
    {
        EnsureReady();
        return await _module!.InvokeAsync<int>("command", _token, _handle, "autoLink", DrawingInterop.Arguments([recordsetId, shapeField, column, mappings]));
    }
    /// <summary>Explicitly enroll a cell in sandboxed projection; lengths are Visio inches.</summary>
    public Task SetCellAsync(string shapeId, string name, JsonElement value, string? formula = null) => ExecuteAsync("sheetCell", shapeId, name, value, formula);
    public Task<List<DrawingDiagnostic>> ActivateShapeSheetAsync(IReadOnlyList<string>? shapeIds = null)
        => FeatureResultAsync("activateSheet", DrawingJsonContext.Default.ListDrawingDiagnostic, shapeIds);
    public Task DeactivateShapeSheetAsync(IReadOnlyList<string>? shapeIds = null) => ExecuteAsync("deactivateSheet", (object?)shapeIds);
    public Task RecalculateAsync() => ExecuteAsync("recalculate");
    public Task<List<DrawingSheetCell>> GetCellsAsync(string shapeId)
        => FeatureResultAsync("sheetCells", DrawingJsonContext.Default.ListDrawingSheetCell, shapeId);
    public Task<string> DuplicatePageAsync() => FeatureIdAsync("duplicatePage");
    public Task<string> RegisterMasterAsync(string name, string category, DrawingShape shape) => FeatureIdAsync("registerMaster", name, category, shape);
    public Task<string> InsertMasterAsync(string masterId, double x = 100, double y = 100) => FeatureIdAsync("insertMaster", masterId, x, y);
    /// <summary>Apply a user value, respecting GUARD and supported SETATREF write routing.</summary>
    public Task SetUserCellValueAsync(string shapeId, string name, double value) => ExecuteAsync("sheetUserValue", shapeId, name, value);
    /// <summary>Explicitly activate supported text-field formulas. Unsupported fields retain cached text.</summary>
    public Task<List<DrawingDiagnostic>> ActivateTextFieldsAsync(IReadOnlyList<string>? shapeIds = null)
        => FeatureResultAsync("activateFields", DrawingJsonContext.Default.ListDrawingDiagnostic, (object?)shapeIds);
    public Task DeactivateTextFieldsAsync(IReadOnlyList<string>? shapeIds = null) => ExecuteAsync("deactivateFields", (object?)shapeIds);
    public Task<List<DrawingDiagnostic>> GetTextFieldDiagnosticsAsync()
        => FeatureResultAsync("fieldDiagnostics", DrawingJsonContext.Default.ListDrawingDiagnostic);
    public Task UpdateMasterAsync(string masterId, DrawingMasterPatch patch) => ExecuteAsync("updateMaster", masterId, patch);
    public Task RestoreMasterInheritanceAsync(string shapeId, DrawingMasterChannels? channels = null) => ExecuteAsync("restoreMaster", shapeId, channels);
    public Task DetachMasterAsync(string shapeId) => ExecuteAsync("detachMaster", shapeId);
    /// <summary>Import an explicit DrawingML palette and Latin font; this does not infer native Quick Styles.</summary>
    public Task<List<DrawingDiagnostic>> ApplyOfficeThemeXmlAsync(string xml, IReadOnlyList<string>? shapeIds = null)
        => FeatureResultAsync("officeTheme", DrawingJsonContext.Default.ListDrawingDiagnostic, xml, shapeIds);
    public Task DistributeAsync(string axis = "horizontal") => ExecuteAsync("distribute", axis);
    public Task FlipAsync(string axis = "horizontal") => ExecuteAsync("flip", axis);
}
