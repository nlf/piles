'use strict';

const Logger = require('nsp-log');
const Stringify = require('fast-safe-stringify');

const internals = {};
internals.levels = ['info', 'debug', 'warning', 'error', 'critical'];
internals.defaults = {
  shutdownTimeout: 10000,
  exclude: []
};

exports.register = function (server, options, next) {

  const settings = Object.assign({}, internals.defaults, options);
  const logger = new Logger(settings);

  process.on('uncaughtException', (err) => {

    logger.critical(err, { reason: 'uncaughtException' });
    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {

    logger.critical(err, { reason: 'unhandledRejection' });
    process.exit(1);
  });

  process.once('SIGTERM', () => {

    logger.info('shutting down', { signal: 'SIGTERM', server: server.root.info.id });
    server.root.stop({ timeout: settings.shutdownTimeout }, process.exit);
  });

  process.once('SIGINT', () => {

    logger.info('shutting down', { signal: 'SIGINT', server: server.root.info.id });
    server.root.stop({ timeout: settings.shutdownTimeout }, process.exit);
  });

  server.ext('onPostStart', (srv, nextExt) => {

    logger.info('server started', { server: srv.info.id });
    return nextExt();
  });

  server.ext('onPostStop', (srv, nextExt) => {

    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    logger.info('server stopped', { server: srv.info.id });
    return nextExt();
  });

  server.on('log', (event) => {

    let level = 'info';
    const tags = {};
    for (const tag of event.tags) {
      if (internals.levels.includes(tag)) {
        level = tag;
      }
      else {
        tags[tag] = 'true';
      }
    }

    logger[level](event.data, tags);
  });

  server.on('request-error', (request, err) => {

    logger.error(err, { request: request.id, type: 'request' });
  });

  server.ext('onRequest', (request, reply) => {

    request.plugins.piles = {
      requestSize: 0,
      responseSize: 0
    };

    request.on('peek', (chunk) => {

      request.plugins.piles.requestSize += chunk.length;
    });

    return reply.continue();
  });

  server.ext('onPreResponse', (request, reply) => {

    if (request.response.isBoom) {
      request.plugins.piles.responseSize = Buffer.from(JSON.stringify(request.response.output.payload)).byteLength;
      return reply.continue();
    }

    request.response.on('peek', (chunk) => {

      request.plugins.piles.responseSize += chunk.length;
    });

    return reply.continue();
  });

  server.on('response', (request) => {

    const routeSettings = request.route.settings.plugins.piles || {};
    if (routeSettings.exclude ||
        settings.exclude.includes(request.path)) {

      return;
    }

    const latency = (request.info.responded || Date.now()) - request.info.received;

    const payload = {
      severity: 'INFO',
      'logging.googleapis.com/operation': {
        id: request.id,
        producer: request.server.info.id
      },
      timestamp: {
        seconds: Math.floor(request.info.received / 1000),
        nanos: Math.round(request.info.received % 1000) * 1000000
      },
      httpRequest: {
        requestMethod: request.method.toUpperCase(),
        requestUrl: `${request.connection.info.protocol}://${request.connection.info.host === '0.0.0.0' ? (settings.name || process.env.HOSTNAME) : request.connection.info.host}${request.raw.req.url}`,
        requestSize: request.plugins.piles ? request.plugins.piles.requestSize : 0,
        status: request.response.statusCode,
        responseSize: request.plugins.piles ? request.plugins.piles.responseSize : 0,
        userAgent: request.headers['user-agent'],
        remoteIp: request.headers['x-forwarded-for'] ? request.headers['x-forwarded-for'].split(',').shift().trim() : request.info.remoteAddress,
        referer: request.info.referrer,
        cacheHit: false,
        cacheValidatedWithOriginServer: false,
        latency: {
          seconds: Math.floor(latency / 1000),
          nanos: Math.round(latency % 1000) * 1000000
        }
      }
    };

    if (!logger.disabled) {
      console.log(Stringify(payload));
    }
  });

  return next();
};

exports.register.attributes = {
  pkg: require('../package.json')
};
