import app from './app.js';
import { env, validateProductionConfig } from './config/env.js';
import { prisma } from './db/prisma.js';
import { seed } from '../prisma/seed.js';

const PORT = env.PORT || 4000;

async function startServer() {
  try {
    // Validate production environment requirements
    const missingConfig = validateProductionConfig();
    if (missingConfig.length > 0) {
      console.warn(`[CONFIG WARNING] Missing required production configuration: ${missingConfig.join(', ')}`);
    }

    // Verify PostgreSQL connection via Prisma
    await prisma.$connect();
    console.log('[DB] Connected to PostgreSQL via Prisma ORM');

    // Ensure initial event and category seed exists
    try {
      await seed();
    } catch (seedErr) {
      console.warn('[DB SEED] Seed warning:', seedErr.message);
    }

    const server = app.listen(PORT, () => {
      console.log(`[SERVER] Salem Star Speaker API listening on port ${PORT} (${env.NODE_ENV})`);
    });

    const shutdown = async (signal) => {
      console.log(`\n[SERVER] ${signal} received, closing HTTP server and Prisma client...`);
      server.close(async () => {
        try {
          await prisma.$disconnect();
          console.log('[SERVER] Prisma disconnected. Process exiting cleanly.');
          process.exit(0);
        } catch (err) {
          console.error('[SERVER] Error disconnecting Prisma:', err);
          process.exit(1);
        }
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    return server;
  } catch (err) {
    console.error('[FATAL] Failed to start server:', err);
    process.exit(1);
  }
}

// Start server if directly executed
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startServer();
}

export { startServer };
