'use strict';

const express = require('express');
const { middleware: lineMiddleware } = require('@line/bot-sdk');

const { config, assertConfig } = require('./config');
const { handleEvent } = require('./webhook');
const scheduler = require('./scheduler');
const store = require('./db');

assertConfig();

const app = express();

app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

// Read-only view of this month's push consumption. Exposes counters only — no
// user ids, no message content — matching the same open posture as /health.
app.get('/usage', (_req, res) => {
  const usage = store.getPushUsage();
  return res
    .status(200)
    .json({ month: usage.month, count: usage.count, limit: config.pushLimit });
});

// The SDK middleware verifies x-line-signature and parses the body itself,
// so no global express.json() may run ahead of it.
app.post(
  '/webhook',
  lineMiddleware({ channelSecret: config.line.channelSecret }),
  async (req, res) => {
    // Ack immediately: LINE times out at 1s and retries, while a Gemini
    // round-trip can take several seconds.
    res.status(200).end();
    const events = (req.body && req.body.events) || [];
    for (const event of events) {
      handleEvent(event).catch((err) =>
        console.error('[index] unhandled event error:', err && err.message)
      );
    }
  }
);

// Signature failures land here as SignatureValidationFailed.
app.use((err, _req, res, _next) => {
  const name = err && err.name;
  if (name === 'SignatureValidationFailed' || name === 'JSONParseError') {
    console.warn('[index] rejected webhook request:', name);
    return res.status(401).json({ error: 'invalid signature' });
  }
  console.error('[index] server error:', err && err.message);
  return res.status(500).json({ error: 'internal error' });
});

const server = app.listen(config.port, () => {
  console.log('[index] listening on port ' + config.port);
  scheduler.start();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log('[index] ' + signal + ' received, shutting down');
    server.close(() => process.exit(0));
  });
}

module.exports = { app };
