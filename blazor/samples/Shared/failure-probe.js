// A deliberately failing sample-only module for the lifecycle regression test.
export function create() {
  globalThis.drawingwebFailureProbeAttempts = (globalThis.drawingwebFailureProbeAttempts ?? 0) + 1;
  throw new Error('Intentional lifecycle probe failure');
}
