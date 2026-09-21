'use strict';

const { createApp } = require('./app');

const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';

const server = createApp().listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Offline dependency resolver listening at http://${host}:${port}`);
});

function shutdown(signal) {
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
