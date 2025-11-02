const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const postgres = require('postgres');

const connectionString = process.env.DATABASE_URL;

let sql = postgres(connectionString, { max: 5, ssl: 'require' });
if (!connectionString) {
  console.warn('[db] DATABASE_URL is not set in .env.local');
} else {
  sql = postgres(connectionString, { max: 5 });
}

module.exports = sql;
