import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildValueAxis, niceStep, stepDecimals } from '@palsentry/shared';

/**
 * Tests for the history-chart axis maths in `@palsentry/shared`.
 *
 * Like the map tests, these live in the server workspace because it is the one with a test runner
 * wired up, but they cover code the browser uses. The axis is what lets an operator read a value
 * off a chart, so a gridline that lands on 16.8375 or a count axis that steps by half a player is
 * a real bug, not a cosmetic one.
 */

/** Axis labels as a plain array, for readable assertions. */
function labels(
  values: readonly number[],
  options?: Parameters<typeof buildValueAxis>[1],
): string[] {
  return buildValueAxis(values, options)?.ticks.map((tick) => tick.label) ?? [];
}

describe('niceStep', () => {
  it('rounds up to the next readable interval', () => {
    assert.equal(niceStep(0.845), 1);
    assert.equal(niceStep(1.2), 2);
    assert.equal(niceStep(2.4), 2.5);
    assert.equal(niceStep(3.3), 5);
    assert.equal(niceStep(9.3), 10);
    assert.equal(niceStep(11.5), 20);
  });

  it('scales with the magnitude of the range', () => {
    assert.equal(niceStep(0.032), 0.05);
    assert.equal(niceStep(320), 500);
    assert.equal(niceStep(1_400), 2_000);
  });

  it('never returns a non-positive or non-finite interval', () => {
    assert.equal(niceStep(0), 1);
    assert.equal(niceStep(-5), 1);
    assert.equal(niceStep(Number.NaN), 1);
    assert.equal(niceStep(Number.POSITIVE_INFINITY), 1);
  });

  it('avoids half units on a whole-only axis', () => {
    assert.equal(niceStep(0.3, true), 1);
    assert.equal(niceStep(2.4, true), 5);
    assert.equal(niceStep(13.8, true), 20);
  });
});

describe('stepDecimals', () => {
  it('reports exactly the decimals a step needs', () => {
    assert.equal(stepDecimals(1), 0);
    assert.equal(stepDecimals(2.5), 1);
    assert.equal(stepDecimals(0.5), 1);
    assert.equal(stepDecimals(0.25), 2);
    assert.equal(stepDecimals(10), 0);
    assert.equal(stepDecimals(100), 0);
  });
});

describe('buildValueAxis', () => {
  it('returns nothing for an empty series', () => {
    assert.equal(buildValueAxis([]), null);
  });

  it('keeps a count axis on whole numbers', () => {
    // An averaged player count can land on 3.5; the gridlines still should not.
    const axis = buildValueAxis([0, 3.5, 8], { decimals: 0 });

    assert.equal(axis?.min, 0);
    assert.equal(axis?.step, 2);
    assert.deepEqual(labels([0, 3.5, 8], { decimals: 0 }), ['0', '2', '4', '6', '8', '10']);
  });

  it('uses one decimal for a duration axis', () => {
    const axis = buildValueAxis([16.8, 17.1, 17.9], { decimals: 1 });

    assert.equal(axis?.decimals, 1);
    assert.deepEqual(labels([16.8, 17.1, 17.9], { decimals: 1 }), ['16.5', '17.0', '17.5', '18.0']);
  });

  it('infers whole numbers when every sample is an integer', () => {
    assert.deepEqual(labels([56, 58, 60]), ['55', '56', '57', '58', '59', '60', '61']);
  });

  it('snaps the domain outwards so data never touches the frame', () => {
    const axis = buildValueAxis([21, 60], { decimals: 0 });

    assert.ok(axis !== null);
    assert.ok(axis.min <= 21);
    assert.ok(axis.max > 60, 'the highest sample should sit below the top gridline');
    assert.equal((axis.max - axis.min) % axis.step, 0);
  });

  it('never draws a gridline below zero for non-negative data', () => {
    const axis = buildValueAxis([0, 0, 0], { decimals: 0 });

    assert.equal(axis?.min, 0);
    assert.deepEqual(labels([0, 0, 0], { decimals: 0 }), ['0', '1']);
  });

  it('gives a flat series a band around its value', () => {
    const axis = buildValueAxis([60, 60, 60], { decimals: 0 });

    assert.ok(axis !== null);
    assert.ok(axis.min < 60 && axis.max > 60, 'a flat line must not sit on a gridline');
  });

  it('scales a single sample', () => {
    const axis = buildValueAxis([16.9], { decimals: 1 });

    assert.ok(axis !== null);
    assert.equal(axis.ticks.length >= 3, true);
    assert.ok(axis.min < 16.9 && axis.max > 16.9);
  });

  it('produces ticks that are exactly one step apart', () => {
    const axis = buildValueAxis([14, 37, 52, 47.8], { decimals: 1 });

    assert.ok(axis !== null);
    for (let index = 1; index < axis.ticks.length; index += 1) {
      const gap = (axis.ticks[index]?.value ?? 0) - (axis.ticks[index - 1]?.value ?? 0);
      assert.ok(Math.abs(gap - axis.step) < 1e-9, `tick ${index} is ${gap} from its neighbour`);
    }
  });

  it('keeps the tick count close to the target', () => {
    for (const values of [
      [0, 1],
      [0, 11],
      [12, 640],
      [0.4, 0.9],
      [1_000, 9_870],
    ]) {
      const axis = buildValueAxis(values, { decimals: 0 });
      assert.ok(axis !== null);
      assert.ok(axis.ticks.length >= 2, `${values.join(',')} produced too few gridlines`);
      assert.ok(axis.ticks.length <= 9, `${values.join(',')} produced too many gridlines`);
    }
  });

  it('reports decimals consistent with every label', () => {
    const axis = buildValueAxis([16.8, 17.9], { decimals: 1 });

    assert.ok(axis !== null);
    for (const tick of axis.ticks) {
      assert.equal(
        tick.label,
        tick.value.toFixed(axis.decimals),
        `${tick.label} is not what the axis precision implies`,
      );
    }
  });
});
