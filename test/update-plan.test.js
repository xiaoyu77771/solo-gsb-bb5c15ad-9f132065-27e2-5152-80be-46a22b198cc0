'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planUpdate } = require('../src/resolver');

test('keeps locked versions when they satisfy every constraint', () => {
  const result = planUpdate({
    registry: {
      app: {
        '2.0.0': { dependencies: { lib: '^2.0.0' } },
        '1.0.0': { dependencies: { lib: '^1.0.0' } },
      },
      lib: {
        '2.0.0': {},
        '1.5.0': {},
      },
    },
    root: { app: '>=1.0.0' },
    locked: { app: '1.0.0', lib: '1.5.0' },
    update: {},
  });

  assert.deepEqual(result, {
    satisfiable: true,
    plan: [
      { package: 'app', version: '1.0.0' },
      { package: 'lib', version: '1.5.0' },
    ],
    kept: [
      { package: 'app', version: '1.0.0' },
      { package: 'lib', version: '1.5.0' },
    ],
    changed: [],
  });
});

test('applies update constraints with the smallest possible change', () => {
  const result = planUpdate({
    registry: {
      app: { '1.0.0': {} },
      lib: { '2.0.0': {}, '1.5.0': {} },
    },
    root: { app: '^1.0.0', lib: '>=1.0.0' },
    locked: { app: '1.0.0', lib: '1.5.0' },
    update: { lib: '^2.0.0' },
  });

  assert.deepEqual(result, {
    satisfiable: true,
    plan: [
      { package: 'app', version: '1.0.0' },
      { package: 'lib', version: '2.0.0' },
    ],
    kept: [{ package: 'app', version: '1.0.0' }],
    changed: [{ package: 'lib', from: '1.5.0', to: '2.0.0' }],
  });
});

test('cascades an update constraint through dependent packages', () => {
  const result = planUpdate({
    registry: {
      app: {
        '2.0.0': { dependencies: { lib: '^2.0.0' } },
        '1.0.0': { dependencies: { lib: '^1.0.0' } },
      },
      lib: { '2.0.0': {}, '1.5.0': {} },
    },
    root: { app: '>=1.0.0' },
    locked: { app: '1.0.0', lib: '1.5.0' },
    update: { lib: '^2.0.0' },
  });

  assert.deepEqual(result.plan, [
    { package: 'app', version: '2.0.0' },
    { package: 'lib', version: '2.0.0' },
  ]);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.changed, [
    { package: 'app', from: '1.0.0', to: '2.0.0' },
    { package: 'lib', from: '1.5.0', to: '2.0.0' },
  ]);
});

test('counts additions and removals as changes', () => {
  const result = planUpdate({
    registry: {
      app: {
        '2.0.0': { dependencies: { util: '^1.0.0' } },
        '1.0.0': { dependencies: { lib: '^1.0.0' } },
      },
      lib: { '1.0.0': {} },
      util: { '1.0.0': {} },
    },
    root: { app: '>=1.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0', extra: '9.9.9' },
    update: {},
  });

  // Keeping app@1.0.0 costs one change (removing extra); switching to
  // app@2.0.0 would also replace lib with util.
  assert.deepEqual(result.plan, [
    { package: 'app', version: '1.0.0' },
    { package: 'lib', version: '1.0.0' },
  ]);
  assert.deepEqual(result.kept, [
    { package: 'app', version: '1.0.0' },
    { package: 'lib', version: '1.0.0' },
  ]);
  assert.deepEqual(result.changed, [
    { package: 'extra', from: '9.9.9', to: null },
  ]);
});

test('prefers higher versions when change counts tie', () => {
  const result = planUpdate({
    registry: {
      lib: { '1.5.0': {}, '1.4.0': {} },
    },
    root: { lib: '^1.2.0' },
    locked: { lib: '1.0.0' },
    update: {},
  });

  assert.deepEqual(result.plan, [{ package: 'lib', version: '1.5.0' }]);
  assert.deepEqual(result.kept, []);
  assert.deepEqual(result.changed, [
    { package: 'lib', from: '1.0.0', to: '1.5.0' },
  ]);
});

test('breaks ties package by package in lexicographic order', () => {
  const result = planUpdate({
    registry: {
      aaa: {
        '2.0.0': { dependencies: { shared: '^2.0.0' } },
        '1.0.0': { dependencies: { shared: '^1.0.0' } },
      },
      bbb: {
        '2.0.0': { dependencies: { shared: '^1.0.0' } },
        '1.0.0': { dependencies: { shared: '^2.0.0' } },
      },
      shared: { '2.0.0': {}, '1.0.0': {} },
    },
    root: { aaa: '>=1.0.0', bbb: '>=1.0.0' },
    locked: {},
    update: {},
  });

  // Both feasible plans contain three new packages; the one with the higher
  // aaa version wins even though the alternative has a higher bbb version.
  assert.deepEqual(result.plan, [
    { package: 'aaa', version: '2.0.0' },
    { package: 'bbb', version: '1.0.0' },
    { package: 'shared', version: '2.0.0' },
  ]);
});

test('reports update constraints in the conflict chain', () => {
  const result = planUpdate({
    registry: { lib: { '1.0.0': {} } },
    root: {},
    locked: { lib: '1.0.0' },
    update: { lib: '^2.0.0' },
  });

  assert.equal(result.satisfiable, false);
  assert.equal(result.conflict.package, 'lib');
  const target = result.conflict.chain[result.conflict.chain.length - 1];
  assert.equal(target.reasonCode, 'NO_VERSION_SATISFIES_CONSTRAINTS');
  assert.deepEqual(target.requiredBy, { type: 'update' });
  assert.deepEqual(target.availableVersions, ['1.0.0']);
  assert.deepEqual(target.compatibleVersions, []);
});

test('reports update packages absent from the registry', () => {
  const result = planUpdate({
    registry: {},
    root: {},
    locked: {},
    update: { ghost: '^1.0.0' },
  });

  assert.equal(result.satisfiable, false);
  assert.equal(result.conflict.package, 'ghost');
  const target = result.conflict.chain[result.conflict.chain.length - 1];
  assert.equal(target.reasonCode, 'PACKAGE_NOT_IN_REGISTRY');
});

test('rejects invalid locked versions and update ranges', () => {
  assert.throws(
    () => planUpdate({ registry: {}, root: {}, locked: { app: '1.0' }, update: {} }),
    /valid semver version/
  );
  assert.throws(
    () => planUpdate({ registry: {}, root: {}, update: {} }),
    /locked must be an object/
  );
  assert.throws(
    () => planUpdate({ registry: {}, root: {}, locked: {}, update: { lib: 'latest' } }),
    /valid semver range/
  );
  assert.throws(
    () => planUpdate({ registry: {}, root: {}, locked: {} }),
    /update must be an object/
  );
});

test('does not depend on locked, update, or registry key order', () => {
  const body = {
    registry: {
      zeta: { '2.0.0': {}, '1.0.0': {} },
      alpha: { '1.0.0': {} },
    },
    root: { zeta: '>=1.0.0', alpha: '1.0.0' },
    locked: { zeta: '1.0.0', alpha: '1.0.0' },
    update: { zeta: '^1.0.0' },
  };

  const reordered = {
    update: { zeta: '^1.0.0' },
    locked: { alpha: '1.0.0', zeta: '1.0.0' },
    root: { alpha: '1.0.0', zeta: '>=1.0.0' },
    registry: {
      alpha: { '1.0.0': {} },
      zeta: { '1.0.0': {}, '2.0.0': {} },
    },
  };

  const result = planUpdate(body);
  assert.deepEqual(planUpdate(reordered), result);
  assert.deepEqual(result.plan, [
    { package: 'alpha', version: '1.0.0' },
    { package: 'zeta', version: '1.0.0' },
  ]);
});
