// Base de données SQLite (intégrée à Node.js 22+, aucune installation nécessaire)
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'plateforme.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS prospects (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    entreprise        TEXT NOT NULL,
    secteur           TEXT,
    contact_nom       TEXT,
    contact_poste     TEXT,
    email             TEXT UNIQUE,
    telephone         TEXT,
    ville             TEXT,
    site_web          TEXT,
    statut            TEXT NOT NULL DEFAULT 'a_contacter',
    emails_envoyes    INTEGER NOT NULL DEFAULT 0,
    dernier_contact   TEXT,
    prochaine_relance TEXT,
    notes             TEXT,
    source            TEXT DEFAULT 'manuel',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activites (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    prospect_id  INTEGER REFERENCES prospects(id) ON DELETE CASCADE,
    type         TEXT NOT NULL,
    detail       TEXT,
    source       TEXT DEFAULT 'manuel',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_prospects_statut ON prospects(statut);
  CREATE INDEX IF NOT EXISTS idx_activites_prospect ON activites(prospect_id);
`);

module.exports = db;
