import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env.js';
import { requestLogger, errorHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';
import adminRoutes from './routes/admin.js';

const app = express();

// Behind cPanel/Apache the API is reverse-proxied, so req.ip is the proxy
// unless Express is told to read X-Forwarded-For. Rate limiting by IP and the
// Secure cookie flag both depend on getting this right. One hop only: trusting
// the whole chain would let a client spoof its own address and sidestep the
// login limiter.
app.set('trust proxy', 1);

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

// CORS configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (env.ALLOWED_ORIGINS.includes('*') || env.ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      // In development, allow localhost/127.0.0.1 origins
      if (env.NODE_ENV !== 'production' && /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    // PATCH/DELETE are not used today, but the admin API is the first thing
    // here that could grow them; a missing verb fails as an opaque CORS error.
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-razorpay-signature',
      'x-request-id',
      // Double-submit CSRF token echoed by the admin dashboard.
      'x-csrf-token'
    ],
    // The dashboard reads the filename and row count off an export response.
    exposedHeaders: ['Content-Disposition', 'X-Row-Count', 'x-request-id']
  })
);

// JSON body parser with rawBody preserved for Razorpay webhook verification
app.use(
  express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// URL-encoded body parser
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Session cookies for the admin dashboard. Signing is unnecessary: the session
// cookie holds a 256-bit opaque token that is looked up server-side, so a
// forged value simply fails to resolve.
app.use(cookieParser());

// Request logging & correlation IDs
app.use(requestLogger);

// Mount API v1
app.use('/api/v1', routes);

// Mount the admin API. Every route inside is behind session authentication.
app.use('/api/v1/admin', adminRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    code: 'NOT_FOUND'
  });
});

// Central error handler
app.use(errorHandler);

export default app;
