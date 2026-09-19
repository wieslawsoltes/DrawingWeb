using System.Diagnostics.CodeAnalysis;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace DrawingWeb.Blazor;

/// <summary>Native DrawingWeb editor with Server/WASM streaming, revision-aware binding and awaitable teardown.</summary>
public partial class DrawingEditor : ComponentBase, IAsyncDisposable
{
    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private NavigationManager Navigation { get; set; } = default!;
    [Parameter] public string? Value { get; set; }
    [Parameter] public EventCallback<string> ValueChanged { get; set; }
    [Parameter] public DrawingDocument? Document { get; set; }
    [Parameter] public EventCallback<DrawingDocument> DocumentChanged { get; set; }
    /// <summary>Increase to force an intentional external replacement, including during an in-flight browser edit.</summary>
    [Parameter] public long ValueRevision { get; set; }
    [Parameter] public string? RowsJson { get; set; }
    [Parameter] public EventCallback<string> RowsJsonChanged { get; set; }
    [Parameter] public string KeyField { get; set; } = "id";
    [Parameter] public IReadOnlyDictionary<string, string>? Bindings { get; set; }
    [Parameter] public bool TwoWayDataBinding { get; set; } = true;
    [Parameter] public bool ReadOnly { get; set; }
    [Parameter] public bool Grid { get; set; } = true;
    [Parameter] public bool Snap { get; set; } = true;
    [Parameter] public double GridSize { get; set; } = 20;
    [Parameter] public bool ShowToolbar { get; set; } = true;
    [Parameter] public string? PageId { get; set; }
    [Parameter] public string AriaLabel { get; set; } = "Diagram editor";
    [Parameter] public string Height { get; set; } = "480px";
    [Parameter] public string? Class { get; set; }
    [Parameter] public string? Style { get; set; }
    [Parameter] public string? ModulePath { get; set; }
    [Parameter] public long MaxDocumentBytes { get; set; } = 64 * 1024 * 1024;
    [Parameter] public long MaxFileBytes { get; set; } = 128 * 1024 * 1024;
    [Parameter] public EventCallback Ready { get; set; }
    [Parameter] public EventCallback<DrawingChange> Changed { get; set; }
    [Parameter] public EventCallback<IReadOnlyList<string>> SelectionChanged { get; set; }
    [Parameter] public EventCallback<DrawingDataChange> DataChanged { get; set; }
    [Parameter] public EventCallback<DrawingErrorEvent> Error { get; set; }
    [Parameter(CaptureUnmatchedValues = true)] public IReadOnlyDictionary<string, object>? AdditionalAttributes { get; set; }
    public bool IsReady { get; private set; }
    public bool IsDisposed => _disposed;
    public long Revision => _browserRevision;
    public IReadOnlyList<string> Selection { get; private set; } = Array.Empty<string>();

    private ElementReference _host;
    private IJSObjectReference? _module;
    private DotNetObjectReference<DrawingEditor>? _callback;
    private string? _handle;
    private string? _errorMessage;
    private Task? _initializeTask, _renderTask, _disposeTask;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _snapshotGate = new(1, 1);
    private bool _disposed, _readyNotified, _rendering, _initializationFailed;
    private string? _reportedRenderFailure;
    private readonly CancellationToken _token;
    private string? _lastTypedEmission;
    public DrawingEditor() { _token = _lifetime.Token; }
    private long _parameterStamp, _appliedStamp = -1, _browserRevision, _appliedValueRevision = -1;
    private string? _lastInput, _lastEmitted, _lastRowsInput, _lastRowsEmitted, _lastBindings;
    private string _snapshotJson = "";
    private long _dataEpoch, _lastDataRevision = -1;

    protected override void OnParametersSet()
    {
        if (Document is not null && !string.IsNullOrEmpty(Value)) throw new InvalidOperationException("Bind either Document or Value, not both.");
        if (ValueRevision < 0 || ValueRevision > 9_007_199_254_740_991L) throw new ArgumentOutOfRangeException(nameof(ValueRevision));
        if (!double.IsFinite(GridSize) || GridSize <= 0) throw new ArgumentOutOfRangeException(nameof(GridSize));
        if (MaxDocumentBytes <= 0 || MaxFileBytes <= 0) throw new ArgumentOutOfRangeException(nameof(MaxDocumentBytes));
        _parameterStamp++;
    }
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (_disposed || _initializationFailed || _rendering) return;
        if (_readyNotified && _appliedStamp == _parameterStamp) return;
        // Guard BEFORE invoking an async method: on WASM every awaited operation
        // may complete synchronously, including Error callbacks and parent renders.
        _rendering = true;
        try { _renderTask = RenderWorkAsync(); await _renderTask; }
        finally { _rendering = false; }
    }
    private async Task RenderWorkAsync()
    {
        try
        {
            _initializeTask ??= InitializeAsync();
            await _initializeTask;
            if (_disposed || !IsReady) return;
            while (_appliedStamp != _parameterStamp && !_disposed)
            {
                var stamp = _parameterStamp;
                var input = Document?.ToJson() ?? Value ?? "";
                var version = ValueRevision;
                if ((input != _lastInput && input != _lastEmitted && input != _lastTypedEmission) || version > _appliedValueRevision)
                {
                    var bytes = Encoding.UTF8.GetBytes(input);
                    if (bytes.LongLength > MaxDocumentBytes) throw new InvalidOperationException("The document exceeds MaxDocumentBytes.");
                    using var data = new MemoryStream(bytes, writable: false);
                    using var reference = new DotNetStreamReference(data, leaveOpen: true);
                    var payload = await _module!.InvokeAsync<JsonElement>("setValueFromStream", _token, _handle, reference, _browserRevision, version, MaxDocumentBytes);
                    var result = payload.Deserialize(DrawingInteropJsonContext.Default.WriteResult) ?? throw new JsonException("Missing write result.");
                    if (result.Applied) { _browserRevision = result.Revision; _snapshotJson = input; _lastRowsInput = null; _lastRowsEmitted = null; }
                    else await ReportAsync("REVISION_CONFLICT", "An external value was rejected because newer browser edits exist. Increase ValueRevision to force an intentional replacement.");
                    _lastInput = input; _appliedValueRevision = version;
                }
                await _module!.InvokeVoidAsync("setOptions", _token, _handle, DrawingInterop.Options(ReadOnly, Grid, Snap, GridSize, AriaLabel, PageId));
                if (RowsJson is not null && Bindings is not null)
                {
                    var mappingKey = KeyField + "|" + TwoWayDataBinding + "|" + string.Join("|", Bindings.OrderBy(p => p.Key).Select(p => p.Key + "=" + p.Value));
                    if (RowsJson != _lastRowsInput && RowsJson != _lastRowsEmitted || mappingKey != _lastBindings)
                    {
                        var rows = RowsJson;
                        await BindRowsJsonAsync(rows, KeyField, Bindings, TwoWayDataBinding);
                        _lastRowsInput = rows; _lastBindings = mappingKey;
                    }
                }
                _appliedStamp = stamp;
            }
            _reportedRenderFailure = null;
            if (!_disposed && !_readyNotified) { _readyNotified = true; await Ready.InvokeAsync(); if (!_disposed) await InvokeAsync(StateHasChanged); }
        }
        catch (OperationCanceledException) when (_disposed) { }
        catch (JSDisconnectedException) when (_disposed) { }
        catch (Exception error)
        {
            if (_disposed) return;
            // A cached failed initialization is terminal for this instance. Report
            // it once; do not retry from the render caused by the Error callback.
            _initializationFailed = _initializeTask is { IsFaulted: true };
            if (_initializationFailed) IsReady = false;
            _appliedStamp = _parameterStamp;
            if (_reportedRenderFailure != error.Message)
            {
                _reportedRenderFailure = error.Message;
                await ReportAsync(_initializationFailed ? "INITIALIZATION" : "PARAMETER_UPDATE", error.Message);
            }
        }
    }
    private async Task InitializeAsync()
    {
        var path = ModulePath ?? new Uri(new Uri(Navigation.BaseUri), "_content/DrawingWeb.Blazor/engine/bridge.js").AbsoluteUri;
        _module = await JS.InvokeAsync<IJSObjectReference>("import", path);
        if (_disposed) return;
        _callback = DotNetObjectReference.Create(this);
        var payload = await _module.InvokeAsync<JsonElement>("create", _host, _callback, DrawingInterop.Options(ReadOnly, Grid, Snap, GridSize, AriaLabel));
        var created = payload.Deserialize(DrawingInteropJsonContext.Default.CreateResult) ?? throw new JsonException("Missing native handle.");
        _handle = created.Id; _browserRevision = created.Revision;
        if (_disposed) return;
        IsReady = true;
    }
    private void EnsureReady()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!IsReady || _module is null || _handle is null) throw new InvalidOperationException("Wait for the DrawingEditor.Ready callback before using the native editor.");
    }
    [JSInvokable] public Task OnDocumentChanged(long revision) => _disposed ? Task.CompletedTask : ReceiveSnapshotAsync(revision);
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicProperties | DynamicallyAccessedMemberTypes.PublicParameterlessConstructor, typeof(StreamSnapshot))]
    private async Task ReceiveSnapshotAsync(long minimumRevision, bool forceRead = false)
    {
        if (_disposed || !IsReady) return;
        string? changedJson = null; long revision = 0;
        try
        {
            await _snapshotGate.WaitAsync(_token);
            try
            {
                if (_disposed || (!forceRead && minimumRevision <= _browserRevision && _snapshotJson.Length > 0)) return;
                var snapshot = await _module!.InvokeAsync<StreamSnapshot>("getSnapshot", _token, _handle);
                await using var reference = snapshot.Stream;
                await using var data = await reference.OpenReadStreamAsync(MaxDocumentBytes, _token);
                using var reader = new StreamReader(data, new UTF8Encoding(false, true));
                var json = await reader.ReadToEndAsync(_token);
                if (_disposed || snapshot.Revision < _browserRevision) return;
                _snapshotJson = json;
                if (snapshot.Revision > _browserRevision || forceRead && _lastEmitted != json)
                {
                    _browserRevision = snapshot.Revision; revision = snapshot.Revision;
                    _lastEmitted = json; _lastInput = json; changedJson = json;
                }
            }
            finally { _snapshotGate.Release(); }
            // Never hold the snapshot gate across user callbacks: a save callback may legitimately FlushAsync.
            if (changedJson is not null && !_disposed)
            {
                await ValueChanged.InvokeAsync(changedJson);
                if (!_disposed && revision == _browserRevision && DocumentChanged.HasDelegate)
                {
                    var typed = DrawingDocument.FromJson(changedJson); _lastTypedEmission = typed.ToJson();
                    await DocumentChanged.InvokeAsync(typed);
                }
                if (!_disposed && revision == _browserRevision) await Changed.InvokeAsync(new DrawingChange(revision, changedJson));
                if (!_disposed) await InvokeAsync(StateHasChanged);
            }
        }
        catch (OperationCanceledException) when (_disposed) { }
        catch (JSDisconnectedException) when (_disposed) { }
    }
    [JSInvokable] public async Task OnSelectionChanged(string[] selection)
    {
        if (_disposed) return; Selection = selection;
        await SelectionChanged.InvokeAsync(selection);
    }
    [JSInvokable] public Task OnNativeError(string code, string message) => _disposed ? Task.CompletedTask : ReportAsync(code, message);
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicProperties | DynamicallyAccessedMemberTypes.PublicParameterlessConstructor, typeof(StreamSnapshot))]
    [JSInvokable] public async Task OnDataChanged(long revision)
    {
        if (_disposed || (!DataChanged.HasDelegate && !RowsJsonChanged.HasDelegate)) return;
        var epoch = _dataEpoch;
        var snapshot = await _module!.InvokeAsync<StreamSnapshot>("getDataSnapshot", _token, _handle);
        await using var reference = snapshot.Stream;
        await using var data = await reference.OpenReadStreamAsync(MaxDocumentBytes, _token);
        using var reader = new StreamReader(data, new UTF8Encoding(false, true));
        var json = await reader.ReadToEndAsync(_token);
        if (!_disposed && epoch == _dataEpoch && snapshot.Revision > _lastDataRevision)
        {
            _lastDataRevision = snapshot.Revision; _lastRowsEmitted = json; _lastRowsInput = json;
            await RowsJsonChanged.InvokeAsync(json);
            if (!_disposed && epoch == _dataEpoch) await DataChanged.InvokeAsync(new DrawingDataChange(snapshot.Revision, json));
        }
    }
    private async Task ReportAsync(string code, string message)
    {
        if (_disposed) return; _errorMessage = message;
        await Error.InvokeAsync(new DrawingErrorEvent(code, message));
        if (!_disposed) await InvokeAsync(StateHasChanged);
    }
    public async Task FlushAsync()
    {
        EnsureReady(); var revision = await _module!.InvokeAsync<long>("flush", _token, _handle);
        await ReceiveSnapshotAsync(revision, forceRead: _snapshotJson.Length == 0);
    }
    public async Task<string> GetJsonAsync() { await FlushAsync(); return _snapshotJson; }
    public async Task<DrawingDocument> GetDocumentAsync() => DrawingDocument.FromJson(await GetJsonAsync());
    public Task FitAsync() => ExecuteAsync("fit");
    public Task FocusAsync() => ExecuteAsync("focus");
    public Task UndoAsync() => ExecuteAsync("undo");
    public Task RedoAsync() => ExecuteAsync("redo");
    public Task SelectAsync(params string[] ids) => ExecuteAsync("select", (object)ids);
    /// <summary>Executes a native command with JSON values, collections or DrawingWeb models. Serialize custom DTOs to JsonElement using caller-owned JsonTypeInfo.</summary>
    public async Task ExecuteAsync(string command, params object?[] arguments)
    {
        EnsureReady(); await _module!.InvokeVoidAsync("command", _token, _handle, command, DrawingInterop.Arguments(arguments));
    }
    public async Task<string> AddShapeAsync(string kind, double? x = null, double? y = null, string? text = null)
    {
        EnsureReady(); object? point = x.HasValue && y.HasValue ? new DrawingPoint(x.Value, y.Value) : null;
        return await _module!.InvokeAsync<string>("command", _token, _handle, "add", DrawingInterop.Arguments([kind, point, text]));
    }
    public Task UpdateShapeAsync(string id, Dictionary<string, JsonElement> patch) => ExecuteAsync("update", id, patch);
    public async Task<DrawingImport> ImportAsync(Stream source, string fileName)
    {
        EnsureReady(); ArgumentNullException.ThrowIfNull(source);
        if (source.CanSeek && source.Length - source.Position > MaxFileBytes) throw new InvalidOperationException("Input exceeds MaxFileBytes.");
        using var reference = new DotNetStreamReference(source, leaveOpen: true);
        var payload = await _module!.InvokeAsync<JsonElement>("importStream", _token, _handle, reference, fileName, MaxFileBytes);
        var result = payload.Deserialize(DrawingInteropJsonContext.Default.DrawingImport) ?? throw new JsonException("Missing import result.");
        await ReceiveSnapshotAsync(result.Revision); return result;
    }
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicProperties | DynamicallyAccessedMemberTypes.PublicParameterlessConstructor, typeof(StreamSnapshot))]
    [DynamicDependency(DynamicallyAccessedMemberTypes.PublicProperties | DynamicallyAccessedMemberTypes.PublicParameterlessConstructor, typeof(ExportStreamSnapshot))]
    public async Task<DrawingExport> ExportAsync(string format = "json")
    {
        EnsureReady(); await FlushAsync();
        var snapshot = await _module!.InvokeAsync<ExportStreamSnapshot>("exportStream", _token, _handle, format);
        await using var reference = snapshot.Stream;
        await using var input = await reference.OpenReadStreamAsync(MaxFileBytes, _token);
        using var output = new MemoryStream(); await input.CopyToAsync(output, _token);
        var diagnostics = snapshot.Diagnostics.ValueKind == JsonValueKind.Array
            ? snapshot.Diagnostics.Deserialize(DrawingInteropJsonContext.Default.ListDrawingDiagnostic) ?? []
            : new List<DrawingDiagnostic>();
        return new DrawingExport(output.ToArray(), snapshot.Revision, diagnostics);
    }
    public async Task BindRowsJsonAsync(string rowsJson, string keyField, IReadOnlyDictionary<string, string> mappings, bool twoWay = true)
    {
        EnsureReady(); _dataEpoch++; _lastDataRevision = -1; var bytes = Encoding.UTF8.GetBytes(rowsJson);
        if (bytes.Length > 32 * 1024 * 1024) throw new InvalidOperationException("Rows exceed 32 MiB.");
        using var source = new MemoryStream(bytes, writable: false); using var reference = new DotNetStreamReference(source, leaveOpen: true);
        await _module!.InvokeVoidAsync("bindRowsStream", _token, _handle, reference, keyField, DrawingInterop.Mappings(mappings), twoWay);
    }
    public Task BindRowsAsync<T>(List<T> rows, JsonTypeInfo<List<T>> jsonTypeInfo, string keyField, IReadOnlyDictionary<string, string> mappings, bool twoWay = true)
        => BindRowsJsonAsync(JsonSerializer.Serialize(rows, jsonTypeInfo), keyField, mappings, twoWay);

    public ValueTask DisposeAsync()
    {
        if (_disposeTask is not null) return new ValueTask(_disposeTask);
        _disposed = true; IsReady = false; _lifetime.Cancel();
        _disposeTask = DisposeCoreAsync(); return new ValueTask(_disposeTask);
    }
    private async Task DisposeCoreAsync()
    {
        Exception? failure = null;
        if (_initializeTask is not null)
        {
            try { await _initializeTask; }
            catch (OperationCanceledException) { }
            catch (JSDisconnectedException) { }
            catch (Exception) when (_initializationFailed) { /* Already reported through Error; disposal still releases the imported module. */ }
            catch (Exception error) { failure = error; }
        }
        try { if (_module is not null && _handle is not null) await _module.InvokeVoidAsync("dispose", _handle); }
        catch (JSDisconnectedException) { } catch (Exception error) { failure ??= error; }
        finally
        {
            _callback?.Dispose(); _callback = null; _handle = null;
            if (_module is not null) try { await _module.DisposeAsync(); } catch (JSDisconnectedException) { } catch (Exception error) { failure ??= error; }
            _module = null; _lifetime.Dispose();
        }
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }
    public sealed class CreateResult { public string Id { get; set; } = ""; public long Revision { get; set; } }
    public sealed class WriteResult { public bool Applied { get; set; } public long Revision { get; set; } }
    public class StreamSnapshot { public long Revision { get; set; } public IJSStreamReference Stream { get; set; } = default!; }
    public sealed class ExportSnapshot : StreamSnapshot { public List<DrawingDiagnostic> Diagnostics { get; set; } = []; }
    public sealed class ExportStreamSnapshot : StreamSnapshot { public JsonElement Diagnostics { get; set; } }
}
