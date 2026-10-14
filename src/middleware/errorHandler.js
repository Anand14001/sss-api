import crypto from 'node:crypto';

export function requestLogger(req, res, next) {
  const reqId = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = reqId;
  res.setHeader('x-request-id', reqId);

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV !== 'test') {
      console.log(`[${new Date().toISOString()}] [${reqId}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
    }
  });

  next();
}

export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const reqId = req.id || 'unknown';

  if (status >= 500 && process.env.NODE_ENV !== 'test') {
    console.error(`[ERROR] [${reqId}] ${err.message}`, err.stack);
  }

  const response = {
    success: false,
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR',
    requestId: reqId
  };

  if (err.details) {
    response.details = err.details;
  }

  res.status(status).json(response);
}
