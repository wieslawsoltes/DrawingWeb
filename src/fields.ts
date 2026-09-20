/** Opt-in live text fields. Imported formulas stay inert until explicitly activated. */
import type { DiagramEngine } from './core.js';
import type { Diagnostic, Shape } from './model.js';
import type { FormulaValue } from './formula.js';
import { DrawingError, clone } from './model.js';
import { ShapeSheetService } from './shapesheet.js';

/** Deliberately strict numeric picture profile. Unsupported units/date/calendar pictures are errors, not guesses. */
export function formatField(value: FormulaValue, picture?: string): string {
  if (!picture || picture === '@') return String(value);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DrawingError('FIELD_FORMAT', 'Numeric format pictures require a finite number.');
  const match = picture.match(/^(0|#,##0)(?:\.(0{1,12}))?(%)?$/);
  if (!match) throw new DrawingError('FIELD_FORMAT', `Unsupported format picture: ${picture}`);
  const digits = match[2]?.length ?? 0, scaled = match[3] ? value * 100 : value;
  if (!Number.isFinite(scaled)) throw new DrawingError('FIELD_FORMAT', 'Formatted field overflow.');
  return new Intl.NumberFormat('en-US', { useGrouping: match[1] === '#,##0', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(scaled) + (match[3] ?? '');
}

export class TextFieldService {
  private readonly sheet: ShapeSheetService;
  private readonly ownsSheet: boolean;
  private readonly release: () => void;
  private readonly changed: () => void;
  private active = new Set<string>();
  private disposed = false;
  private errors: Diagnostic[] = [];
  get diagnostics(): readonly Diagnostic[] { return this.errors; }
  constructor(readonly engine: DiagramEngine, sheet?: ShapeSheetService) {
    this.sheet = sheet ?? new ShapeSheetService(engine); this.ownsSheet = !sheet;
    this.release = engine.addDerivation(() => { this.recalculate(); });
    this.changed = engine.changed.subscribe(change => { if (change.origin === 'load') { this.active.clear(); this.errors = []; } });
  }
  activate(shapeIds: readonly string[] = this.engine.allShapes().map(shape => shape.id)): readonly Diagnostic[] {
    this.assertAlive();
    for (const id of shapeIds) if (this.engine.getShape(id)?.richText?.paragraphs.some(p => p.runs.some(r => r.field))) this.active.add(id);
    return this.recalculate();
  }
  deactivate(shapeIds?: readonly string[]): void {
    this.assertAlive(); if (shapeIds) shapeIds.forEach(id => this.active.delete(id)); else this.active.clear();
  }
  recalculate(): readonly Diagnostic[] {
    this.assertAlive(); const diagnostics: Diagnostic[] = [], patches: { id: string; patch: Partial<Shape> }[] = [];
    for (const id of this.active) {
      const shape = this.engine.getShape(id); if (!shape?.richText) continue;
      const richText = clone(shape.richText); let changed = false;
      for (const paragraph of richText.paragraphs) for (const run of paragraph.runs) {
        if (!run.field) continue;
        try {
          const pageId = this.engine.getRef(id)!.pageId, page = this.engine.getPage(pageId);
          const value = this.sheet.evaluateExpression(id, run.field.formula, {
            call: (name, args) => {
              const arity = (min: number, max = min) => { if (args.length < min || args.length > max) throw new DrawingError('FORMULA_ARITY', `${name} requires ${min}..${max} arguments.`); };
              switch (name) {
                case 'PAGENAME': arity(0, 1); return page.name;
                case 'PAGENUMBER': arity(0); return this.engine.document.pages.indexOf(page) + 1;
                case 'PAGECOUNT': arity(0); return this.engine.document.pages.length;
                case 'DOCTITLE': arity(0); return this.engine.document.title;
                case 'FORMAT': arity(2); return formatField(args[0]!, String(args[1]));
                default: return undefined;
              }
            },
          });
          // Native numeric format IDs are not format pictures; keep their cached display until supported.
          if (run.field.nativeFormat && run.field.nativeFormat !== '0' && !run.field.format)
            throw new DrawingError('FIELD_NATIVE_FORMAT', `Native format ${run.field.nativeFormat} is retained but not recalculated.`);
          const text = formatField(value, run.field.format);
          if (text.length > 1_000_000) throw new DrawingError('FIELD_LIMIT', 'Text field exceeds one million characters.');
          if (text !== run.text || run.field.value !== String(value)) {
            run.text = text; run.field.value = String(value); run.field.unit = typeof value === 'string' ? 'STR' : 'NUM'; changed = true;
          }
        } catch (error) {
          diagnostics.push({ code: error instanceof DrawingError ? error.code : 'FIELD_EVALUATION', severity: 'warning', shapeId: id,
            message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (changed) patches.push({ id, patch: { richText } });
    }
    // All fields read the same snapshot. Field errors retain their caches and never abort unrelated edits.
    if (patches.length) this.engine.transaction('Recalculate text fields', () => {
      for (const { id, patch } of patches) this.engine.update(id, patch);
    });
    this.errors = diagnostics; return diagnostics;
  }
  private assertAlive(): void { if (this.disposed) throw new DrawingError('DISPOSED', 'Text field service disposed.'); }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.release(); this.changed(); if (this.ownsSheet) this.sheet.dispose(); this.active.clear(); this.errors = [];
  }
}
