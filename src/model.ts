/** Serializable, renderer-independent DrawingWeb document contracts. All coordinates are CSS pixels. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export type Matrix = readonly [number, number, number, number, number, number];
export type ShapeKind = 'rectangle' | 'roundRect' | 'ellipse' | 'diamond' | 'parallelogram' |
  'document' | 'database' | 'cloud' | 'hexagon' | 'triangle' | 'text' | 'path' | 'connector' | 'group';
export interface ShapeStyle {
  fill: string; stroke: string; strokeWidth: number; opacity: number;
  color: string; fontFamily: string; fontSize: number; bold: boolean; italic: boolean;
  align: 'left' | 'center' | 'right'; dash: number[]; startArrow: boolean; endArrow: boolean;
}
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
}
export interface Layer { id: string; name: string; visible: boolean; locked: boolean; printable: boolean }
export interface Page { id: string; name: string; width: number; height: number; background: string; shapes: Shape[]; layers: Layer[] }
export interface Master { id: string; name: string; category: string; shape: Shape }
export interface DiagramDocument {
  schema: 'drawingweb/1'; id: string; title: string; pages: Page[]; masters: Master[];
  metadata: Record<string, Json>;
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
  if (json.length > maxBytes) throw new DrawingError('DOCUMENT_LIMIT', 'Document exceeds the configured limit.');
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
}
const KINDS = new Set<ShapeKind>(['rectangle', 'roundRect', 'ellipse', 'diamond', 'parallelogram', 'document', 'database', 'cloud', 'hexagon', 'triangle', 'text', 'path', 'connector', 'group']);
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
