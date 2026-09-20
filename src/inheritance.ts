/** Persistent, cell-granular live master inheritance for native DrawingWeb instances. */
import type { DiagramEngine } from './core.js';
import type { DiagramDocument, Master, Shape, ShapeStyle, MasterBinding } from './model.js';
import { clone, DrawingError } from './model.js';

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
// Native field values and formula-cell results are caches, not local authoring overrides.
function authoredText(shape: Shape): unknown {
  return shape.richText ? shape.richText.paragraphs.map(p => ({ ...p, runs: p.runs.map(r => r.field ? {
    ...r, text: '', field: { ...r.field, value: undefined, unit: undefined },
  } : r) })) : shape.text;
}
function authoredCell(cell: Shape['cells'][string] | undefined): unknown {
  return cell?.formula && cell.formula !== 'No Formula' ? { ...cell, value: undefined } : cell;
}
const flatten = (shapes: readonly Shape[]): Shape[] => shapes.flatMap(shape => [shape, ...flatten(shape.children ?? [])]);
export function masterBinding(source: Shape): MasterBinding {
  return { sourceShapeId: source.id, style: Object.keys(source.style) as (keyof ShapeStyle)[], cells: Object.keys(source.cells), text: true };
}
/** Runs before other derivations. Local writes sever only their inherited channel, within the same undo record. */
export function deriveMasterInheritance(engine: DiagramEngine, before: DiagramDocument): void {
  const instances = engine.allShapes().filter(shape => shape.masterBinding);
  if (!instances.length) return;
  const previous = new Map(before.pages.flatMap(page => flatten(page.shapes)).map(shape => [shape.id, shape]));
  const definitions = new Map(engine.document.masters.map(master => [master.id, new Map(flatten([master.shape]).map(shape => [shape.id, shape]))]));
  for (const instance of instances) {
    const binding = instance.masterBinding!, source = definitions.get(instance.masterId ?? '')?.get(binding.sourceShapeId);
    if (!source) throw new DrawingError('MASTER_BINDING', `Missing master definition for instance ${instance.id}. Detach it before removing its definition.`);
    const old = previous.get(instance.id), next = clone(binding);
    // A replacement binding object is an explicit rebind/restore, not an implicit local edit.
    if (old?.masterBinding === binding) {
      next.style = next.style.filter(key => equal(instance.style[key], old.style[key]));
      next.cells = next.cells.filter(key => equal(authoredCell(instance.cells[key]), authoredCell(old.cells[key])));
      if (!equal(authoredText(instance), authoredText(old))) next.text = false;
    }
    const style = { ...instance.style }, cells = clone(instance.cells);
    for (const key of next.style) {
      if (source.style[key] === undefined) (style as unknown as Record<string, unknown>)[key] = undefined;
      else (style as unknown as Record<string, unknown>)[key] = clone(source.style[key]);
    }
    for (const name of next.cells) {
      if (source.cells[name] === undefined) delete cells[name];
      else if (!equal(authoredCell(source.cells[name]), authoredCell(instance.cells[name]))) cells[name] = clone(source.cells[name]!);
    }
    const patch: Partial<Shape> = { style, cells, masterBinding: next };
    const textChanged = next.text && !equal(authoredText(source), authoredText(instance));
    if (textChanged) { patch.text = source.text; patch.richText = clone(source.richText); }
    if (!equal(style, instance.style) || !equal(cells, instance.cells) || !equal(next, binding) ||
      textChanged) engine.update(instance.id, patch);
  }
}

export class MasterService {
  constructor(readonly engine: DiagramEngine) {}
  /** Modify an existing definition without changing its identity. All bound channels update atomically. */
  update(masterId: string, patch: Partial<Omit<Master, 'id'>>): void {
    const found = this.engine.document.masters.some(master => master.id === masterId);
    if (!found) throw new DrawingError('MASTER_NOT_FOUND', masterId);
    this.engine.transaction('Edit master definition', () => this.engine.updateDocument({
      masters: this.engine.document.masters.map(master => master.id === masterId ? { ...master, ...clone(patch), id: masterId } : master),
    }));
  }
  /** Restore selected channels; omitted options restore all currently defined style/cell/text channels. */
  restore(shapeId: string, channels?: { style?: (keyof ShapeStyle)[]; cells?: string[]; text?: boolean }): void {
    const shape = this.engine.getShape(shapeId);
    if (!shape?.masterId) throw new DrawingError('MASTER_BINDING', 'The shape is not a master instance.');
    const master = this.engine.document.masters.find(master => master.id === shape.masterId);
    const source = master && flatten([master.shape]).find(source => source.id === (shape.masterBinding?.sourceShapeId ?? master.shape.id));
    if (!source) throw new DrawingError('MASTER_BINDING', 'The source shape no longer exists.');
    const old = shape.masterBinding ?? { sourceShapeId: source.id, style: [], cells: [], text: false };
    const next = channels ? { sourceShapeId: source.id,
      style: [...new Set([...old.style, ...(channels.style ?? [])])],
      cells: [...new Set([...old.cells, ...(channels.cells ?? [])])], text: channels.text ?? old.text,
    } : masterBinding(source);
    this.engine.update(shapeId, { masterBinding: next });
  }
  /** Keep cached content while detaching the selected instance subtree from live inheritance. */
  detach(shapeId: string): void {
    const shape = this.engine.getShape(shapeId); if (!shape) throw new DrawingError('SHAPE_NOT_FOUND', shapeId);
    this.engine.transaction('Detach master instance', () => {
      for (const item of flatten([shape])) this.engine.update(item.id, { masterBinding: undefined, masterId: undefined });
    });
  }
}
