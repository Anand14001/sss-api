import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sqlDir = path.resolve(__dirname, '../../sql');

export async function runMigrations() {
  await db.init();

  const migrationFiles = [
    '001_initial_schema.sql',
    '002_seed_event.sql'
  ];

  for (const file of migrationFiles) {
    const filePath = path.join(sqlDir, file);
    if (fs.existsSync(filePath)) {
      const sql = fs.readFileSync(filePath, 'utf8');
      try {
        await db.execRaw(sql);
      } catch (err) {
        // If it's a duplicate seed error, safe to ignore
        if (!err.message?.includes('UNIQUE') && !err.message?.includes('Duplicate entry')) {
          throw err;
        }
      }
    }
  }
}

// Allow direct execution
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => {
      console.log('Migrations completed successfully.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
