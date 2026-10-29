/**
 * Connection geometry — the pure half of the connection layer.
 *
 * Since 2026-10-29 a wire runs from one card **centre** to the other, is a single cubic
 * Bézier, and is animated when the layout *jumps*. These tests pin the three things that
 * can silently regress:
 *
 *   - the blend between the horizontal and vertical control-point solutions (a
 *     discontinuity here is the "wire snaps when you drag across the diagonal" bug),
 *   - the arrow having to park on the target card's frame, because the mask erases
 *     everything inside it,
 *   - the transition shortening when it would sweep across a third card.
 */
import { describe, expect, it } from 'vitest';

import {
  DASH_IN,
  DASH_OUT,
  FAST_TWEEN_MS,
  TWEEN_MS,
  advanceTween,
  arrowPathAt,
  arrowTip,
  cubicPoint,
  dashArray,
  dashCycle,
  dashDuration,
  geometryDistance,
  pathData,
  rectContains,
  routeArrowTip,
  routeGeometry,
  routeLabelPoint,
  routePathData,
  tweenPlan,
  visibleLabelPoint,
  wireGeometry,
} from '../src/ui/connectionGeometry.ts';
import type { Rect } from '../src/ui/cardMetrics.ts';

describe('wire geometry', () => {
  it('draws a horizontally aligned pair as a straight line through both centres', () => {
    const geometry = wireGeometry({ x: 100, y: 100 }, { x: 500, y: 100 });
    // Both control points land on the chord, so the "curve" is a straight line.
    expect(geometry.c1).toEqual({ x: 300, y: 100 });
    expect(geometry.c2).toEqual({ x: 300, y: 100 });
    expect(pathData(geometry)).toBe('M 100 100 C 300 100, 300 100, 500 100');
  });

  it('draws a vertically aligned pair the same way, rotated', () => {
    const geometry = wireGeometry({ x: 100, y: 100 }, { x: 100, y: 500 });
    expect(pathData(geometry)).toBe('M 100 100 C 100 300, 100 300, 100 500');
  });

  it('blends the two solutions by the horizontal share of the offset', () => {
    // dx = 200, dy = 100 -> w = 2/3: the vertical solution shrunk toward the horizontal one.
    const geometry = wireGeometry({ x: 0, y: 0 }, { x: 200, y: 100 });
    expect(geometry.c1.x).toBeCloseTo(66.667, 3);
    expect(geometry.c1.y).toBeCloseTo(16.667, 3);
    expect(geometry.c2.x).toBeCloseTo(133.333, 3);
    expect(geometry.c2.y).toBeCloseTo(83.333, 3);
    // A diagonal pair is exactly on the chord (w = 1/2 blends to the midpoint).
    const diagonal = wireGeometry({ x: 0, y: 0 }, { x: 100, y: 100 });
    expect(diagonal.c1).toEqual({ x: 25, y: 25 });
    expect(diagonal.c2).toEqual({ x: 75, y: 75 });
  });

  it('moves continuously across the diagonal (no snap when a drag crosses the switch)', () => {
    const below = wireGeometry({ x: 0, y: 0 }, { x: 100, y: 100.5 });
    const above = wireGeometry({ x: 0, y: 0 }, { x: 100, y: 99.5 });
    // A discontinuity (committing to one solution instead of blending) would jump the
    // control point by ~70px here — from (50,0) to (0,50). Blending moves it by 0.39.
    const jump = Math.hypot(below.c1.x - above.c1.x, below.c1.y - above.c1.y);
    expect(jump).toBeGreaterThan(0);
    expect(jump).toBeLessThan(0.6);
  });

  it('survives two coincident centres without producing NaN', () => {
    const geometry = wireGeometry({ x: 50, y: 50 }, { x: 50, y: 50 });
    for (const point of [geometry.from, geometry.to, geometry.c1, geometry.c2]) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    expect(pathData(geometry)).toBe('M 50 50 C 50 50, 50 50, 50 50');
  });

  it('starts and ends exactly on the two centres', () => {
    const geometry = wireGeometry({ x: 420, y: 290 }, { x: 1052, y: 304 });
    expect(cubicPoint(geometry, 0)).toEqual(geometry.from);
    expect(cubicPoint(geometry, 1)).toEqual(geometry.to);
  });
});

describe('arrow placement', () => {
  const target: Rect = { left: 400, top: 50, width: 200, height: 100 };

  it('parks the tip just outside the target frame, pointing along the curve', () => {
    const geometry = wireGeometry({ x: 100, y: 100 }, { x: 500, y: 100 });
    const placement = arrowTip(geometry, target);
    expect(placement).not.toBeNull();
    // Inside the rect would be erased by the mask; the crossing is at x = 400.
    expect(placement!.tip.x).toBeLessThan(400);
    expect(placement!.tip.x).toBeGreaterThan(399.9);
    expect(placement!.tip.y).toBeCloseTo(100, 6);
    expect(placement!.dir.x).toBeCloseTo(1, 6);
    expect(placement!.dir.y).toBeCloseTo(0, 6);
    expect(rectContains(target, placement!.tip)).toBe(false);
  });

  it('gives up when the whole curve is inside the target card', () => {
    const geometry = wireGeometry({ x: 490, y: 100 }, { x: 500, y: 100 });
    expect(arrowTip(geometry, target)).toBeNull();
  });

  it('builds the triangle behind the tip so it stays visible', () => {
    const d = arrowPathAt({ x: 100, y: 50 }, { x: 1, y: 0 }, 1);
    expect(d).toBe('M 100 50 L 92 54 L 92 46 Z');
    // The size is divided by the zoom so the arrow keeps its on-screen size.
    expect(arrowPathAt({ x: 100, y: 50 }, { x: 1, y: 0 }, 2)).toBe(
      'M 100 50 L 96 52 L 96 48 Z',
    );
  });
});

describe('label placement', () => {
  it('uses the middle of the longest stretch that no card covers', () => {
    const geometry = wireGeometry({ x: 100, y: 100 }, { x: 500, y: 100 });
    // The two end cards cover the wire only as far as their own frames, so the visible
    // stretches are x in (200,250) and (350,400) once a third card sits in the middle.
    const left: Rect = { left: 0, top: 50, width: 200, height: 100 };
    const right: Rect = { left: 400, top: 50, width: 200, height: 100 };
    const third: Rect = { left: 250, top: 20, width: 100, height: 160 };
    const point = visibleLabelPoint(geometry, [left, right, third]);
    // Two 50px gaps remain; the label must sit in one of them, never on a card face.
    expect(rectContains(third, point)).toBe(false);
    expect(point.x > 200 && point.x < 250).toBe(true);
  });

  it('falls back to the midpoint when every card covers the wire', () => {
    const geometry = wireGeometry({ x: 100, y: 100 }, { x: 500, y: 100 });
    const everything: Rect = { left: 0, top: 0, width: 1000, height: 1000 };
    expect(visibleLabelPoint(geometry, [everything])).toEqual({ x: 300, y: 100 });
  });
});

describe('layout-jump transitions', () => {
  const start = wireGeometry({ x: 100, y: 100 }, { x: 500, y: 100 });

  it('follows a small move exactly (a drag is not an animation)', () => {
    const nudged = wireGeometry({ x: 105, y: 100 }, { x: 500, y: 100 });
    expect(tweenPlan(start, nudged, [])).toEqual({ durationMs: 0, fast: false });
  });

  it('animates a jump when no third card is in the way', () => {
    const moved = wireGeometry({ x: 100, y: 400 }, { x: 500, y: 400 });
    expect(tweenPlan(start, moved, [])).toEqual({ durationMs: TWEEN_MS, fast: false });
  });

  it('shortens the transition when it sweeps across a third card', () => {
    const moved = wireGeometry({ x: 100, y: 400 }, { x: 500, y: 400 });
    const between: Rect = { left: 100, top: 200, width: 200, height: 100 };
    expect(tweenPlan(start, moved, [between])).toEqual({
      durationMs: FAST_TWEEN_MS,
      fast: true,
    });
  });

  it('eases from the old shape to the new one and lands exactly', () => {
    const moved = wireGeometry({ x: 100, y: 400 }, { x: 500, y: 400 });
    expect(advanceTween(start, moved, 0, TWEEN_MS)).toEqual(start);
    expect(advanceTween(start, moved, TWEEN_MS + 50, TWEEN_MS)).toEqual(moved);
    const middle = advanceTween(start, moved, TWEEN_MS / 2, TWEEN_MS);
    expect(geometryDistance(start, middle)).toBeGreaterThan(0);
    expect(geometryDistance(start, middle)).toBeLessThan(geometryDistance(start, moved));
  });
});

describe('dash patterns', () => {
  it('divides the screen-px pattern by the zoom (user units in a scaled group)', () => {
    expect(dashArray('out', 1)).toBe(`${DASH_OUT[0]} ${DASH_OUT[1]}`);
    expect(dashArray('out', 2)).toBe(`${DASH_OUT[0] / 2} ${DASH_OUT[1] / 2}`);
    expect(dashArray('in', 2)).toBe(`${DASH_IN[0] / 2} ${DASH_IN[1] / 2}`);
    // Red draws long, blue draws short: the pattern survives a colour-blind reading.
    expect(DASH_OUT[0]).toBeGreaterThan(DASH_IN[0]);
  });

  it('flows toward the target by cycling a negative offset', () => {
    expect(dashCycle('out', 1)).toBe(-(DASH_OUT[0] + DASH_OUT[1]));
    expect(dashCycle('out', 2)).toBe(-(DASH_OUT[0] + DASH_OUT[1]) / 2);
  });

  it('moves both directions at the same screen speed', () => {
    const outSpeed = (DASH_OUT[0] + DASH_OUT[1]) / dashDuration('out');
    const inSpeed = (DASH_IN[0] + DASH_IN[1]) / dashDuration('in');
    expect(outSpeed).toBeCloseTo(inSpeed, 6);
  });
});

describe('detour around intermediate cards (2026-10-29)', () => {
  /** A table at the top, a chart at the bottom, one card sitting exactly between them. */
  const source: Rect = { left: 0, top: 0, width: 400, height: 300 };
  const between: Rect = { left: 0, top: 300, width: 400, height: 300 };
  const target: Rect = { left: 0, top: 600, width: 400, height: 300 };

  const from = { x: 200, y: 150 };
  const to = { x: 200, y: 750 };

  /** Sample an `M/L/Q/C` path so a test can ask what the *drawn* curve actually does. */
  function samplePath(d: string, steps = 24): { x: number; y: number }[] {
    const tokens = d.replace(/[MLQC]/g, ' $& ').trim().split(/\s+/);
    const points: { x: number; y: number }[] = [];
    let cursor = { x: 0, y: 0 };
    let i = 0;
    const num = () => Number(tokens[i++]);
    const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t: number) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
    while (i < tokens.length) {
      const cmd = tokens[i++];
      if (cmd === 'M') {
        cursor = { x: num(), y: num() };
        points.push(cursor);
      } else if (cmd === 'L') {
        const next = { x: num(), y: num() };
        for (let s = 1; s <= steps; s += 1) points.push(lerp(cursor, next, s / steps));
        cursor = next;
      } else if (cmd === 'Q') {
        const control = { x: num(), y: num() };
        const next = { x: num(), y: num() };
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          const u = 1 - t;
          points.push({
            x: u * u * cursor.x + 2 * u * t * control.x + t * t * next.x,
            y: u * u * cursor.y + 2 * u * t * control.y + t * t * next.y,
          });
        }
        cursor = next;
      } else if (cmd === 'C') {
        const c1 = { x: num(), y: num() };
        const c2 = { x: num(), y: num() };
        const next = { x: num(), y: num() };
        for (let s = 1; s <= steps; s += 1) {
          const t = s / steps;
          const u = 1 - t;
          points.push({
            x: u * u * u * cursor.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * next.x,
            y: u * u * u * cursor.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * next.y,
          });
        }
        cursor = next;
      } else {
        throw new Error(`unexpected path command ${cmd}`);
      }
    }
    return points;
  }

  const inside = (route: ReturnType<typeof routeGeometry>): { x: number; y: number }[] => {
    const drawn = samplePath(routePathData(route));
    // Ignore the stretched ends: they are inside the two endpoint cards on purpose.
    return drawn.slice(Math.floor(drawn.length * 0.2), Math.ceil(drawn.length * 0.8));
  };

  it('leaves a clear wire exactly as it was (single cubic, no detour)', () => {
    const away: Rect = { left: 5000, top: 5000, width: 100, height: 100 };
    const route = routeGeometry(from, to, [away]);
    expect(route.detoured).toBe(false);
    expect(route.segments).toHaveLength(1);
    expect(routePathData(route)).toBe(pathData(wireGeometry(from, to)));
  });

  it('routes around a card, and smooths the corners into a bezier chain', () => {
    const route = routeGeometry(from, to, [between]);
    expect(route.detoured).toBe(true);
    // Two bends is the product ceiling: waypoints are the endpoints plus at most two.
    expect(route.points.length).toBeGreaterThan(2);
    expect(route.points.length).toBeLessThanOrEqual(4);
    expect(route.segments.length).toBe(route.points.length - 1);
    // A polyline would emit L/Q; the requested shape is all cubics.
    expect(routePathData(route)).not.toContain(' L ');
    expect(routePathData(route)).not.toContain(' Q ');
    expect((routePathData(route).match(/C/g) ?? []).length).toBe(route.segments.length);
  });

  it('joins the segments tangentially (no visible kink at a bend)', () => {
    const route = routeGeometry(from, to, [between]);
    for (let i = 1; i < route.segments.length; i += 1) {
      const prev = route.segments[i - 1];
      const next = route.segments[i];
      const inDir = { x: prev.to.x - prev.c2.x, y: prev.to.y - prev.c2.y };
      const outDir = { x: next.c1.x - next.from.x, y: next.c1.y - next.from.y };
      const inLength = Math.hypot(inDir.x, inDir.y);
      const outLength = Math.hypot(outDir.x, outDir.y);
      expect(Math.abs(inDir.x / inLength - outDir.x / outLength)).toBeLessThan(1e-9);
      expect(Math.abs(inDir.y / inLength - outDir.y / outLength)).toBeLessThan(1e-9);
    }
  });

  it('keeps the drawn curve outside the card it went around', () => {
    const route = routeGeometry(from, to, [between]);
    for (const point of inside(route)) {
      expect(rectContains(between, point)).toBe(false);
    }
  });

  it('goes around two stacked cards without squeezing between them', () => {
    const upper: Rect = { left: 0, top: 250, width: 400, height: 200 };
    const lower: Rect = { left: 0, top: 480, width: 400, height: 200 };
    const route = routeGeometry(from, to, [upper, lower]);
    expect(route.detoured).toBe(true);
    for (const point of inside(route)) {
      expect(rectContains(upper, point)).toBe(false);
      expect(rectContains(lower, point)).toBe(false);
    }
  });

  it('gives up (old behaviour) when an endpoint is buried inside another card', () => {
    const buried: Rect = { left: 100, top: 50, width: 200, height: 200 };
    const route = routeGeometry(from, to, [buried]);
    expect(route.detoured).toBe(false);
  });

  it('parks the arrow on the target frame, not on the detour', () => {
    const route = routeGeometry(from, to, [between]);
    const arrow = routeArrowTip(route, target);
    expect(arrow).not.toBeNull();
    expect(rectContains(target, arrow!.tip)).toBe(false);
    const inward = { x: arrow!.tip.x + arrow!.dir.x, y: arrow!.tip.y + arrow!.dir.y };
    expect(rectContains(target, inward)).toBe(true);
  });

  it('keeps the label off every card on a detoured route', () => {
    const route = routeGeometry(from, to, [between]);
    const point = routeLabelPoint(route, [source, between, target]);
    expect(rectContains(between, point)).toBe(false);
    expect(rectContains(source, point)).toBe(false);
    expect(rectContains(target, point)).toBe(false);
  });
});
