'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');

function listen(app) {
  return new Promise((resolveServer, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolveServer(server));
    server.on('error', reject);
  });
}

async function request(server, path, options = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method || 'GET',
    headers: options.body
      ? { 'content-type': 'application/json', ...(options.headers || {}) }
      : options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test('health check reports service status', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.service, 'offline-dependency-resolver');
  } finally {
    server.close();
  }
});

test('POST /resolve returns an installation plan', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/resolve', {
      method: 'POST',
      body: {
        registry: {
          app: { '1.0.0': { dependencies: { lib: '^1.0.0' } } },
          lib: { '1.2.0': {}, '1.0.0': {} },
        },
        root: { app: '1.0.0' },
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      satisfiable: true,
      plan: [
        { package: 'app', version: '1.0.0' },
        { package: 'lib', version: '1.2.0' },
      ],
    });
  } finally {
    server.close();
  }
});

test('POST /resolve reports 409 and a conflict chain when unsolvable', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/resolve', {
      method: 'POST',
      body: {
        registry: {
          app: { '1.0.0': { dependencies: { lib: '^2.0.0' } } },
          lib: { '1.0.0': {} },
        },
        root: { app: '1.0.0' },
      },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.satisfiable, false);
    assert.equal(response.body.conflict.package, 'lib');
    assert.equal(
      response.body.conflict.chain[0].requiredBy.type,
      'root'
    );
    assert.equal(
      response.body.conflict.chain.at(-1).reasonCode,
      'NO_VERSION_SATISFIES_CONSTRAINTS'
    );
  } finally {
    server.close();
  }
});

test('POST /resolve validates malformed requests', async () => {
  const server = await listen(createApp());
  try {
    const response = await request(server, '/resolve', {
      method: 'POST',
      body: { registry: {}, root: { app: 'invalid range' } },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'INVALID_REQUEST');
  } finally {
    server.close();
  }
});
