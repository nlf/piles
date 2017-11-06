'use strict';

const Stringify = require('fast-safe-stringify');

const internals = {};
internals.levels = ['info', 'debug', 'warning', 'error', 'critical'];
internals.defaults = {
  shutdownTimeout: 10000,
  exclude: []
};

internals.timestamp = (ts) => {

  return {
    seconds: Math.floor(ts / 1000),
    nanos: Math.round(ts % 1000) * 1000000
  };
};

internals.now = () => {

  return internals.timestamp(Date.now());
};

exports.register = function (server, options, next) {

  const settings = Object.assign({}, internals.defaults, options);

  process.on('uncaughtException', (err) => {

    const payload = {
      severity: 'CRITICAL',
      message: err instanceof Error ? err.stack : err,
      'logging.googleapis.com/operation': {
        producer: server.info.id,
        id: 'uncaughtException'
      },
      serviceContext: {
        service: settings.name || process.env.HOSTNAME
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }

    process.exit(1);
  });

  process.on('unhandledRejection', (err) => {

    const payload = {
      severity: 'CRITICAL',
      message: err instanceof Error ? err.stack : err,
      'logging.googleapis.com/operation': {
        producer: server.info.id,
        id: 'unhandledRejection'
      },
      serviceContext: {
        service: settings.name || process.env.HOSTNAME
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }

    process.exit(1);
  });

  process.once('SIGTERM', () => {

    const payload = {
      severity: 'INFO',
      message: 'caught SIGTERM, shutting down',
      'logging.googleapis.com/operation': {
        producer: server.info.id,
        id: 'SIGTERM'
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }

    server.root.stop({ timeout: settings.shutdownTimeout }, process.exit);
  });

  process.once('SIGINT', () => {

    const payload = {
      severity: 'INFO',
      message: 'caught SIGINT, shutting down',
      'logging.googleapis.com/operation': {
        producer: server.info.id,
        id: 'SIGINT'
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }

    server.root.stop({ timeout: settings.shutdownTimeout }, process.exit);
  });

  server.ext('onPostStart', (srv, nextExt) => {

    const payload = {
      severity: 'INFO',
      message: 'server started',
      'logging.googleapis.com/operation': {
        producer: srv.info.id,
        id: 'onPostStart'
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }

    return nextExt();
  });

  server.ext('onPostStop', (srv, nextExt) => {

    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');

    const payload = {
      severity: 'INFO',
      message: 'server stopped',
      'logging.googleapis.com/operation': {
        producer: srv.info.id,
        id: 'onPostStop'
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }

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

    const payload = {
      severity: level.toUpperCase(),
      message: event.data,
      'logging.googleapis.com/operation': {
        producer: server.info.id,
        id: 'log'
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }
  });

  server.on('request', (request, event) => {

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

    const payload = {
      severity: level.toUpperCase(),
      message: event.data,
      'logging.googleapis.com/operation': {
        producer: request.server.info.id,
        id: request.id
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }
  });

  server.on('request-error', (request, err) => {

    const now = Date.now();

    const payload = {
      severity: 'ERROR',
      message: err.stack,
      'logging.googleapis.com/operation': {
        producer: request.server.info.id,
        id: request.id
      },
      serviceContext: {
        service: settings.name || process.env.HOSTNAME
      },
      timestamp: internals.now()
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }
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
        producer: request.server.info.id,
        id: request.id
      },
      timestamp: internals.timestamp(request.info.received),
      httpRequest: {
        requestMethod: request.method.toUpperCase(),
        requestUrl: `${request.connection.info.protocol}://${request.connection.info.host === '0.0.0.0' ? (settings.name || process.env.HOSTNAME) : request.connection.info.host}${request.raw.req.url}`,
        requestSize: request.plugins.piles ? request.plugins.piles.requestSize : 0,
        status: request.response.statusCode,
        responseSize: request.plugins.piles ? request.plugins.piles.responseSize : 0,
        userAgent: request.headers['user-agent'],
        remoteIp: request.headers['x-forwarded-for'] ? request.headers['x-forwarded-for'].split(',').shift().trim() : request.info.remoteAddress,
        referer: request.info.referrer || undefined,
        latency: `${latency / 1000}s`
      }
    };

    if (!settings.disabled) {
      console.log(Stringify(payload));
    }
  });

  return next();
};

exports.register.attributes = {
  pkg: require('../package.json')
};
