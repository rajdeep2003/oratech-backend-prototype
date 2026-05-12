const ENV = {
  development: {
    port: 3000,
    environment: 'development',
    databaseUrl: 'mongodb://localhost:27017/ora-dev',
    jwtSecret: 'your-dev-secret-key',
    nodeEnv: 'development',
    SUPABASE_URL: 'https://wmzlldylqdvbjjwgzkmv.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtemxsZHlscWR2Ympqd2d6a212Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzYzODMxNCwiZXhwIjoyMDkzMjE0MzE0fQ.C3qvktJAcMWhlnlAie0lQo_i7TlE2Jr-fcBdtTZGvRc',
  },
  staging: {
    port: 3000,
    environment: 'staging',
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    nodeEnv: 'staging',
  },
  production: {
    port: process.env.PORT || 3000,
    environment: 'production',
    databaseUrl: process.env.DATABASE_URL,
    jwtSecret: process.env.JWT_SECRET,
    nodeEnv: 'production',
  },
};

const nodeEnv = process.env.NODE_ENV || 'development';

// simple JS lookup (no TS casting nonsense)
const envConfig = ENV[nodeEnv] || ENV.development;

const config = {
  ...envConfig,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  apiVersion: 'v1',
};

export default config;