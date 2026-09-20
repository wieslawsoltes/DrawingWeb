/** Visio XML inheritance overlay. The original trees remain untouched for package preservation. */
import { DrawingError, clone } from './model.js';
import { elements, isElement, localName } from './xml.js';
import type { XmlElement, XmlChild } from './xml.js';

const deleted = (node: XmlElement): boolean => /^(1|true)$/i.test(node.attributes['Del'] ?? '');
const inherited = (node: XmlElement): boolean => /^inh$/i.test(node.attributes['F'] ?? '');
function sameIdentity(a: XmlElement, b: XmlElement): boolean {
  const kind = localName(a.name);
  if (kind !== localName(b.name)) return false;
  if (kind === 'Cell') return a.attributes['N'] === b.attributes['N'];
  if (kind === 'Section') return a.attributes['N'] === b.attributes['N'] && (a.attributes['IX'] ?? '0') === (b.attributes['IX'] ?? '0');
  // Named rows match by universal name, not a coincidentally equal numeric index.
  if (kind === 'Row') {
    if (a.attributes['N'] || b.attributes['N']) return !!a.attributes['N'] && a.attributes['N'] === b.attributes['N'];
    return (a.attributes['IX'] ?? '0') === (b.attributes['IX'] ?? '0');
  }
  return true;
}
/** Merge cells within rows, rows within sections, and direct cells within shapes/styles.
 * Tombstones stay in the effective tree so a later style overlay cannot resurrect deleted rows.
 * For F=Inh, the local cached V remains authoritative while F comes from the definition.
 */
export function mergeVisioShape(local: XmlElement, base?: XmlElement, depth = 0): XmlElement {
  if (depth > 128) throw new DrawingError('VISIO_INHERITANCE_DEPTH', 'XML inheritance exceeds 128 levels.');
  if (!base || deleted(local)) return clone(local);
  if (localName(local.name) === 'Cell') {
    if (!inherited(local)) return clone(local);
    const attributes = { ...base.attributes, ...local.attributes };
    delete attributes['F'];
    if (base.attributes['F'] && !inherited(base)) attributes['F'] = base.attributes['F'];
    return { ...clone(local), attributes };
  }
  const localChildren = elements(local);
  const consumed = new Set<XmlElement>();
  const children: XmlChild[] = [];
  for (const original of base.children) {
    // Whitespace, Text, Shapes and opaque extensions are handled as complete values.
    if (!isElement(original)) continue;
    const kind = localName(original.name);
    if (!['Cell', 'Section', 'Row', 'Text', 'ForeignData'].includes(kind)) continue;
    const override = localChildren.find(candidate => sameIdentity(candidate, original));
    if (override) {
      if (consumed.has(override)) throw new DrawingError('VISIO_INHERITANCE_ID', 'Duplicate definition identity in inherited XML.');
      consumed.add(override);
      children.push(['Cell', 'Section', 'Row'].includes(kind)
        ? mergeVisioShape(override, original, depth + 1) : clone(override));
    } else children.push(clone(original));
  }
  for (const child of local.children) if (!isElement(child) || !consumed.has(child)) children.push(clone(child));
  return { name: local.name, attributes: { ...base.attributes, ...local.attributes }, children };
}

/** Resolve a formatting-role style chain. Cycles are rejected rather than truncated silently. */
export function resolveVisioStyle(styles: ReadonlyMap<string, XmlElement>, id: string, role: 'FillStyle' | 'LineStyle' | 'TextStyle'): XmlElement | undefined {
  const path = new Set<string>();
  const resolve = (key: string): XmlElement | undefined => {
    const current = styles.get(key); if (!current) return;
    if (path.has(key)) throw new DrawingError('VISIO_STYLE_CYCLE', `Circular ${role} inheritance at style ${key}.`);
    if (path.size >= 128) throw new DrawingError('VISIO_INHERITANCE_DEPTH', 'Style inheritance exceeds 128 levels.');
    path.add(key);
    const parent = current.attributes[role];
    // Visio's no-style definition may explicitly refer to itself.
    const base = parent && !(key === '0' && parent === '0') ? resolve(parent) : undefined;
    path.delete(key); return mergeVisioShape(current, base);
  };
  return resolve(id);
}
