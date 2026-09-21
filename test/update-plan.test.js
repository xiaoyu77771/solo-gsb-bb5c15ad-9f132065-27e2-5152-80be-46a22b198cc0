'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { planUpdate } = require('../src/resolver');

function listen(app) {
  return new Promise((resolveServer, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolveServer(server));
    server.on('error', reject);
  });
}

async function postUpdatePlan(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/update-plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test('keeps locked versions when they already satisfy every constraint', () => {
  const result = planUpdate({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.5.0': {}, '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0' },
    update: {},
  });

  assert.deepEqual(result, {
    satisfiable: true,
    plan: [
      { package: 'app', version: '1.0.0' },
      { package: 'lib', version: '1.0.0' },
    ],
    summary: {
      kept: [
        { package: 'app', version: '1.0.0' },
        { package: 'lib', version: '1.0.0' },
      ],
      changed: [],
    },
  });
});

test('applies update constraints and reports from/to in the summary', () => {
  const result = planUpdate({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '>=1.0.0' } } },
      lib: { '2.0.0': {}, '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0' },
    update: { lib: '^2.0.0' },
  });

  assert.deepEqual(result, {
    satisfiable: true,
    plan: [
      { package: 'app', version: '1.0.0' },
      { package: 'lib', version: '2.0.0' },
    ],
    summary: {
      kept: [{ package: 'app', version: '1.0.0' }],
      changed: [{ package: 'lib', from: '1.0.0', to: '2.0.0' }],
    },
  });
});

test('minimizes changed packages before preferring higher versions', () => {
  const input = {
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: {
        '1.2.0': { dependencies: { util: '^2.0.0' } },
        '1.1.0': { dependencies: { util: '^1.0.0' } },
      },
      util: { '2.0.0': {}, '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.1.0', util: '1.0.0' },
    update: {},
  };

  const result = planUpdate(input);

  // Upgrading lib to 1.2.0 would force util to 2.0.0 (two changes), so the
  // locked combination wins even though plain /resolve would pick it.
  assert.deepEqual(result.plan, [
    { package: 'app', version: '1.0.0' },
    { package: 'lib', version: '1.1.0' },
    { package: 'util', version: '1.0.0' },
  ]);
  assert.deepEqual(result.summary, {
    kept: [
      { package: 'app', version: '1.0.0' },
      { package: 'lib', version: '1.1.0' },
      { package: 'util', version: '1.0.0' },
    ],
    changed: [],
  });
});

test('breaks change-count ties by preferring higher versions in package-name order', () => {
  const result = planUpdate({
    registry: {
      z: {
        '1.5.0': { dependencies: { a: '1.0.0' } },
        '1.0.0': { dependencies: { a: '1.5.0' } },
      },
      a: { '1.5.0': {}, '1.0.0': {} },
    },
    root: { z: '^1.0.0' },
    locked: {},
    update: {},
  });

  // Both plans change two packages; the tie is broken on package "a" (the
  // lexicographically first name), preferring its higher version.
  assert.deepEqual(result.plan, [
    { package: 'a', version: '1.5.0' },
    { package: 'z', version: '1.0.0' },
  ]);
  assert.deepEqual(result.summary, {
    kept: [],
    changed: [
      { package: 'a', from: null, to: '1.5.0' },
      { package: 'z', from: null, to: '1.0.0' },
    ],
  });
});

test('reports added and removed packages in the change summary', () => {
  const result = planUpdate({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', old: '2.0.0' },
    update: {},
  });

  assert.deepEqual(result.summary, {
    kept: [{ package: 'app', version: '1.0.0' }],
    changed: [
      { package: 'lib', from: null, to: '1.0.0' },
      { package: 'old', from: '2.0.0', to: null },
    ],
  });
});

test('canonicalizes locked versions before comparing', () => {
  const result = planUpdate({
    registry: {
      app: { '1.0.0': {} },
    },
    root: { app: '^1.0.0' },
    locked: { app: 'v1.0.0+build.1' },
    update: {},
  });

  assert.deepEqual(result.summary, {
    kept: [{ package: 'app', version: '1.0.0' }],
    changed: [],
  });
});

test('returns the shared conflict structure when update constraints are unsatisfiable', () => {
  const result = planUpdate({
    registry: {
      app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
      lib: { '2.0.0': {}, '1.0.0': {} },
    },
    root: { app: '1.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0' },
    update: { lib: '^2.0.0' },
  });

  assert.equal(result.satisfiable, false);
  assert.equal(result.conflict.package, 'lib');
  const endpoint = result.conflict.chain[result.conflict.chain.length - 1];
  assert.equal(endpoint.reasonCode, 'NO_VERSION_SATISFIES_CONSTRAINTS');
  assert.deepEqual(endpoint.availableVersions, ['2.0.0', '1.0.0']);
  assert.deepEqual(endpoint.compatibleVersions, []);
  assert.deepEqual(endpoint.constraints, [
    {
      requiredRange: '^1.0.0',
      requiredBy: { type: 'dependency', package: 'app', version: '1.0.0' },
    },
    {
      requiredRange: '^2.0.0',
      requiredBy: { type: 'root' },
    },
  ]);
});

test('reports update constraints on packages missing from the registry', () => {
  const result = planUpdate({
    registry: { app: { '1.0.0': {} } },
    root: { app: '1.0.0' },
    locked: {},
    update: { ghost: '^1.0.0' },
  });

  assert.equal(result.satisfiable, false);
  assert.equal(result.conflict.package, 'ghost');
  const endpoint = result.conflict.chain[result.conflict.chain.length - 1];
  assert.equal(endpoint.reasonCode, 'PACKAGE_NOT_IN_REGISTRY');
});

test('rejects invalid locked versions and update ranges', () => {
  const base = {
    registry: { app: { '1.0.0': {} } },
    root: { app: '1.0.0' },
    locked: {},
    update: {},
  };

  assert.throws(
    () => planUpdate({ ...base, locked: { app: 'not-a-version' } }),
    /valid semver version/
  );
  assert.throws(
    () => planUpdate({ ...base, update: { app: 'not-a-range' } }),
    /valid semver range/
  );
  assert.throws(
    () => planUpdate({ ...base, locked: ['app'] }),
    /locked must be an object/
  );
  assert.throws(
    () => planUpdate({ ...base, update: '^1.0.0' }),
    /update must be an object/
  );
});

test('does not depend on locked, update, root or registry key order', () => {
  const body = {
    registry: {
      lib: { '2.0.0': {}, '1.0.0': {} },
      app: { '1.0.0': { dependencies: { lib: '>=1.0.0' } } },
    },
    root: { app: '1.0.0' },
    locked: { lib: '1.0.0', app: '1.0.0' },
    update: { lib: '^2.0.0' },
  };

  const shuffled = {
    update: { lib: '^2.0.0' },
    locked: { app: '1.0.0', lib: '1.0.0' },
    root: { app: '1.0.0' },
    registry: {
      app: { '1.0.0': { dependencies: { lib: '>=1.0.0' } } },
      lib: { '1.0.0': {}, '2.0.0': {} },
    },
  };

  assert.deepEqual(planUpdate(body), planUpdate(shuffled));
});

test('POST /update-plan returns a plan with a kept/changed summary', async () => {
  const server = await listen(createApp());
  try {
    const response = await postUpdatePlan(server, {
      registry: {
        app: { '1.0.0': { dependencies: { lib: '>=1.0.0' } } },
        lib: { '2.0.0': {}, '1.0.0': {} },
      },
      root: { app: '1.0.0' },
      locked: { app: '1.0.0', lib: '1.0.0' },
      update: { lib: '^2.0.0' },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      satisfiable: true,
      plan: [
        { package: 'app', version: '1.0.0' },
        { package: 'lib', version: '2.0.0' },
      ],
      summary: {
        kept: [{ package: 'app', version: '1.0.0' }],
        changed: [{ package: 'lib', from: '1.0.0', to: '2.0.0' }],
      },
    });
  } finally {
    server.close();
  }
});

test('POST /update-plan reports 409 with the shared conflict structure', async () => {
  const server = await listen(createApp());
  try {
    const response = await postUpdatePlan(server, {
      registry: {
        app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
        lib: { '1.0.0': {} },
      },
      root: { app: '1.0.0' },
      locked: { app: '1.0.0', lib: '1.0.0' },
      update: { lib: '^2.0.0' },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.satisfiable, false);
    assert.equal(response.body.conflict.package, 'lib');
    assert.equal(
      response.body.conflict.chain.at(-1).reasonCode,
      'NO_VERSION_SATISFIES_CONSTRAINTS'
    );
  } finally {
    server.close();
  }
});

test('POST /update-plan validates locked versions and update constraints', async () => {
  const server = await listen(createApp());
  try {
    const invalidLocked = await postUpdatePlan(server, {
      registry: { app: { '1.0.0': {} } },
      root: { app: '1.0.0' },
      locked: { app: 'not-a-version' },
      update: {},
    });
    assert.equal(invalidLocked.status, 400);
    assert.equal(invalidLocked.body.error, 'INVALID_REQUEST');

    const invalidUpdate = await postUpdatePlan(server, {
      registry: { app: { '1.0.0': {} } },
      root: { app: '1.0.0' },
      locked: {},
      update: { app: 'not-a-range' },
    });
    assert.equal(invalidUpdate.status, 400);
    assert.equal(invalidUpdate.body.error, 'INVALID_REQUEST');
  } finally {
    server.close();
  }
});
