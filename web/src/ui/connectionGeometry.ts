/**
 * Connection geometry — every number the connection layer draws with, as pure functions.
 *
 * Since 2026-10-29 a wire runs from the **centre of one card window to the centre of the
 * other**, and the card interior is punched out by the layer's mask (`ConnectionLayer`), so
 * only the stretch between the two cards is visible. That decision removes the old
 * side-based anchors (`portAnchor` / `cardAnchor`): a curve no longer "leaves the right
 * edge", it leaves the inside of the card and becomes visible where it crosses the frame.
 *
 * A single cubic Bézier is the whole route: two fixed endpoints (the card centres) and two
 * control points. A cubic has at most two inflection points, which is the ceiling the
 * product asked for — more bends read as noise. The control points are *blended* between
 * the horizontal and the vertical solution by `w = |dx| / (|dx| + |dy|)`; without the blend
 * the curve would flip between the two solutions and snap when a drag crossed the
 * diagonal, which is exactly the "smooth trajectory" this module is here to protect.
 *
 * Everything here is DOM-free so the interesting cases (bisection for the arrow, obstacle
 * detection for the transition) can be unit-tested without a layout engine.
 */
import type { Rect } from './cardMetrics.ts';

export interface Point {
  x: number;
  y: number;
}

/** A cubic Bézier: two endpoints plus two control points, all in plane coordinates. */
export interface WireGeometry {
  from: Point;
  to: Point;
  c1: Point;
  c2: Point;
}

export type WireDirection = 'in' | 'out';

/**
 * Plane distance below which a layout change counts as *continuous* (a drag or a resize)
 * and is followed exactly instead of being tweened. A tween on every drag frame would add
 * rubber-band lag to a wire that is supposed to track the cursor.
 */
export const JUMP_THRESHOLD = 24;

/** Transition length for a layout jump (tile / cascade / project load / undo). */
export const TWEEN_MS = 220;

/**
 * Transition length used when the interpolation sweeps across a third card.
 *
 * The wire is invisible under a card (the mask erases it), so crossing one shows up as a
 * flicker at its edges. Covering that stretch quickly is the least noisy way through.
 */
export const FAST_TWEEN_MS = 70;

/** Dash pattern in *screen* px: red (output) draws long, blue (input) draws short. */
export const DASH_OUT: readonly [number, number] = [10, 6];
export const DASH_IN: readonly [number, number] = [4, 5];

/** Dash travel speed in screen px/s, so `in` and `out` dashes move at the same pace. */
export const FLOW_SPEED = 28;

/** Coordinates in path data are rounded to this many decimals to keep the DOM strings sane. */
const PRECISION = 1000;

function round(value: number): number {
  return Math.round(value * PRECISION) / PRECISION;
}

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

function lerpPoint(from: Point, to: Point, t: number): Point {
  return { x: mix(from.x, to.x, t), y: mix(from.y, to.y, t) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The cubic between two card centres.
 *
 * Horizontal solution: both control points sit on the line joining the endpoints
 * (`c1 = from + dx/2`, `c2 = to - dx/2`), so a horizontally aligned pair draws a straight
 * line — which is what "two cards side by side" should look like. Vertical solution is the
 * same rotated. The blend weight is 1 for a perfectly horizontal pair and 0 for a
 * perfectly vertical one, so the two solutions meet continuously and a diagonal pair is a
 * straight line too.
 */
export function wireGeometry(from: Point, to: Point): WireGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const span = Math.abs(dx) + Math.abs(dy);
  // Coincident centres: no direction exists, so the curve collapses onto the endpoints
  // instead of producing NaN control points.
  const w = span < 1e-6 ? 0.5 : Math.abs(dx) / span;

  const horizontal1 = { x: from.x + dx * 0.5, y: from.y };
  const horizontal2 = { x: to.x - dx * 0.5, y: to.y };
  const vertical1 = { x: from.x, y: from.y + dy * 0.5 };
  const vertical2 = { x: to.x, y: to.y - dy * 0.5 };

  return {
    from,
    to,
    c1: {
      x: mix(vertical1.x, horizontal1.x, w),
      y: mix(vertical1.y, horizontal1.y, w),
    },
    c2: {
      x: mix(vertical2.x, horizontal2.x, w),
      y: mix(vertical2.y, horizontal2.y, w),
    },
  };
}

/** `d` attribute for the wire. */
export function pathData(geometry: WireGeometry): string {
  const { from, to, c1, c2 } = geometry;
  return [
    `M ${round(from.x)} ${round(from.y)}`,
    `C ${round(c1.x)} ${round(c1.y)},`,
    `${round(c2.x)} ${round(c2.y)},`,
    `${round(to.x)} ${round(to.y)}`,
  ].join(' ');
}

/** Point on the curve at `t` (De Casteljau). */
export function cubicPoint(geometry: WireGeometry, t: number): Point {
  const { from, to, c1, c2 } = geometry;
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * from.x + b * c1.x + c * c2.x + d * to.x,
    y: a * from.y + b * c1.y + c * c2.y + d * to.y,
  };
}

/** Unit tangent at `t`; falls back to the chord when the derivative vanishes. */
export function cubicTangent(geometry: WireGeometry, t: number): Point {
  const { from, to, c1, c2 } = geometry;
  const u = 1 - t;
  const x = 3 * u * u * (c1.x - from.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (to.x - c2.x);
  const y = 3 * u * u * (c1.y - from.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (to.y - c2.y);
  const length = Math.hypot(x, y);
  if (length < 1e-9) {
    const fallback = Math.hypot(to.x - from.x, to.y - from.y);
    if (fallback < 1e-9) return { x: 1, y: 0 };
    return { x: (to.x - from.x) / fallback, y: (to.y - from.y) / fallback };
  }
  return { x: x / length, y: y / length };
}

export function rectContains(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

export interface ArrowPlacement {
  /** Where the triangle's tip goes: just outside the target card's frame. */
  tip: Point;
  /** Unit vector pointing *into* the card, i.e. the direction the data travels. */
  dir: Point;
}

/** How many samples the curve is walked with before bisecting onto the frame. */
const EXIT_SAMPLES = 96;
const EXIT_BISECTIONS = 8;

/**
 * Where the wire crosses the target card's frame.
 *
 * The endpoint is the card centre, so an arrow drawn there would be erased by the mask.
 * Walking the curve backwards from the centre finds the sample pair that straddles the
 * frame, and a short bisection parks the tip just outside it — visible, and still pointing
 * along the curve rather than along a side's normal.
 *
 * Returns `null` when the whole curve is inside the target card (two cards almost exactly
 * on top of each other). An arrow in the middle of a masked card would be invisible
 * anyway, and the alternative — floating one at the centre — would be a lie.
 */
export function arrowTip(geometry: WireGeometry, rect: Rect): ArrowPlacement | null {
  let inside: Point | null = null;

  for (let i = EXIT_SAMPLES; i >= 0; i -= 1) {
    const t = i / EXIT_SAMPLES;
    const point = cubicPoint(geometry, t);
    if (!rectContains(rect, point)) {
      if (!inside) return null;
      // `t` is outside, `t + 1/EXIT_SAMPLES` is inside: bisect the crossing.
      let outsideT = t;
      let insideT = t + 1 / EXIT_SAMPLES;
      for (let k = 0; k < EXIT_BISECTIONS; k += 1) {
        const midT = (outsideT + insideT) / 2;
        if (rectContains(rect, cubicPoint(geometry, midT))) insideT = midT;
        else outsideT = midT;
      }
      const tip = cubicPoint(geometry, outsideT);
      const inward = cubicPoint(geometry, insideT);
      const length = Math.hypot(inward.x - tip.x, inward.y - tip.y);
      if (length < 1e-9) return null;
      return {
        tip,
        dir: { x: (inward.x - tip.x) / length, y: (inward.y - tip.y) / length },
      };
    }
    inside = point;
  }

  return null;
}

/** Arrowhead triangle with `tip` on the frame and its base on the visible side. */
export function arrowPathAt(tip: Point, dir: Point, zoom: number): string {
  const length = 8 / zoom;
  const half = 4 / zoom;
  const baseX = tip.x - dir.x * length;
  const baseY = tip.y - dir.y * length;
  const px = -dir.y;
  const py = dir.x;
  return [
    `M ${round(tip.x)} ${round(tip.y)}`,
    `L ${round(baseX + px * half)} ${round(baseY + py * half)}`,
    `L ${round(baseX - px * half)} ${round(baseY - py * half)}`,
    'Z',
  ].join(' ');
}

const LABEL_SAMPLES = 64;

/**
 * Where the port label goes: the middle of the longest stretch that is outside every card.
 *
 * The geometric midpoint is no longer usable — with centre anchors it is often inside one
 * of the cards, and the mask would erase the text. Falls back to t = 0.5 when the wire is
 * completely covered (only possible when cards overlap almost exactly).
 */
export function visibleLabelPoint(geometry: WireGeometry, rects: Rect[]): Point {
  if (rects.length === 0) return cubicPoint(geometry, 0.5);

  let bestStart = -1;
  let bestEnd = -1;
  let runStart = -1;

  const closeRun = (end: number) => {
    if (runStart < 0) return;
    if (bestStart < 0 || end - runStart > bestEnd - bestStart) {
      bestStart = runStart;
      bestEnd = end;
    }
    runStart = -1;
  };

  for (let i = 1; i < LABEL_SAMPLES; i += 1) {
    const point = cubicPoint(geometry, i / LABEL_SAMPLES);
    const covered = rects.some((rect) => rectContains(rect, point));
    if (covered) closeRun(i - 1);
    else if (runStart < 0) runStart = i;
  }
  closeRun(LABEL_SAMPLES - 1);

  if (bestStart < 0) return cubicPoint(geometry, 0.5);
  return cubicPoint(geometry, (bestStart + bestEnd) / 2 / LABEL_SAMPLES);
}

export interface TweenPlan {
  durationMs: number;
  /** True when the transition was shortened because it sweeps across another card. */
  fast: boolean;
}

/** Largest per-point displacement between two shapes. */
export function geometryDistance(a: WireGeometry, b: WireGeometry): number {
  return Math.max(
    distance(a.from, b.from),
    distance(a.to, b.to),
    distance(a.c1, b.c1),
    distance(a.c2, b.c2),
  );
}

export function lerpGeometry(a: WireGeometry, b: WireGeometry, t: number): WireGeometry {
  return {
    from: lerpPoint(a.from, b.from, t),
    to: lerpPoint(a.to, b.to, t),
    c1: lerpPoint(a.c1, b.c1, t),
    c2: lerpPoint(a.c2, b.c2, t),
  };
}

const PLAN_SHAPES = 9;
const PLAN_SAMPLES = 12;

/**
 * How a layout jump should be animated.
 *
 * `obstacles` are the rectangles of every card that is *neither* endpoint: the two cards
 * the wire belongs to are supposed to be crossed (that is where the endpoints are).
 */
export function tweenPlan(
  previous: WireGeometry,
  next: WireGeometry,
  obstacles: Rect[],
): TweenPlan {
  if (geometryDistance(previous, next) < JUMP_THRESHOLD) {
    return { durationMs: 0, fast: false };
  }
  if (obstacles.length === 0) return { durationMs: TWEEN_MS, fast: false };

  for (let shape = 1; shape < PLAN_SHAPES; shape += 1) {
    const geometry = lerpGeometry(previous, next, shape / PLAN_SHAPES);
    for (let i = 0; i <= PLAN_SAMPLES; i += 1) {
      const point = cubicPoint(geometry, i / PLAN_SAMPLES);
      if (obstacles.some((rect) => rectContains(rect, point))) {
        return { durationMs: FAST_TWEEN_MS, fast: true };
      }
    }
  }
  return { durationMs: TWEEN_MS, fast: false };
}

/** Ease-out cubic: fast at the start, settles into the target. */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/** One animation frame of a transition; returns the shape to draw now. */
export function advanceTween(
  from: WireGeometry,
  to: WireGeometry,
  elapsedMs: number,
  durationMs: number,
): WireGeometry {
  if (durationMs <= 0) return to;
  const progress = easeOutCubic(elapsedMs / durationMs);
  return lerpGeometry(from, to, progress);
}

/**
 * `stroke-dasharray` in user units.
 *
 * The pattern is specified in screen px and divided by the zoom: the whole layer lives in
 * a `scale(zoom)` group, so a user-unit pattern would be three dashes long at 300% and
 * would merge into a solid line at 10% — which is the opposite of what the pattern is for.
 */
export function dashArray(direction: WireDirection, zoom: number): string {
  const [dash, gap] = direction === 'out' ? DASH_OUT : DASH_IN;
  return `${round(dash / zoom)} ${round(gap / zoom)}`;
}

/** Negative cycle length: a falling dash offset moves the dashes toward the path's end. */
export function dashCycle(direction: WireDirection, zoom: number): number {
  const [dash, gap] = direction === 'out' ? DASH_OUT : DASH_IN;
  return round(-(dash + gap) / zoom);
}

/** Seconds for one dash cycle at constant screen speed, so both directions flow alike. */
export function dashDuration(direction: WireDirection): number {
  const [dash, gap] = direction === 'out' ? DASH_OUT : DASH_IN;
  return (dash + gap) / FLOW_SPEED;
}

/* ── Detour around intermediate cards ────────────────────────────────── */

/**
 * How far outside a card the wire is routed (plane px).
 *
 * This is the whole separation between "the line crosses the card" and "the line goes
 * around it": the visibility graph works on rectangles inflated by this much, so every
 * leg of the detour keeps at least this distance from the real frame.
 */
export const ROUTE_PADDING = 20;

/** Corner rounding of the detour. Kept below the padding so the arc cannot cut in. */
export const ROUTE_RADIUS = 10;

/** Samples used to ask "does the single cubic enter a card at all?". */
const DETOUR_SAMPLES = 24;

/** Length of segment below which a grazing contact does not count as a crossing (px). */
const HIT_TOLERANCE = 0.5;

/** Grow a rectangle by `pad` on every side. */
export function inflateRect(rect: Rect, pad: number): Rect {
  return {
    left: rect.left - pad,
    top: rect.top - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/**
 * Does the straight segment `a -> b` pass through `rect`?
 *
 * Liang–Barsky clipping, then a length test: a path that merely touches a corner is not a
 * crossing, and treating it as one would make the router take absurd detours along edges
 * that were already clear.
 */
export function segmentHitsRect(a: Point, b: Point, rect: Rect, tolerance = HIT_TOLERANCE): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;

  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  if (!clip(-dx, a.x - rect.left)) return false;
  if (!clip(dx, rect.left + rect.width - a.x)) return false;
  if (!clip(-dy, a.y - rect.top)) return false;
  if (!clip(dy, rect.top + rect.height - a.y)) return false;
  if (t1 <= t0) return false;
  return (t1 - t0) * Math.hypot(dx, dy) > tolerance;
}

/** Polyline the wire follows, from the source centre to the target centre. */
export interface RouteGeometry {
  /** At least two points; `points[0]` is the source centre, the last one the target centre. */
  points: Point[];
  /** True when at least one waypoint was inserted to get around a card. */
  detoured: boolean;
}

/**
 * Route `from -> to` around `obstacles` (cards that are neither endpoint).
 *
 * Fast path: when the single cubic does not enter any card, nothing is inserted — the
 * drawing stays byte-identical to the pre-detour geometry. Only when it does enter a card
 * does a visibility graph run: nodes are the two endpoints plus the four corners of every
 * inflated rectangle, edges exist between any two nodes whose segment crosses no
 * rectangle, and Dijkstra picks the shortest route. Shortest-path around polygonal
 * obstacles bends only at obstacle corners, so this is exact for the shape we route.
 *
 * Returns `detoured: false` when no route exists (e.g. another card overlaps the source),
 * which degrades to the old "mask eats the crossing" behaviour instead of inventing one.
 */
export function routeGeometry(
  from: Point,
  to: Point,
  obstacles: Rect[],
  padding = ROUTE_PADDING,
): RouteGeometry {
  const straight: RouteGeometry = { points: [from, to], detoured: false };
  if (obstacles.length === 0) return straight;

  const blocked = obstacles
    .filter((rect) => {
      const inflated = inflateRect(rect, padding);
      const base = wireGeometry(from, to);
      for (let i = 0; i <= DETOUR_SAMPLES; i += 1) {
        if (rectContains(inflated, cubicPoint(base, i / DETOUR_SAMPLES))) return true;
      }
      return false;
    })
    .map((rect) => inflateRect(rect, padding));
  if (blocked.length === 0) return straight;

  // Refuse to route from/to a point that sits inside an obstacle: no visibility path can
  // start there, and a route that begins with a hidden hop is worse than the old line.
  if (blocked.some((rect) => rectContains(rect, from) || rectContains(rect, to))) return straight;

  const nodes: Point[] = [from, to];
  for (const rect of blocked) {
    nodes.push(
      { x: rect.left, y: rect.top },
      { x: rect.left + rect.width, y: rect.top },
      { x: rect.left, y: rect.top + rect.height },
      { x: rect.left + rect.width, y: rect.top + rect.height },
    );
  }

  // Corners sit *on* the inflated frame, so a leg that follows that frame would count as
  // a crossing and no route would ever exist. The visibility test therefore works on a
  // slightly shrunk rectangle: hugging the boundary is legal, cutting one pixel into it is
  // not. The drawn curve inherits the same margin (padding - 1).
  const solid = blocked.map((rect) => inflateRect(rect, -1));
  const clear = (a: Point, b: Point): boolean => !solid.some((rect) => segmentHitsRect(a, b, rect));
  const count = nodes.length;
  const dist = new Array<number>(count).fill(Number.POSITIVE_INFINITY);
  const previous = new Array<number>(count).fill(-1);
  const done = new Array<boolean>(count).fill(false);
  dist[0] = 0;

  for (;;) {
    let current = -1;
    for (let i = 0; i < count; i += 1) {
      if (!done[i] && (current < 0 || dist[i] < dist[current])) current = i;
    }
    if (current < 0 || dist[current] === Number.POSITIVE_INFINITY) break;
    if (current === 1) break;
    done[current] = true;
    for (let next = 0; next < count; next += 1) {
      if (done[next] || next === current) continue;
      if (!clear(nodes[current], nodes[next])) continue;
      const candidate = dist[current] + distance(nodes[current], nodes[next]);
      if (candidate < dist[next]) {
        dist[next] = candidate;
        previous[next] = current;
      }
    }
  }

  if (dist[1] === Number.POSITIVE_INFINITY) return straight;

  const path: Point[] = [];
  for (let at = 1; at >= 0; at = previous[at]) {
    path.push(nodes[at]);
    if (at === 0) break;
  }
  path.reverse();
  if (path.length <= 2) return straight;
  return { points: path, detoured: true };
}

/**
 * `d` for a route: the single cubic when nothing is in the way, otherwise a polyline whose
 * interior corners are rounded with quadratic arcs.
 *
 * A rounded polyline is tangent-continuous at every joint (the arc leaves the corner along
 * the incoming leg), and because the radius never exceeds the padding the arc stays inside
 * the corner square — it cannot cut back into the card it just avoided.
 */
export function routePathData(route: RouteGeometry, base: WireGeometry, radius = ROUTE_RADIUS): string {
  if (!route.detoured) return pathData(base);

  const { points } = route;
  const parts: string[] = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLength = distance(prev, corner);
    const outLength = distance(corner, next);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 0.5) {
      parts.push(`L ${round(corner.x)} ${round(corner.y)}`);
      continue;
    }
    const inDir = { x: (corner.x - prev.x) / inLength, y: (corner.y - prev.y) / inLength };
    const outDir = { x: (next.x - corner.x) / outLength, y: (next.y - corner.y) / outLength };
    parts.push(`L ${round(corner.x - inDir.x * r)} ${round(corner.y - inDir.y * r)}`);
    parts.push(`Q ${round(corner.x)} ${round(corner.y)} ${round(corner.x + outDir.x * r)} ${round(corner.y + outDir.y * r)}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${round(last.x)} ${round(last.y)}`);
  return parts.join(' ');
}

/**
 * Arrowhead for a route.
 *
 * The final leg always approaches the target centre in a straight line (rounding happens
 * at interior corners), so the frame crossing is found by bisecting that last leg — the
 * same contract as `arrowTip`: never park the arrow inside the card.
 */
export function routeArrowTip(
  route: RouteGeometry,
  base: WireGeometry,
  rect: Rect,
): ArrowPlacement | null {
  if (!route.detoured) return arrowTip(base, rect);

  const points = route.points;
  let inside = points[points.length - 1];
  if (!rectContains(rect, inside)) return null;

  for (let i = points.length - 2; i >= 0; i -= 1) {
    const outside = points[i];
    if (rectContains(rect, outside)) {
      inside = outside;
      continue;
    }
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < EXIT_BISECTIONS; k += 1) {
      const mid = (lo + hi) / 2;
      const point = { x: outside.x + (inside.x - outside.x) * mid, y: outside.y + (inside.y - outside.y) * mid };
      if (rectContains(rect, point)) hi = mid;
      else lo = mid;
    }
    const tip = { x: outside.x + (inside.x - outside.x) * lo, y: outside.y + (inside.y - outside.y) * lo };
    const inward = { x: inside.x - tip.x, y: inside.y - tip.y };
    const length = Math.hypot(inward.x, inward.y);
    if (length < 1e-9) return null;
    return { tip, dir: { x: inward.x / length, y: inward.y / length } };
  }
  return null;
}

/** Where the label goes on a route: middle of the longest stretch outside every card. */
export function routeLabelPoint(route: RouteGeometry, base: WireGeometry, rects: Rect[]): Point {
  if (!route.detoured || rects.length === 0) {
    return route.detoured ? midpointOfPolyline(route.points) : visibleLabelPoint(base, rects);
  }

  const samples = 96;
  const points: Point[] = [];
  let total = 0;
  for (let i = 0; i < route.points.length - 1; i += 1) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const length = distance(a, b);
    const steps = Math.max(1, Math.round((length / Math.max(1, polylineLength(route.points))) * samples));
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      total += length / steps;
    }
  }
  points.push(route.points[route.points.length - 1]);

  let best: { start: number; end: number } | null = null;
  let runStart = -1;
  for (let i = 0; i < points.length; i += 1) {
    const covered = rects.some((rect) => rectContains(rect, points[i]));
    if (covered) {
      if (runStart >= 0) {
        if (!best || i - 1 - runStart > best.end - best.start) best = { start: runStart, end: i - 1 };
        runStart = -1;
      }
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  if (runStart >= 0 && (!best || points.length - 1 - runStart > best.end - best.start)) {
    best = { start: runStart, end: points.length - 1 };
  }
  if (!best) return midpointOfPolyline(route.points);
  const mid = Math.round((best.start + best.end) / 2);
  return points[Math.max(0, Math.min(points.length - 1, mid))];
}

function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i += 1) total += distance(points[i], points[i + 1]);
  return total;
}

function midpointOfPolyline(points: Point[]): Point {
  const half = polylineLength(points) / 2;
  let travelled = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const leg = distance(points[i], points[i + 1]);
    if (travelled + leg >= half) {
      const t = leg === 0 ? 0 : (half - travelled) / leg;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    travelled += leg;
  }
  return points[points.length - 1];
}
