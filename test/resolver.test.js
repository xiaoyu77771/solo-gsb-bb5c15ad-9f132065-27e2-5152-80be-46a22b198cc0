'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolve } = require('../src/resolver');

function chainTarget(result) {
  return result.conflict.chain[result.conflict.chain.length - 1];
}

test('resolves transitive dependencies in package-name and descending version order', () => {
  const result = resolve({
    registry: {
      zeta: {
        '2.0.0': { dependencies: { shared: '^2.0.0' } },
        '1.5.0': { dependencies: { shared: '~1.0.0' } },
      },
      shared: {
        '2.0.0': {},
        '1.0.0': {},
      },
      alpha: {
        '3.0.0': { dependencies: { shared: '^2.0.0' } },
        '2.9.0': {},
      },    },
    root: {
      zeta: '^1.0.0',
      alpha: '>=2.0.0',
    },
  });

  assert.deepEqual(result, {
    satisfiable: true,
    plan: [
      { package: 'alpha', version: '2.9.0' },
      { package: 'shared', version: '1.0.0' },
      { package: 'zeta', version: '1.5.0' },
    ],
  });
});

test('backtracks when a higher transitive choice blocks a later package', () => {
  const result = resolve({
    registry: {
      app: {
        '1.0.0': { dependencies: { lib: '^1.0.0', plugin: '^1.0.0' } },
      },
      lib: {
        '1.2.0': { dependencies: { util: '^2.0.0' } },
        '1.1.0': { dependencies: { util: '^1.0.0' } },
      },
      plugin: {
        '1.0.0': { dependencies: { util: '~1.0.0' } },
      },
      util: {
        '2.0.0': {},
        '1.0.0': {},
      },
    },
    root: { app: '1.0.0' },
  });

  assert.deepEqual(result.plan, [
    { package: 'app', version: '1.0.0' },
    { package: 'lib', version: '1.1.0' },
    { package: 'plugin', version: '1.0.0' },
    { package: 'util', version: '1.0.0' },
  ]);
});

test('returns a deterministic root-to-first-blocked-package conflict chain', () => {
  const result = resolve({
    registry: {
      app: {
        '1.0.0': { dependencies: { lib: '^1.0.0', util: '~1.2.0' } },
      },
      lib: {
        '1.0.0': { dependencies: { util: '^2.0.0' } },
      },
      util: {
        '2.0.0': {},
        '1.2.0': {},
      },
    },
    root: { app: '1.0.0' },
  });

  assert.equal(result.satisfiable, false);
  assert.equal(result.conflict.package, 'util');
  assert.deepEqual(result.conflict.chain, [
    {
      package: 'app',
      selectedVersion: '1.0.0',
      requiredRange: '1.0.0',
      requiredBy: { type: 'root' },
    },
    {
      package: 'lib',
      selectedVersion: '1.0.0',
      requiredRange: '^1.0.0',
      requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
    },
    {
      package: 'util',
      requiredRange: '^2.0.0',
      requiredBy: { type: 'dependency', package: 'lib', version: '1.0.0' },
      constraints: [
        {
          requiredRange: '^2.0.0',
          requiredBy: { type: 'dependency', package: 'lib', version: '1.0.0' },
        },
        {
          requiredRange: '~1.2.0',
          requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
        },
      ],
      availableVersions: ['2.0.0', '1.2.0'],
      compatibleVersions: [],
      reasonCode: 'NO_VERSION_SATISFIES_CONSTRAINTS',
    },
  ]);
  assert.equal(chainTarget(result).package, 'util');
});

test('reports packages absent from the offline registry', () => {
  const result = resolve({
    registry: { app: { '1.0.0': { dependencies: { missing: '*' } } } },
    root: { app: '1.0.0' },
  });

  assert.equal(result.satisfiable, false);
  assert.equal(result.conflict.package, 'missing');
  assert.equal(chainTarget(result).reasonCode, 'PACKAGE_NOT_IN_REGISTRY');
  assert.deepEqual(chainTarget(result).availableVersions, []);
});

test('handles dependency cycles', () => {
  const result = resolve({
    registry: {
      a: { '1.0.0': { dependencies: { b: '1.0.0' } } },
      b: { '1.0.0': { dependencies: { a: '1.0.0' } } },
    },
    root: { a: '1.0.0' },
  });

  assert.deepEqual(result.plan, [
    { package: 'a', version: '1.0.0' },
    { package: 'b', version: '1.0.0' },
  ]);
});

test('does not depend on registry or root key order', () => {
  const body = {
    registry: {
      zeta: { '1.0.0': { dependencies: { alpha: '1.0.0' } } },
      alpha: { '1.0.0': {} },
    },
    root: { zeta: '1.0.0', alpha: '1.0.0' },
  };

  const reversed = {
    registry: {
      alpha: { '1.0.0': {} },
      zeta: { '1.0.0': { dependencies: { alpha: '1.0.0' } } },
    },
    root: { alpha: '1.0.0', zeta: '1.0.0' },
  };

  assert.deepEqual(resolve(body), resolve(reversed));
});

test('rejects invalid ranges with a validation error', () => {
  assert.throws(
    () => resolve({ registry: {}, root: { app: 'not-a-range' } }),
    /valid semver range/
  );
});
