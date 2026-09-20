/* Application-only Office-style workspace. The engine/control remain independently reusable. */
'use strict';
globalThis.mountDrawingWorkspace = function mountDrawingWorkspace(studio) {
  const D = studio.Drawing, engine = studio.engine, control = studio.control;
  const operations = new D.DiagramOperations(engine), sheet = new D.ShapeSheetService(engine);
  const $ = id => document.getElementById(id), actions = new Map(), unsubscribers = [];
  const controller = new AbortController(); let clipboard = [], activePane = 'format', frame = 0;
  const page = () => engine.getPage(control.pageId);
  const selected = () => engine.selection.map(id => engine.getShape(id)).filter(Boolean);
  const one = () => { const shape = selected()[0]; if (!shape) throw Error('Select a shape first.'); return shape; };
  const container = () => { const c = selected().find(s => s.container); if (!c) throw Error('Select a container or swimlane first.'); return c; };
  const status = text => { $('status').textContent = text; $('status').style.color = ''; };
  const closeFile = () => $('backstage').close();
  function listen(element, type, callback) { element.addEventListener(type, callback, { signal: controller.signal }); }
  function add(id, label, execute, enabled = () => true) { actions.set(id, { label, execute, enabled }); }
  async function run(id) {
    const action = actions.get(id); if (!action) throw Error(`Unregistered workspace command: ${id}`);
    if (!action.enabled()) return;
    try { control.flush(); await action.execute(); refresh(); }
    catch (error) { status(`${error.code || 'COMMAND'}: ${error.message || error}`); showText('Command could not be completed', `${error.code || 'COMMAND'}\n\n${error.message || error}`); }
  }
  const dialog = $('workspace-dialog'), dialogBody = $('workspace-dialog-body');
  function showDialog(title) {
    if (dialog.open) dialog.close();
    $('workspace-dialog-title').textContent = title; dialogBody.replaceChildren(); closeFile(); dialog.showModal();
  }
  function showText(title, text) { showDialog(title); const p = document.createElement('div'); p.style.whiteSpace = 'pre-wrap'; p.textContent = text; dialogBody.append(p); }
  function formDialog(title, fields, submitLabel = 'Apply') {
    return new Promise(resolve => {
      showDialog(title); const form = document.createElement('form'); form.className = 'dialog-form';
      const inputs = new Map(); let settled = false;
      function finish(value) { if (settled) return; settled = true; dialog.removeEventListener('close', cancel); resolve(value); }
      function cancel() { finish(null); }
      dialog.addEventListener('close', cancel, { once: true });
      for (const field of fields) {
        const label = document.createElement('label'); label.textContent = field.label;
        const input = document.createElement(field.options ? 'select' : field.type === 'textarea' ? 'textarea' : 'input');
        if (field.options) for (const option of field.options) { const o = document.createElement('option'); o.value = typeof option === 'string' ? option : option.value; o.textContent = typeof option === 'string' ? option : option.label; input.append(o); }
        else if (field.type !== 'textarea') input.type = field.type || 'text';
        input.name = field.name; input.setAttribute('aria-label', field.label); if (field.value !== undefined || !field.options) input.value = String(field.value ?? '');
        input.required = field.required !== false; if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
        if (field.type === 'number') input.step = 'any';
        inputs.set(field.name, input); label.append(input); form.append(label);
      }
      const footer = document.createElement('div'); footer.className = 'dialog-actions';
      const cancelButton = document.createElement('button'); cancelButton.type = 'button'; cancelButton.textContent = 'Cancel'; cancelButton.onclick = () => dialog.close();
      const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'primary'; submit.textContent = submitLabel;
      footer.append(cancelButton, submit); form.append(footer); dialogBody.append(form);
      form.onsubmit = event => { event.preventDefault(); if (!form.reportValidity()) return; finish(Object.fromEntries([...inputs].map(([key, input]) => [key, input.value]))); dialog.close(); };
      inputs.values().next().value?.focus();
    });
  }
  function setPane(name) {
    activePane = name; document.querySelectorAll('.task-pane').forEach(p => p.hidden = p.id !== `pane-${name}`);
    document.querySelectorAll('[data-pane]').forEach(p => { p.setAttribute('aria-selected', String(p.dataset.pane === name)); p.tabIndex = p.dataset.pane === name ? 0 : -1; });
    $('pane-title').textContent = ({ format: 'Format Shape', layers: 'Layers', comments: 'Comments', sheet: 'ShapeSheet' })[name];
    document.querySelector('.inspector').classList.add('forced-pane'); refresh();
  }
  function setTab(name, focus = false) {
    document.querySelectorAll('[data-tab]').forEach(button => { const active = button.dataset.tab === name; button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; if (active && focus) button.focus(); });
    document.querySelectorAll('.ribbon-panel').forEach(panel => panel.hidden = panel.id !== `ribbon-${name}`);
    document.documentElement.classList.remove('ribbon-collapsed'); document.querySelector('.ribbon-collapse').setAttribute('aria-expanded', 'true');
  }
  const hasSelection = () => engine.selection.length > 0 && !control.readOnly;
  function applyStyle(patch) {
    engine.transaction('Format selected shapes', () => {
      for (const s of selected()) engine.update(s.id, { style: { ...s.style, ...patch }, ...(s.richText ? { richText: { paragraphs: s.richText.paragraphs.map(p => ({ ...p, ...(patch.align ? { align: patch.align } : {}), runs: p.runs.map(r => ({ ...r, style: { ...r.style, ...patch } })) })) } } : {}) });
    });
  }
  function selectedRecordset() { const set = engine.document.recordsets?.[0]; if (!set) throw Error('Import a recordset or capture the live table from the Data tab first.'); return set; }
  function rasterSource(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(reader.error); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); }); }
  add('file', 'Open File view', () => $('backstage').showModal()); add('close-file', 'Close File view', closeFile);
  add('download', 'Download selected format', () => studio.exportFile($('format').value));
  add('import-csv', 'Import CSV', () => { closeFile(); $('csv-file').click(); });
  add('export-csv', 'Export live table as CSV', () => document.querySelector('[data-command="export-csv"]').click());
  add('add-page', 'Add a page', () => document.querySelector('[data-command="add-page"]').click());
  add('duplicate-page', 'Duplicate current page', () => { control.pageId = operations.duplicatePage(control.pageId); });
  add('copy', 'Copy selection', () => { clipboard = control.copyShapes(); status(`${clipboard.length} shapes copied to the workspace clipboard.`); }, hasSelection);
  add('cut', 'Cut selection', () => { clipboard = control.copyShapes(); engine.remove(engine.selection); }, hasSelection);
  add('paste', 'Paste shapes', () => { control.canvas.dispatchEvent(new ClipboardEvent('paste', { clipboardData: (() => { const data = new DataTransfer(); data.setData('application/x-drawingweb-shapes', JSON.stringify(clipboard)); data.setData('text/plain', JSON.stringify({ format: 'drawingweb-shapes/1', shapes: clipboard })); return data; })(), bubbles: true, cancelable: true })); }, () => clipboard.length > 0 && !control.readOnly);
  for (const property of ['bold', 'italic', 'underline']) add(property, `Toggle ${property}`, () => applyStyle({ [property]: !one().style[property] }), hasSelection);
  for (const align of ['left', 'center', 'right']) add(`text-${align}`, `Align text ${align}`, () => applyStyle({ align }), hasSelection);
  add('vertical-middle', 'Center text vertically', () => applyStyle({ verticalAlign: 'middle' }), hasSelection);
  add('no-fill', 'Remove shape fill', () => applyStyle({ fill: 'none' }), hasSelection);
  add('rich-text', 'Edit rich text', () => { control.editRichText(one().id); }, hasSelection);
  add('bullet', 'Toggle bullet paragraphs', () => engine.transaction('Toggle bullets', () => { for (const s of selected()) { const text = s.richText || D.richTextFromString(s.text); engine.update(s.id, { richText: { paragraphs: text.paragraphs.map(p => ({ ...p, bullet: p.bullet === 'bullet' ? 'none' : 'bullet' })) } }); } }), hasSelection);
  add('rotate-right', 'Rotate shapes 90 degrees', () => engine.transaction('Rotate shapes', () => selected().forEach(s => engine.update(s.id, { rotation: s.rotation + Math.PI / 2 }))), hasSelection);
  add('distribute', 'Distribute horizontally', () => operations.distribute(engine.selection, 'horizontal'), () => selected().length >= 3);
  add('distribute-vertical', 'Distribute vertically', () => operations.distribute(engine.selection, 'vertical'), () => selected().length >= 3);
  add('flip-horizontal', 'Flip selection horizontally', () => operations.flip(engine.selection, 'horizontal'), hasSelection);
  add('flip-vertical', 'Flip selection vertically', () => operations.flip(engine.selection, 'vertical'), hasSelection);
  add('container', 'Insert container around selection', async () => { const values = await formDialog('Insert container', [{ name: 'name', label: 'Container title', value: 'Process group' }]); if (values) operations.createContainer(control.pageId, engine.selection, { name: values.name }); });
  add('swimlanes', 'Insert cross-functional swimlanes', async () => { const values = await formDialog('Cross-functional flowchart', [{ name: 'names', label: 'Lane names (one per line)', type: 'textarea', value: 'Customer\nOperations\nFulfillment' }, { name: 'orientation', label: 'Orientation', options: ['horizontal', 'vertical'] }]); if (values) { operations.createSwimlanes(control.pageId, values.names.split('\n').map(s => s.trim()).filter(Boolean), values.orientation); control.fit(); } });
  add('callout', 'Insert attached callout', async () => { const target = one(); const values = await formDialog('Insert callout', [{ name: 'text', label: 'Callout text', type: 'textarea', value: 'Explain this step' }]); if (values) operations.createCallout(control.pageId, target.id, values.text); }, hasSelection);
  add('hyperlink', 'Add hyperlink', async () => { const shape = one(); const values = await formDialog('Add hyperlink', [{ name: 'description', label: 'Display text', value: 'Open documentation' }, { name: 'address', label: 'Absolute HTTP(S), mailto or tel URL', value: 'https://example.com/' }]); if (values) operations.addHyperlink(shape.id, { ...values, newWindow: true }); }, hasSelection);
  add('image', 'Insert embedded picture', () => $('image-file').click());
  listen($('image-file'), 'change', async () => {
    try { const file = $('image-file').files[0]; if (!file) return; if (file.size > 8 * 1024 * 1024 || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw Error('Use a PNG, JPEG, GIF or WebP file up to 8 MiB.');
      const source = await rasterSource(file), image = new Image(); image.src = source; await image.decode(); if (image.naturalWidth * image.naturalHeight > 16e6) throw Error('Image exceeds 16 megapixels.');
      const width = Math.min(400, image.naturalWidth), shape = D.createShape('image', { x: 100, y: 100, width, height: width * image.naturalHeight / image.naturalWidth, text: '', image: { source, fit: 'contain', alt: file.name }, style: { fill: 'none', stroke: 'none' } }); engine.add(control.pageId, shape); engine.select([shape.id]);
    } catch (error) { showText('Picture could not be inserted', error.message); } finally { $('image-file').value = ''; }
  });
  add('new-master', 'Save selected shape as a reusable master', async () => { const shape = one(); if (shape.container?.memberIds.length) throw Error('Group the complete component before registering a master; a semantic container has separate members.'); const values = await formDialog('Create master', [{ name: 'name', label: 'Master name', value: shape.text || 'Custom shape' }, { name: 'category', label: 'Category', value: 'My shapes' }]); if (values) { const definition = structuredClone(shape); definition.dataLinks = undefined; definition.dataGraphicId = undefined; definition.calloutTargetId = undefined; engine.registerMaster(values.name, values.category, definition); status('Master added. Open My masters in the Shapes pane to reuse it.'); } }, hasSelection);
  add('show-masters', 'Browse reusable masters', () => {
    showDialog('My masters'); const grid = document.createElement('div'); grid.className = 'dialog-grid';
    for (const master of engine.document.masters) { const button = document.createElement('button'); button.className = 'template-card'; const title = document.createElement('strong'); title.textContent = master.name; const description = document.createElement('small'); description.textContent = master.category; button.append(title, description); button.onclick = () => { const id = engine.instantiateMaster(master.id, control.pageId, 150, 150); engine.select([id]); dialog.close(); }; grid.append(button); }
    if (!grid.childElementCount) grid.textContent = 'Select a shape and use Insert → Save as master, or open a VSSX library.'; dialogBody.append(grid);
  });
  add('add-members', 'Add selected shapes to a container', () => { const c = container(); operations.addToContainer(c.id, engine.selection.filter(id => id !== c.id)); }, hasSelection);
  add('remove-members', 'Remove selected shapes from a container', () => { const c = container(); operations.removeFromContainer(c.id, engine.selection.filter(id => id !== c.id)); }, hasSelection);
  add('fit-container', 'Fit container to contents', () => operations.fitContainer(container().id), hasSelection);
  add('lock-container', 'Toggle container membership lock', () => { const c = container(); operations.setContainerLocked(c.id, !c.container.locked); }, hasSelection);
  add('disband', 'Disband container without deleting members', () => operations.disbandContainer(container().id), hasSelection);
  add('select-members', 'Select container contents', () => operations.selectContainerContents(container().id), hasSelection);
  for (const [id, offset] of [['lane-up', -1], ['lane-down', 1]]) add(id, offset < 0 ? 'Move swimlane up' : 'Move swimlane down', () => { const lane = one(), pool = engine.allShapes(control.pageId).find(s => s.container?.layout === 'pool' && s.container.memberIds.includes(lane.id)); if (!pool) throw Error('Select a lane belonging to a swimlane pool.'); operations.reorderLane(pool.id, lane.id, offset); }, hasSelection);
  add('page-setup', 'Set page size and units', async () => { const p = page(), values = await formDialog('Page setup', [{ name: 'name', label: 'Page name', value: p.name }, { name: 'width', label: 'Width in CSS pixels', type: 'number', min: 1, max: 100000, value: p.width }, { name: 'height', label: 'Height in CSS pixels', type: 'number', min: 1, max: 100000, value: p.height }, { name: 'unit', label: 'Ruler display units', options: ['px', 'mm', 'in'], value: p.unit || 'px' }]); if (values) { engine.updatePage(p.id, { name: values.name, width: +values.width, height: +values.height, unit: values.unit }); control.fit(); } });
  add('orientation', 'Switch page orientation', () => { const p = page(); engine.updatePage(p.id, { width: p.height, height: p.width }); control.fit(); });
  add('page-background', 'Set page background color', async () => { const values = await formDialog('Page background', [{ name: 'background', label: 'Color', type: 'color', value: page().background }]); if (values) engine.updatePage(control.pageId, values); });
  add('background-page', 'Assign a background page', async () => { const values = await formDialog('Background page', [{ name: 'id', label: 'Background page', required: false, value: page().backgroundPageId || '', options: [{ value: '', label: 'None' }, ...engine.document.pages.filter(p => p.id !== control.pageId).map(p => ({ value: p.id, label: p.name }))] }]); if (values) engine.updatePage(control.pageId, { backgroundPageId: values.id || undefined }); });
  add('add-guide', 'Add a ruler guide', async () => { const values = await formDialog('Add guide', [{ name: 'axis', label: 'Orientation', options: [{ value: 'x', label: 'Vertical' }, { value: 'y', label: 'Horizontal' }] }, { name: 'coordinate', label: 'Position in CSS pixels', type: 'number', value: 200 }]); if (values) addGuide(values.axis, +values.coordinate); });
  function addGuide(axis, value) { const p = page(), guides = structuredClone(p.guides || { x: [], y: [] }); guides[axis].push(Math.round(value * 100) / 100); engine.updatePage(p.id, { guides }); }
  add('clear-guides', 'Remove all guides', () => engine.updatePage(control.pageId, { guides: { x: [], y: [] } }));
  add('recordset-snapshot', 'Capture live table as linked recordset', () => {
    const rows = studio.table.values().map(row => ({ ...row })); const recordset = { id: 'workflow-recordset', name: 'Workflow records', keyField: 'id', columns: [{ name: 'id', type: 'string' }, { name: 'label', type: 'string' }, { name: 'owner', type: 'string' }, { name: 'status', type: 'string' }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'fill', type: 'string' }], rows };
    engine.transaction('Capture and link workflow data', () => { operations.upsertRecordset(recordset); for (const row of rows) if (engine.getShape(row.id)) operations.linkShape(row.id, { recordsetId: recordset.id, rowKey: row.id, mappings: { text: 'label', 'data.owner': 'owner', 'data.status': 'status' } }); }); status(`${rows.length} rows captured and linked by stable key.`);
  });
  add('recordset-import', 'Import recordset JSON or ADO XML', () => $('recordset-file').click());
  listen($('recordset-file'), 'change', async () => { try { const file = $('recordset-file').files[0]; if (!file) return; if (file.size > 16e6) throw Error('Recordset exceeds 16 MiB.'); const text = await file.text(); const set = file.name.toLowerCase().endsWith('.xml') ? D.readAdoRecordset(text, { name: file.name }) : JSON.parse(text); operations.upsertRecordset(set); status(`${set.rows.length} data rows imported. Use Link selected shape to bind.`); } catch (error) { showText('Recordset import', error.message); } finally { $('recordset-file').value = ''; } });
  add('link-data', 'Link a shape to a recordset row', async () => { const shape = one(), sets = engine.document.recordsets || []; if (!sets.length) throw Error('Import or capture a recordset first.'); const choice = await formDialog('Choose recordset', [{ name: 'id', label: 'Recordset', options: sets.map(s => ({ value: s.id, label: s.name })) }]); if (!choice) return; const set = sets.find(s => s.id === choice.id); const values = await formDialog('Link data row', [{ name: 'row', label: 'Row', options: set.rows.map((r, i) => ({ value: String(i), label: String(r[set.keyField]) })) }, { name: 'column', label: 'Shape text column', options: set.columns.map(c => c.name) }]); if (values) operations.linkShape(shape.id, { recordsetId: set.id, rowKey: set.rows[+values.row][set.keyField], mappings: { text: values.column, ...Object.fromEntries(set.columns.map(c => ['data.' + c.name, c.name])) } }); }, hasSelection);
  add('auto-link', 'Automatically match shape text to rows', async () => { const set = selectedRecordset(); const values = await formDialog('Automatically link', [{ name: 'column', label: 'Column matching shape text', options: set.columns.map(c => c.name), value: set.columns.some(c => c.name === 'label') ? 'label' : set.keyField }]); if (values) { const count = operations.autoLink(control.pageId, set.id, 'text', values.column, { text: values.column, ...Object.fromEntries(set.columns.map(c => ['data.' + c.name, c.name])) }); status(`${count} shapes linked by exact value.`); } });
  add('refresh-data', 'Refresh shapes from embedded data snapshots', () => { let count = 0, missing = 0; engine.transaction('Refresh all recordsets', () => { for (const set of engine.document.recordsets || []) { const result = operations.refreshLinks(set.id); count += result.updated.length; missing += result.missing.length; } }); status(`${count} shape projections refreshed; ${missing} missing row links retained.`); });
  add('show-recordsets', 'Inspect embedded recordsets', () => showText('Embedded recordsets', JSON.stringify(engine.document.recordsets || [], null, 2)));
  add('data-graphics', 'Create a data graphic', async () => { const shape = one(), fields = Object.keys(shape.data).filter(k => k !== 'bound'); if (!fields.length) throw Error('This shape has no data fields. Link a row or edit Shape Data first.'); const values = await formDialog('Data graphics', [{ name: 'field', label: 'Data field', options: fields }, { name: 'type', label: 'Graphic', options: [{ value: 'text', label: 'Text callout' }, { value: 'bar', label: 'Data bar (0–100)' }, { value: 'icon', label: 'Icon and value' }, { value: 'color', label: 'Color by value' }] }, { name: 'color', label: 'Accent color', type: 'color', value: '#185abd' }]); if (values) { const id = D.id('graphic'), value = shape.data[values.field]; const rule = { id: 'rule', ...values, ...(values.type === 'color' ? { cases: [{ value, color: values.color }], color: undefined } : {}) }; engine.transaction('Create data graphic', () => { operations.registerDataGraphic({ id, name: values.field, rules: [rule] }); operations.applyDataGraphic(engine.selection, id); }); } }, hasSelection);
  add('clear-data-graphics', 'Remove selected data graphics', () => operations.applyDataGraphic(engine.selection), hasSelection);
  add('comment', 'Add comment to selection or page', async () => { const shapeId = selected()[0]?.id, pageId = control.pageId; const values = await formDialog('New comment', [{ name: 'author', label: 'Author', value: 'Author' }, { name: 'text', label: 'Comment', type: 'textarea', value: '' }], 'Post comment'); if (values) { operations.addComment(pageId, values.text, values.author, shapeId); setPane('comments'); } });
  for (const name of ['format', 'layers', 'comments', 'sheet']) add(`pane-${name}`, `Open ${name} task pane`, () => setPane(name));
  add('pane-data', 'Toggle External Data window', () => $('data-toggle').click());
  add('add-layer', 'Create a drawing layer', async () => { const values = await formDialog('New layer', [{ name: 'name', label: 'Layer name', value: 'New layer' }]); if (values) engine.updatePage(control.pageId, { layers: [...page().layers, { id: D.id('layer'), name: values.name, visible: true, locked: false, printable: true }] }); });
  add('assign-layer', 'Assign selection to a layer', async () => { const values = await formDialog('Assign layer', [{ name: 'id', label: 'Layer', options: page().layers.map(l => ({ value: l.id, label: l.name })) }]); if (values) engine.transaction('Assign layer', () => selected().forEach(s => engine.update(s.id, { layerId: values.id }))); }, hasSelection);
  add('activate-formulas', 'Activate supported imported ShapeSheet formulas', () => { const diagnostics = sheet.activate(engine.selection.length ? engine.selection : undefined); sheet.recalculate(); showText('ShapeSheet activation', diagnostics.length ? diagnostics.map(d => `${d.code}: ${d.message}`).join('\n') : 'All selected evaluable formulas were activated. Evaluation uses a bounded, explicitly documented subset, not the entire ShapeSheet language.'); });
  add('recalculate', 'Recalculate active ShapeSheet formulas', () => sheet.recalculate());
  add('inspect-json', 'Inspect normalized document JSON', () => showText('DrawingWeb document', JSON.stringify(engine.document, null, 2)));
  add('validate', 'Validate diagram topology and model', () => { D.validateDocument(engine.document); showText('Diagram validation', `${engine.document.pages.length} pages\n${engine.allShapes().length} shapes\n${engine.document.recordsets?.length || 0} recordsets\n${engine.document.comments?.length || 0} comment threads\n\nModel, reference, membership and data-key checks passed. This does not certify Microsoft Visio rendering fidelity.`); });
  add('fit-selection', 'Fit selection', () => control.fitSelection()); add('zoom100', 'Zoom to 100 percent', () => control.setZoom(1));
  add('collapse-ribbon', 'Collapse or expand ribbon', () => { const collapsed = document.documentElement.classList.toggle('ribbon-collapsed'); document.querySelector('.ribbon-collapse').setAttribute('aria-expanded', String(!collapsed)); });
  add('full-screen', 'Toggle full screen', async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); });
  add('help', 'Integration documentation', () => showText('DrawingWeb · reusable components', 'npm: @wieslawsoltes/drawingweb\nNuGet: DrawingWeb.Blazor\n\nModules: core, geometry, layout, formula, data, io, web, features, text, shapesheet, bridge and mvvm.\n\nThe Shapes, ribbon, task panes and table all use the same engine. No proprietary Visio code, stencil artwork or fonts are bundled.\n\nSee the repository docs for the current compatibility matrix and API contracts.'));
  add('print', 'Print current page', () => { closeFile(); const svg = D.exportSvg(engine.document, control.pageId), popup = window.open('', '_blank'); if (!popup) throw Error('Allow a popup to open the print preview.'); popup.opener = null; popup.document.title = engine.document.title; const image = popup.document.createElement('img'); image.style.width = '100%'; const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })); image.onload = () => { URL.revokeObjectURL(url); popup.print(); }; image.src = url; popup.document.body.append(image); });
  function template(kind) {
    if (kind === 'workflow') return studio.createSample();
    const doc = D.createDocument(kind === 'swimlanes' ? 'Cross-functional process' : kind === 'organization' ? 'Organization chart' : 'Blank drawing');
    if (kind === 'blank') return doc;
    const e = new D.DiagramEngine(doc), ops = new D.DiagramOperations(e), pageId = doc.pages[0].id;
    if (kind === 'swimlanes') {
      const poolId = ops.createSwimlanes(pageId), pool = e.getShape(poolId);
      pool.container.memberIds.forEach((laneId, i) => { const shape = D.createShape(i === 1 ? 'diamond' : 'roundRect', { x: 240 + i * 220, y: 167 + i * 170, width: 170, height: 68, text: ['Submit request', 'Approve request', 'Deliver result'][i], data: { owner: ['Customer', 'Operations', 'Fulfillment'][i] }, style: { fill: '#eaf2ff', stroke: '#7799c4' } }); e.add(pageId, shape); ops.addToContainer(laneId, [shape.id]); });
      const steps = e.allShapes().filter(s => !s.container); for (let i = 1; i < steps.length; i++) e.add(pageId, D.createShape('connector', { source: { shapeId: steps[i - 1].id }, target: { shapeId: steps[i].id }, style: { fill: 'none', endArrow: true } }));
    } else {
      const specs = [['lead', 'Team lead', 480, 100], ['design', 'Design', 140, 310], ['engineering', 'Engineering', 480, 310], ['delivery', 'Delivery', 820, 310], ['research', 'Research', 140, 510], ['platform', 'Platform', 480, 510], ['support', 'Support', 820, 510]];
      e.addMany(pageId, specs.map(([id, text, x, y]) => D.createShape('roundRect', { id, text, x, y, width: 220, height: 85, style: { fill: '#eaf2ff', stroke: '#7799c4', fontSize: 17 }, data: { department: text } })));
      for (const [a, b] of [['lead', 'design'], ['lead', 'engineering'], ['lead', 'delivery'], ['design', 'research'], ['engineering', 'platform'], ['delivery', 'support']]) e.add(pageId, D.createShape('connector', { source: { shapeId: a }, target: { shapeId: b }, style: { fill: 'none', endArrow: true } }));
    }
    const result = structuredClone(e.document); e.dispose(); return result;
  }
  add('templates', 'Create from a diagram template', () => {
    showDialog('New drawing'); const grid = document.createElement('div'); grid.className = 'dialog-grid';
    for (const [kind, title, icon, description] of [['blank', 'Blank drawing', '▯', 'Start with an empty page.'], ['workflow', 'Basic flowchart', '⌘', 'Eight steps with two-way bound data.'], ['swimlanes', 'Cross-functional flowchart', '▤', 'Three swimlanes with real membership.'], ['organization', 'Organization chart', '♧', 'Editable team structure and connectors.']]) {
      const button = document.createElement('button'); button.className = 'template-card'; button.dataset.template = kind;
      const glyph = document.createElement('span'); glyph.className = 'command-icon'; glyph.textContent = icon;
      const label = document.createElement('strong'); label.textContent = title; const hint = document.createElement('small'); hint.textContent = description;
      button.append(glyph, label, hint); button.onclick = async () => { try { if (!confirm('Replace this workspace? Save a separate copy of the current drawing first.')) return; await studio.replace(template(kind)); dialog.close(); status(`${title} created.`); } catch (error) { showText('Template error', error.message); } }; grid.append(button);
    } dialogBody.append(grid);
  });
  add('search-commands', 'Search commands', () => {
    showDialog('Search commands'); const input = document.createElement('input'); input.type = 'search'; input.placeholder = 'Type a command…'; input.className = 'command-filter'; input.setAttribute('aria-label', 'Find a command');
    const results = document.createElement('div'); results.className = 'command-results';
    const render = () => { results.replaceChildren(); for (const [key, action] of actions) { if (key === 'search-commands' || !action.label.toLowerCase().includes(input.value.toLowerCase())) continue; const b = document.createElement('button'); b.textContent = action.label; b.disabled = !action.enabled(); b.onclick = () => { dialog.close(); run(key); }; results.append(b); } };
    input.oninput = render; input.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); results.querySelector('button:not(:disabled)')?.focus(); } if (event.key === 'Enter') { event.preventDefault(); results.querySelector('button:not(:disabled)')?.click(); } }; dialogBody.append(input, results); render(); input.focus();
  });
  // Event delegation remains valid for dynamically generated pane actions and theme galleries.
  listen(document, 'click', event => { const element = event.target.closest?.('[data-action]'); if (element) { event.preventDefault(); run(element.dataset.action); } const pane = event.target.closest?.('[data-pane]'); if (pane) setPane(pane.dataset.pane); const tab = event.target.closest?.('[data-tab]'); if (tab) setTab(tab.dataset.tab); });
  listen(document.querySelector('.ribbon-tabs'), 'keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !event.target.matches('[data-tab]')) return; const tabs = [...document.querySelectorAll('[data-tab]')], current = tabs.indexOf(event.target), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); setTab(tabs[next].dataset.tab, true); });
  listen(document, 'keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); run('search-commands'); } if (event.key === 'Escape' && !dialog.open) document.querySelector('.inspector').classList.remove('forced-pane'); });
  listen($('workspace-dialog-close'), 'click', () => dialog.close());
  listen($('r-font'), 'change', () => applyStyle({ fontFamily: $('r-font').value }));
  listen($('r-size'), 'change', () => { const value = +$('r-size').value; if (value > 0 && value <= 300) applyStyle({ fontSize: value }); });
  for (const key of ['fill', 'stroke']) listen($(`r-${key}`), 'change', () => applyStyle({ [key]: $(`r-${key}`).value }));
  for (const theme of D.THEMES) { const button = document.createElement('button'); button.className = 'theme-tile'; button.title = `Apply ${theme.name} theme`; button.dataset.themeId = theme.id; const colors = document.createElement('div'); colors.className = 'theme-colors'; for (const color of Object.values(theme.colors).slice(0, 4)) { const swatch = document.createElement('span'); swatch.style.background = color; colors.append(swatch); } const label = document.createElement('span'); label.textContent = theme.name; button.append(colors, label); button.onclick = () => { operations.applyTheme(theme); refresh(); }; $('theme-gallery').append(button); }
  listen($('show-rulers'), 'change', () => document.querySelector('.drawing-area').classList.toggle('no-rulers', !$('show-rulers').checked));
  listen($('show-guides'), 'change', () => control.setOptions({ guides: $('show-guides').checked }));
  listen($('include-resolved'), 'change', () => renderComments());
  listen($('sheet-edit'), 'submit', event => { event.preventDefault(); try { const text = $('sheet-value').value, formula = text.startsWith('=') ? text.slice(1) : undefined; sheet.setCell(one().id, $('sheet-name').value, formula ? 0 : text, formula); status('ShapeSheet cell applied in one undoable transaction.'); refresh(); } catch (error) { showText('ShapeSheet error', error.message); } });
  function renderComments() {
    const host = $('comments-list'); host.replaceChildren();
    for (const comment of engine.document.comments || []) { if (comment.pageId !== control.pageId || comment.resolved && !$('include-resolved').checked) continue;
      const card = document.createElement('article'); card.className = `comment-card${comment.resolved ? ' resolved' : ''}`; const author = document.createElement('strong'); author.textContent = comment.author;
      const time = document.createElement('time'); time.dateTime = comment.createdUtc; time.textContent = new Date(comment.createdUtc).toLocaleString(); const body = document.createElement('p'); body.textContent = comment.text; card.append(author, time, body);
      for (const reply of comment.replies) { const child = document.createElement('div'); child.className = 'comment-reply'; const who = document.createElement('strong'); who.textContent = reply.author; const text = document.createElement('p'); text.textContent = reply.text; child.append(who, text); card.append(child); }
      const bar = document.createElement('div'); bar.className = 'comment-actions';
      for (const [label, action] of [['Reply', async () => { const v = await formDialog('Reply to comment', [{ name: 'author', label: 'Author', value: 'Author' }, { name: 'text', label: 'Reply', type: 'textarea' }], 'Post reply'); if (v) operations.replyComment(comment.id, v.text, v.author); }], [comment.resolved ? 'Reopen' : 'Resolve', () => operations.resolveComment(comment.id, !comment.resolved)], ['Select', () => { if (comment.shapeId) { engine.select([comment.shapeId]); control.fitSelection(); } }]]) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => Promise.resolve().then(action).then(refresh).catch(e => showText('Comment', e.message)); bar.append(b); } card.append(bar); host.append(card);
    }
    if (!host.childElementCount) { const p = document.createElement('p'); p.className = 'pane-hint'; p.textContent = 'No visible comments on this page. Add a comment to a selected shape or to the page.'; host.append(p); }
  }
  function renderSheet() {
    const host = $('sheet-cells'); host.replaceChildren(); const shape = selected()[0]; if (!shape) { host.textContent = 'Select a shape to inspect its cells.'; return; }
    for (const name of new Set(['Width', 'Height', 'PinX', 'PinY', 'Angle', ...Object.keys(shape.cells)])) {
      let value; try { value = sheet.evaluate(shape.id, name); } catch (e) { value = `${e.code || 'FORMULA'}: ${e.message}`; }
      const row = document.createElement('div'); row.className = 'sheet-row'; const select = document.createElement('button'); select.textContent = name; const code = document.createElement('code'); code.textContent = `${value}${shape.cells[name]?.formula ? '\n=' + shape.cells[name].formula : ''}`; select.onclick = () => { $('sheet-name').value = name; $('sheet-value').value = shape.cells[name]?.formula ? '=' + shape.cells[name].formula : String(value); }; row.append(select, code); host.append(row);
    }
  }
  function renderSemanticProperties() {
    const host = $('semantic-properties'); host.replaceChildren(); const s = selected()[0]; if (!s) return;
    const row = text => { const p = document.createElement('div'); p.className = 'semantic-row'; p.textContent = text; host.append(p); return p; };
    if (s.container) row(`${s.container.layout === 'pool' ? 'Swimlane pool' : 'Container'} · ${s.container.memberIds.length} members · ${s.container.locked ? 'membership locked' : 'editable membership'}`);
    if (s.calloutTargetId) row(`Callout attached to ${engine.getShape(s.calloutTargetId)?.text || s.calloutTargetId}`);
    if (s.dataLinks?.length) row(`${s.dataLinks.length} linked recordset row(s)`);
    for (const link of s.hyperlinks || []) { const p = row(link.description); const safe = link.address && D.safeHyperlink(link.address); if (safe) { const a = document.createElement('a'); a.href = safe; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open link ↗'; p.append(a); } else if (link.pageId && engine.document.pages.some(p => p.id === link.pageId)) { const b = document.createElement('button'); b.textContent = 'Go to page'; b.onclick = () => { control.pageId = link.pageId; if (link.shapeId) engine.select([link.shapeId]); }; p.append(b); } else if (link.address) p.append(document.createTextNode(' · blocked unsafe/unsupported URL')); }
  }
  function drawRulers() {
    const view = control.viewport, p = page(), scale = p.unit === 'mm' ? 96 / 25.4 : p.unit === 'in' ? 96 : 1;
    document.querySelector('.ruler-corner').textContent = p.unit || 'px';
    let major = scale; while (major * view.zoom < 55) major *= 2; const minor = major / 5;
    for (const axis of ['horizontal', 'vertical']) {
      const c = $(`ruler-${axis}`), rect = c.getBoundingClientRect(), dpr = devicePixelRatio || 1, horizontal = axis === 'horizontal'; if (rect.width === 0 || rect.height === 0) continue;
      c.width = Math.round(rect.width * dpr); c.height = Math.round(rect.height * dpr); const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
      const styles = getComputedStyle(document.documentElement); ctx.fillStyle = styles.getPropertyValue('--panel'); ctx.fillRect(0, 0, rect.width, rect.height); ctx.strokeStyle = styles.getPropertyValue('--line'); ctx.fillStyle = styles.getPropertyValue('--muted'); ctx.font = '9px Arial'; ctx.lineWidth = 1;
      const offset = horizontal ? view.x : view.y, extent = horizontal ? rect.width : rect.height;
      const first = Math.floor((-offset / view.zoom) / minor), last = Math.ceil(((extent - offset) / view.zoom) / minor);
      ctx.beginPath(); for (let i = first; i <= last && i < first + 2000; i++) { const at = Math.round(offset + i * minor * view.zoom) + .5, main = i % 5 === 0, length = main ? 10 : 5; if (horizontal) { ctx.moveTo(at, 23); ctx.lineTo(at, 23 - length); if (main) ctx.fillText(String(Number((i * minor / scale).toFixed(2))), at + 3, 10); } else { ctx.moveTo(23, at); ctx.lineTo(23 - length, at); if (main) { ctx.save(); ctx.translate(10, at + 3); ctx.rotate(-Math.PI / 2); ctx.fillText(String(Number((i * minor / scale).toFixed(2))), 0, 0); ctx.restore(); } } } ctx.stroke();
    }
  }
  for (const [axis, coordinate] of [['horizontal', 'x'], ['vertical', 'y']]) listen($(`ruler-${axis}`), 'click', event => { const r = event.currentTarget.getBoundingClientRect(); const value = control.screenToWorld({ x: event.clientX - r.left, y: event.clientY - r.top }); addGuide(coordinate, value[coordinate]); });
  function refresh() {
    for (const button of document.querySelectorAll('[data-action]')) { const action = actions.get(button.dataset.action); if (action) button.disabled = !action.enabled(); }
    const shape = selected()[0];
    for (const [id, key] of [['r-font', 'fontFamily'], ['r-size', 'fontSize'], ['r-fill', 'fill'], ['r-stroke', 'stroke']]) { const input = $(id); input.disabled = !shape; if (shape && document.activeElement !== input) { const value = shape.style[key]; if(id==='r-font'&&![...input.options].some(option=>option.value===value)){const option=document.createElement('option');option.value=value;option.textContent=value;input.append(option);} if (input.type !== 'color' || /^#[\da-f]{6}$/i.test(value)) input.value = value; } }
    for (const property of ['bold', 'italic', 'underline']) document.querySelector(`[data-action="${property}"]`).classList.toggle('active', !!shape?.style[property]);
    if (activePane === 'comments') renderComments(); if (activePane === 'sheet') renderSheet(); if (activePane === 'format') renderSemanticProperties();
    // The original layer list is regenerated by studio.js, so add the independent print toggle after it.
    if (activePane === 'layers') [...$('layers').children].forEach((row, i) => { const layer = page().layers[i]; if (!layer || row.querySelector('[data-print-toggle]')) return; const label = document.createElement('label'); label.textContent = 'Print'; const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.printToggle = 'true'; input.checked = layer.printable; input.setAttribute('aria-label', `Print ${layer.name}`); input.onchange = () => engine.updatePage(control.pageId, { layers: page().layers.map(l => l.id === layer.id ? { ...l, printable: input.checked } : l) }); label.prepend(input); row.append(label); });
    drawRulers();
  }
  const invalidate = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh(); }); };
  unsubscribers.push(engine.changed.subscribe(invalidate), engine.selectionChanged.subscribe(invalidate), control.viewChanged.subscribe(invalidate));
  const resize = new ResizeObserver(invalidate); resize.observe(document.querySelector('.drawing-area'));
  Object.assign(studio, { operations, sheet, workspace: { run, setTab, setPane, template, actions } });
  listen(window, 'pagehide', () => { controller.abort(); resize.disconnect(); cancelAnimationFrame(frame); unsubscribers.forEach(unsubscribe => unsubscribe()); sheet.dispose(); });
  refresh(); return studio.workspace;
};
