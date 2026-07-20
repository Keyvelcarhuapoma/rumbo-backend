const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

const runSchema = async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("Connected to cloud database!");
    const sql = fs.readFileSync(path.join(__dirname, '..', 'database_schema.sql'), 'utf-8');
    console.log("Executing schema...");
    await client.query(sql);
    console.log("Schema created successfully.");
  } catch (err) {
    console.error("Error executing schema:", err);
  } finally {
    await client.end();
  }
};

runSchema();
