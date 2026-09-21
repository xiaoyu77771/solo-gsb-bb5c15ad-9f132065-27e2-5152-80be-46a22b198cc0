'use strict';

const express = require('express');
const { resolve, planUpdate, ResolutionError } = require('./resolver');

function createApp() {
  const app = express();

  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'offline-dependency-resolver',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/resolve', (req, res, next) => {
    try {
      const result = resolve(req.body);
      if (result.satisfiable) {
        return res.json(result);
      }
      return res.status(409).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/update-plan', (req, res, next) => {
    try {
      const result = planUpdate(req.body);
      if (result.satisfiable) {
        return res.json(result);
      }
      return res.status(409).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError) {
      return res.status(400).json({
        error: 'INVALID_JSON',
        message: error.message,
      });
    }

    if (error instanceof ResolutionError) {
      return res.status(error.statusCode).json({
        error: 'INVALID_REQUEST',
        message: error.message,
      });
    }

    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'PAYLOAD_TOO_LARGE',
        message: error.message,
      });
    }

    return res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
    });
  });

  return app;
}

module.exports = { createApp };
