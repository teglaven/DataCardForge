/**
 * Shared polyfills for jsdom suites.
 *
 * jsdom implements neither ResizeObserver nor requestAnimationFrame-adjacent layout, and
 * the components under test legitimately use both (VirtualTable observes its viewport to
 * size the virtual window; ConnectionLayer coalesces invalidations into one frame). A
 * no-op observer is enough — these tests assert on the state they stub themselves
 * (rects, store values), never on real layout.
 */

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
}

export {};
