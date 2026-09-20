/** Serializable, renderer-independent DrawingWeb document contracts. All coordinates are CSS pixels. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export type Matrix = readonly [number, number, number, number, number, number];
export type ShapeKind = 'rectangle' | 'roundRect' | 'ellipse' | 'diamond' | 'parallelogram' |
  'document' | 'database' | 'cloud' | 'hexagon' | 'triangle' | 'text' | 'path' | 'connector' | 'group' | 'container' | 'swimlane' | 'callout' | 'image';
export interface ShapeStyle {
  fill: string; stroke: string; strokeWidth: number; opacity: number;
  color: string; fontFamily: string; fontSize: number; bold: boolean; italic: boolean;
  underline?: boolean; strike?: boolean; verticalAlign?: 'top' | 'middle' | 'bottom';
  padding?: number; lineSpacing?: number;
  align: 'left' | 'center' | 'right'; dash: number[]; startArrow: boolean; endArrow: boolean;
}
export interface TextRun {
  text: string;
  style?: Partial<Pick<ShapeStyle, 'fontFamily' | 'fontSize' | 'bold' | 'italic' | 'underline' | 'strike' | 'color'>>;
  /** Retained cached field text, not executable code. */
  field?: { formula: string; format?: string };
}
export interface TextParagraph {
  runs: TextRun[]; align?: 'left' | 'center' | 'right';
  bullet?: 'none' | 'bullet' | 'number'; indent?: number; spaceBefore?: number; spaceAfter?: number;
}
export interface RichText { paragraphs: TextParagraph[] }
export interface TextBlock extends Rect { rotation?: number }
export interface Hyperlink {
  id: string; description: string; address?: string; subAddress?: string;
  pageId?: string; shapeId?: string; newWindow?: boolean;
}
export interface ContainerProperties {
  memberIds: string[]; padding: number; headerSize: number; autoResize: boolean;
  locked: boolean; orientation: 'horizontal' | 'vertical';
  /** A pool contains ordered swimlane containers, not transformed children. */
  layout?: 'pool' | 'list';
}
export interface DiagramComment {
  id: string; pageId: string; shapeId?: string; position?: Point; author: string;
  text: string; createdUtc: string; resolved: boolean; replies: CommentReply[];
}
export interface CommentReply { id: string; author: string; text: string; createdUtc: string }
export interface DataColumn { name: string; label?: string; type: 'string' | 'number' | 'boolean' | 'date' | 'json'; required?: boolean }
export interface DataRecordset {
  id: string; name: string; keyField: string; columns: DataColumn[];
  rows: Record<string, Json>[]; revision?: string;
}
export interface ShapeDataLink { recordsetId: string; rowKey: string | number; mappings: Record<string, string> }
export interface DataGraphicRule {
  id: string; type: 'color' | 'text' | 'bar' | 'icon'; field: string;
  label?: string; color?: string; background?: string; min?: number; max?: number;
  cases?: { value: Json; color: string; label?: string }[];
  /** Numeric upper bounds are evaluated in ascending order. */
  thresholds?: { max: number; color: string; label?: string }[];
}
export interface DataGraphic { id: string; name: string; rules: DataGraphicRule[] }
export interface DiagramTheme { id: string; name: string; colors: Record<string, string>; fontFamily: string }
export interface ThemeBinding { fill?: string; stroke?: string; color?: string; font?: boolean }
export interface Port { id: string; x: number; y: number; direction?: 'north' | 'east' | 'south' | 'west' }
export interface Endpoint { shapeId?: string; portId?: string; x?: number; y?: number }
export interface Shape extends Rect {
  id: string; kind: ShapeKind; text: string; rotation: number; style: ShapeStyle;
  /** Additional affine transform, applied after x/y translation and before geometry. */
  transform?: Matrix;
  layerId?: string; locked?: boolean; visible?: boolean; masterId?: string;
  data: Record<string, Json>; cells: Record<string, { value: string; formula?: string; unit?: string }>;
  ports: Port[]; children?: Shape[];
  /** SVG path in local physical coordinates; never interpreted as HTML. */
  path?: string;
  points?: Point[]; source?: Endpoint; target?: Endpoint;
  routing?: 'straight' | 'orthogonal' | 'manual';
  richText?: RichText; textBlock?: TextBlock; hyperlinks?: Hyperlink[];
  container?: ContainerProperties; calloutTargetId?: string;
  image?: { source: string; fit: 'contain' | 'cover' | 'stretch'; alt: string };
  dataLinks?: ShapeDataLink[]; dataGraphicId?: string; theme?: ThemeBinding;
  /** Explicit stable numeric sheet identity for ShapeSheet references. */
  sheetId?: number;

}
export interface Layer { id: string; name: string; visible: boolean; locked: boolean; printable: boolean }
export interface Page { id: string; name: string; width: number; height: number; background: string; shapes: Shape[]; layers: Layer[];
  backgroundPageId?: string; isBackground?: boolean; unit?: 'px' | 'mm' | 'in';
  guides?: { x: number[]; y: number[] };
}
export interface Master { id: string; name: string; category: string; shape: Shape }
export interface DiagramDocument {
  schema: 'drawingweb/1'; id: string; title: string; pages: Page[]; masters: Master[];
  metadata: Record<string, Json>;
  comments?: DiagramComment[]; recordsets?: DataRecordset[]; dataGraphics?: DataGraphic[]; theme?: DiagramTheme;
}
export interface Diagnostic { code: string; severity: 'info' | 'warning' | 'error'; message: string; part?: string; shapeId?: string }
export class DrawingError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name = 'DrawingError'; }
}
export const DEFAULT_STYLE: Readonly<ShapeStyle> = Object.freeze({
  fill: '#f0eefb', stroke: '#a69bbf', strokeWidth: 1.25, opacity: 1,
  color: '#413a56', fontFamily: 'system-ui, sans-serif', fontSize: 13,
  bold: false, italic: false, align: 'center', dash: [], startArrow: false, endArrow: false,
});
export function id(prefix = 's'): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new DrawingError('CRYPTO_UNAVAILABLE', 'A cryptographically secure random source is required.');
  if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  // randomUUID is restricted to secure origins; getRandomValues also supports local HTTP hosts.
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function createShape(kind: ShapeKind = 'rectangle', options: Omit<Partial<Shape>, 'style'> & { style?: Partial<ShapeStyle> } = {}): Shape {
  return { id: id(), kind, x: 0, y: 0, width: 160, height: 70, text: '', rotation: 0,
    data: {}, cells: {}, ports: [], ...options, style: { ...DEFAULT_STYLE, ...options.style, dash: [...(options.style?.dash ?? [])] } };
}
export function createPage(name = 'Page 1', options: Partial<Page> = {}): Page {
  return { id: id('p'), name, width: 1200, height: 800, background: '#ffffff', shapes: [],
    layers: [{ id: 'default', name: 'Drawing', visible: true, locked: false, printable: true }], ...options };
}
export function createDocument(title = 'Untitled diagram'): DiagramDocument {
  return { schema: 'drawingweb/1', id: id('d'), title, pages: [createPage()], masters: [], metadata: {} };
}
/** Do not pass untrusted arbitrary objects to the engine; parseDocument validates its entire JSON tree. */
export function parseDocument(json: string, maxBytes = 64 * 1024 * 1024): DiagramDocument {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new DrawingError('DOCUMENT_LIMIT','maxBytes must be a positive safe integer.');
  if (json.length > maxBytes || new TextEncoder().encode(json).byteLength > maxBytes) throw new DrawingError('DOCUMENT_LIMIT', 'Document exceeds the configured limit.');
  const document = JSON.parse(json) as DiagramDocument;
  validateDocument(document); return document;
}
export function validateDocument(document: DiagramDocument): void {
  if (!document || document.schema !== 'drawingweb/1' || !Array.isArray(document.pages) || document.pages.length === 0 || document.pages.length > 4096)
    throw new DrawingError('DOCUMENT_SCHEMA', 'Expected a DrawingWeb document with at least one page.');
  const ids = new Set<string>(); let count = 0;
  const reserve = (value: unknown) => { if (typeof value !== 'string' || !value || ids.has(value)) throw new DrawingError('DUPLICATE_ID', `Invalid or duplicate ID: ${String(value)}`); ids.add(value); };
  const numeric = (value: unknown, positive = false) => { if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9 || (positive && value < 0)) throw new DrawingError('INVALID_NUMBER', 'Geometry must contain finite, bounded numbers.'); };
  const walk = (shapes: Shape[], depth: number) => {
    if (!Array.isArray(shapes) || depth > 64) throw new DrawingError('DOCUMENT_DEPTH', 'Invalid shape collection or excessive nesting.');
    for (const shape of shapes) {
      if (++count > 1_000_000) throw new DrawingError('SHAPE_LIMIT', 'Too many shapes.');
      reserve(shape.id); numeric(shape.x); numeric(shape.y); numeric(shape.width, true); numeric(shape.height, true); numeric(shape.rotation);
      if (typeof shape.text !== 'string' || !KINDS.has(shape.kind) || !shape.style || !shape.data || !shape.cells || !Array.isArray(shape.ports))
        throw new DrawingError('SHAPE_SCHEMA', `Invalid shape ${shape.id}.`);
      numeric(shape.style.strokeWidth, true); numeric(shape.style.fontSize, true); numeric(shape.style.opacity);
      for(const key of ['fill','stroke','color','fontFamily'] as const)if(typeof shape.style[key]!=='string'||shape.style[key].length>65536)throw new DrawingError('STYLE_SCHEMA','Invalid style string.');
      if(shape.style.opacity<0||shape.style.opacity>1||!Array.isArray(shape.style.dash)||!['left','center','right'].includes(shape.style.align))throw new DrawingError('STYLE_SCHEMA','Invalid opacity, dash or alignment.');
      shape.style.dash.forEach(value=>numeric(value,true));
      if(shape.path!==undefined&&(typeof shape.path!=='string'||shape.path.length>16*1024*1024))throw new DrawingError('PATH_LIMIT','Invalid or excessive path data.');
      for(const point of shape.points??[]){numeric(point.x);numeric(point.y);}
      for(const port of shape.ports){if(typeof port.id!=='string')throw new DrawingError('PORT_SCHEMA','Port IDs must be strings.');numeric(port.x);numeric(port.y);}
      for(const endpoint of [shape.source,shape.target])if(endpoint){if(endpoint.x!==undefined)numeric(endpoint.x);if(endpoint.y!==undefined)numeric(endpoint.y);if(endpoint.shapeId!==undefined&&typeof endpoint.shapeId!=='string')throw new DrawingError('ENDPOINT_SCHEMA','Shape references must be strings.');}
      if (shape.transform) { if (shape.transform.length !== 6) throw new DrawingError('TRANSFORM', 'Affine transforms require six elements.'); shape.transform.forEach(v => numeric(v)); }
      if (shape.children) walk(shape.children, depth + 1);
    }
  };
  for (const page of document.pages) { reserve(page.id); numeric(page.width, true); numeric(page.height, true); if (!Array.isArray(page.layers)) throw new DrawingError('PAGE_SCHEMA', 'Layers must be an array.'); walk(page.shapes, 0); }
  if (typeof document.id!=='string'||typeof document.title!=='string'||!Array.isArray(document.masters) || !document.metadata) throw new DrawingError('DOCUMENT_SCHEMA', 'Masters and metadata are required.');
  validateJson(document);
  validateExtendedDocument(document);
}
const KINDS = new Set<ShapeKind>(['rectangle', 'roundRect', 'ellipse', 'diamond', 'parallelogram', 'document', 'database', 'cloud', 'hexagon', 'triangle', 'text', 'path', 'connector', 'group', 'container', 'swimlane', 'callout', 'image']);
/** Reject prototype keys and non-JSON values at every nesting level. */
export function validateJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 128) throw new DrawingError('JSON_DEPTH', 'JSON nesting is too deep.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new DrawingError('JSON_NUMBER', 'Non-finite JSON number.'); return; }
  if (typeof value !== 'object' || seen.has(value)) throw new DrawingError('JSON_VALUE', 'Cyclic or unsupported JSON value.');
  const prototype=Object.getPrototypeOf(value); if(!Array.isArray(value)&&prototype!==Object.prototype&&prototype!==null)throw new DrawingError('JSON_VALUE','Only plain JSON objects are supported.');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new DrawingError('UNSAFE_KEY', `Unsafe property: ${key}`);
    validateJson(child, depth + 1, seen);
  }
  seen.delete(value);
}
export function clone<T>(value: T): T { return structuredClone(value); }
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
export type Unsubscribe = () => void;
/** Synchronous snapshot delivery. Observer failures cannot roll back a committed transaction. */
export class Signal<T> {
  private listeners = new Set<(value: T) => void>();
  constructor(private readonly reportError: (error: unknown) => void = error => console.error('DrawingWeb observer error', error)) {}
  subscribe(listener: (value: T) => void): Unsubscribe { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(value: T): void { for (const listener of [...this.listeners]) { try { listener(value); } catch (error) { this.reportError(error); } } }
  clear(): void { this.listeners.clear(); }
}

/** The portable model never treats document-provided links as executable URLs. */
export function safeHyperlink(address: string): string | undefined {
  if (/[\u0000-\u0020\u007f]/.test(address) || address.length > 8192) return;
  try { const url = new URL(address); return ['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol) ? url.href : undefined; }
  catch { return; }
}
export function plainText(text: RichText): string { return text.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n'); }
export function rowIdentity(key: unknown): string {
  if (typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key)))
    throw new DrawingError('ROW_KEY', 'A row key must be a string or a finite number.');
  return typeof key + ':' + String(key);
}
function validateExtendedDocument(document: DiagramDocument): void {
  const fail = (code: string, message: string): never => { throw new DrawingError(code, message); };
  const finite = (value: unknown, min = -1e9, max = 1e9): boolean => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const named = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192;
  const unique = <T extends { id: string }>(items: readonly T[], code: string): Map<string, T> => {
    if (!Array.isArray(items) || items.length > 100000) fail(code, 'Invalid or excessive collection.');
    const result = new Map<string, T>();
    for (const item of items) { if (!item || !named(item.id) || result.has(item.id)) fail(code, 'Invalid or duplicate identity.'); result.set(item.id, item); }
    return result;
  };
  const graphics = unique(document.dataGraphics ?? [], 'DATA_GRAPHIC');
  for (const graphic of graphics.values()) {
    if (!Array.isArray(graphic.rules) || graphic.rules.length > 64) fail('DATA_GRAPHIC', 'At most 64 data graphic rules are allowed.');
    unique(graphic.rules, 'DATA_GRAPHIC');
    for (const rule of graphic.rules) {
      if (!['color','text','bar','icon'].includes(rule.type) || !named(rule.field) || ['__proto__','constructor','prototype'].includes(rule.field)) fail('DATA_GRAPHIC', 'Invalid data graphic rule.');
      if (rule.min !== undefined && !finite(rule.min) || rule.max !== undefined && !finite(rule.max)) fail('DATA_GRAPHIC', 'Invalid numeric range.');
      if (rule.type === 'bar' && (rule.max ?? 100) <= (rule.min ?? 0)) fail('DATA_GRAPHIC', 'Bar maximum must exceed minimum.');
      for (const entry of rule.thresholds ?? []) if (!finite(entry.max) || typeof entry.color !== 'string') fail('DATA_GRAPHIC', 'Invalid threshold.');
      for (const entry of rule.cases ?? []) if (typeof entry.color !== 'string') fail('DATA_GRAPHIC', 'Invalid color case.');
    }
  }
  const recordsets = unique(document.recordsets ?? [], 'RECORDSET');
  for (const set of recordsets.values()) {
    if (!named(set.keyField) || !Array.isArray(set.rows) || set.rows.length > 100000 || !Array.isArray(set.columns)) fail('RECORDSET', 'Invalid recordset.');
    const columns = new Set<string>();
    for (const column of set.columns) {
      if (!named(column.name) || columns.has(column.name) || !['string','number','boolean','date','json'].includes(column.type)) fail('RECORDSET', 'Invalid column schema.');
      columns.add(column.name);
    }
    const rows = new Set<string>();
    for (const row of set.rows) {
      const key = rowIdentity(row?.[set.keyField]); if (rows.has(key)) fail('ROW_KEY', 'Duplicate recordset key.'); rows.add(key);
      for (const column of set.columns) {
        const value = row[column.name];
        if (value === undefined || value === null) { if (column.required) fail('RECORDSET', 'Required column is missing.'); continue; }
        if (column.type === 'number' && typeof value !== 'number' || column.type === 'boolean' && typeof value !== 'boolean' ||
            (column.type === 'string' || column.type === 'date') && typeof value !== 'string') fail('RECORDSET', 'Column type mismatch.');
      }
    }
  }
  const pages = new Map(document.pages.map(p => [p.id, p]));
  const shapes = new Map<string, { shape: Shape; pageId: string; parentId?: string }>();
  const visit = (items: Shape[], pageId: string, parentId?: string): void => {
    for (const shape of items) { shapes.set(shape.id, { shape, pageId, parentId }); if (shape.children) visit(shape.children, pageId, shape.id); }
  };
  for (const page of document.pages) {
    if (typeof page.name !== 'string' || typeof page.background !== 'string') fail('PAGE_SCHEMA', 'Invalid page properties.');
    const layers = unique(page.layers, 'LAYER_SCHEMA');
    for (const layer of layers.values()) if (typeof layer.name !== 'string' || typeof layer.visible !== 'boolean' || typeof layer.locked !== 'boolean' || typeof layer.printable !== 'boolean') fail('LAYER_SCHEMA', 'Invalid layer.');
    const seen = new Set<string>([page.id]); let bg = page.backgroundPageId;
    while (bg) { if (seen.has(bg) || !pages.has(bg)) fail('BACKGROUND_PAGE', 'Background page links must be acyclic and refer to existing pages.'); seen.add(bg); bg = pages.get(bg)!.backgroundPageId; }
    if (page.unit !== undefined && !['px','mm','in'].includes(page.unit)) fail('PAGE_UNIT', 'Unsupported display unit.');
    for (const values of [page.guides?.x, page.guides?.y]) if (values && (!Array.isArray(values) || values.length > 10000 || values.some(n => !finite(n)))) fail('GUIDES', 'Invalid guides.');
    visit(page.shapes, page.id);
    const sheetIds = new Set<number>();
    for (const item of shapes.values()) if (item.pageId === page.id && item.shape.sheetId !== undefined) {
      const id = item.shape.sheetId; if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff || sheetIds.has(id)) fail('SHEET_ID', 'Sheet IDs must be unique positive integers per page.'); sheetIds.add(id);
    }
  }
  for (const { shape, pageId, parentId } of shapes.values()) {
    const container = shape.container;
    if (container) {
      if (!Array.isArray(container.memberIds) || new Set(container.memberIds).size !== container.memberIds.length ||
          !finite(container.padding,0,1e6) || !finite(container.headerSize,0,1e6) || !['horizontal','vertical'].includes(container.orientation) ||
          typeof container.locked !== 'boolean' || typeof container.autoResize !== 'boolean' || container.layout!==undefined&&!['pool','list'].includes(container.layout)) fail('CONTAINER', 'Invalid container properties.');
      for (const memberId of container.memberIds) {
        const member = shapes.get(memberId);
        if (!member || memberId === shape.id || member.pageId !== pageId || member.parentId !== parentId) fail('CONTAINER_MEMBER', 'Container members must be distinct shapes with the same page and transform parent.');
        if (container.layout === 'pool' && member!.shape.kind !== 'swimlane') fail('SWIMLANE', 'A swimlane pool contains only swimlane containers.');
      }
    }
    if (shape.calloutTargetId && (!shapes.has(shape.calloutTargetId) || shapes.get(shape.calloutTargetId)!.pageId !== pageId || shape.calloutTargetId === shape.id)) fail('CALLOUT', 'Invalid callout target.');
    if (shape.dataGraphicId && !graphics.has(shape.dataGraphicId)) fail('DATA_GRAPHIC', 'Missing data graphic definition.');
    for (const link of shape.dataLinks ?? []) {
      const set = recordsets.get(link.recordsetId);
      if (!set || !link.mappings || typeof link.mappings !== 'object') fail('DATA_LINK', 'Missing linked recordset or mappings.');
      rowIdentity(link.rowKey);
      // Missing rows are legal after refresh. They remain unresolved links, never rebound by array index.
    }
    if (shape.image && (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(shape.image.source) || shape.image.source.length > 24*1024*1024 || !['contain','cover','stretch'].includes(shape.image.fit) || typeof shape.image.alt !== 'string')) fail('IMAGE_SOURCE', 'Only bounded embedded PNG/JPEG/WebP/GIF data URLs are supported.');
    if (shape.textBlock) { const b=shape.textBlock; if (![b.x,b.y,b.width,b.height,b.rotation??0].every(v=>finite(v)) || b.width<0 || b.height<0) fail('TEXT_BLOCK','Invalid text transform.'); }
    if (shape.richText) {
      const paragraphs = shape.richText.paragraphs;
      if (!Array.isArray(paragraphs) || paragraphs.length > 100000) fail('RICH_TEXT', 'Invalid paragraph collection.');
      let runs = 0;
      for (const p of paragraphs) {
        if (!Array.isArray(p.runs) || (runs += p.runs.length)>100000 || p.align !== undefined && !['left','center','right'].includes(p.align)) fail('RICH_TEXT', 'Invalid paragraphs or excessive runs.');
        for (const run of p.runs) {
          if (typeof run.text !== 'string' || run.style?.fontSize !== undefined && !finite(run.style.fontSize,0,1e6)) fail('RICH_TEXT', 'Invalid text run.');
          if (run.style?.color !== undefined && typeof run.style.color !== 'string' || run.style?.fontFamily !== undefined && typeof run.style.fontFamily !== 'string') fail('RICH_TEXT','Invalid run style.');
        }
      }
      if (plainText(shape.richText) !== shape.text) fail('RICH_TEXT', 'Shape.text must equal the plain-text projection of richText.');
    }
    for (const link of shape.hyperlinks ?? []) if (!named(link.id) || typeof link.description !== 'string' || link.address !== undefined && typeof link.address !== 'string') fail('HYPERLINK', 'Invalid hyperlink.');
    if (shape.style.padding !== undefined && !finite(shape.style.padding,0,1e6) || shape.style.lineSpacing !== undefined && !finite(shape.style.lineSpacing,.1,10)) fail('STYLE_SCHEMA','Invalid text spacing.');
  }
  // Iterative graph traversal bounds membership validation without relying on the JS call stack.
  const done = new Set<string>();
  for (const key of shapes.keys()) {
    if (done.has(key)) continue;
    const active = new Set<string>(), stack: { id:string; exit:boolean }[] = [{id:key,exit:false}];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.exit) { active.delete(current.id); done.add(current.id); continue; }
      if (done.has(current.id)) continue;
      if (active.has(current.id)) fail('CONTAINER_CYCLE','Container membership must not contain cycles.');
      if (active.size >= 64) fail('CONTAINER_DEPTH','Container nesting exceeds 64.');
      active.add(current.id); stack.push({id:current.id,exit:true});
      for (const member of shapes.get(current.id)?.shape.container?.memberIds ?? []) stack.push({id:member,exit:false});
    }
  }
  for (const comment of unique(document.comments ?? [],'COMMENT').values()) {
    if (!pages.has(comment.pageId) || comment.shapeId && shapes.get(comment.shapeId)?.pageId !== comment.pageId || typeof comment.text !== 'string' || typeof comment.author !== 'string' || !Number.isFinite(Date.parse(comment.createdUtc))) fail('COMMENT', 'Invalid comment or anchor.');
    if (comment.position && (!finite(comment.position.x) || !finite(comment.position.y))) fail('COMMENT','Invalid comment position.');
    for (const reply of unique(comment.replies,'COMMENT').values()) if (typeof reply.text !== 'string' || typeof reply.author !== 'string' || !Number.isFinite(Date.parse(reply.createdUtc))) fail('COMMENT','Invalid reply.');
  }
  if (document.theme && (!named(document.theme.id) || typeof document.theme.fontFamily !== 'string' || !document.theme.colors || Object.values(document.theme.colors).some(c=>typeof c!=='string'))) fail('THEME','Invalid theme.');
}
