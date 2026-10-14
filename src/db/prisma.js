import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

let prismaInstance = null;

export function getPrismaClient() {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']
    });
  }
  return prismaInstance;
}

export const prisma = getPrismaClient();
