const { Pool } = require('pg');
require('dotenv').config();

const allowSelfSigned = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false' || process.env.DB_SSL_ALLOW_SELF_SIGNED === 'true' || process.env.NODE_ENV !== 'production';

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false : {
        rejectUnauthorized: !allowSelfSigned,
      },
    }
  : {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

module.exports = {
  pool,
  query: async (text, params) => {
    if (typeof text !== 'string' && !text?.text) {
      throw new Error('Consulta SQL inválida: debe ser un string o un objeto de consulta parametrizado.');
    }
    return pool.query(text, params);
  },
};
