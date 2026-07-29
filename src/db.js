// Connexion à la base et schéma.
// On utilise node:sqlite (intégré à Node 22+), donc aucune dépendance à compiler.
//
// Règle absolue du projet : tous les montants sont des ENTIERS de jetons.
// Jamais de nombre à virgule sur de l'argent — les erreurs d'arrondi finissent
// toujours par créer ou détruire de la valeur.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// JEUX_DB permet de pointer ailleurs — les tests s'en servent pour partir
// d'une base vierge plutôt que de toucher aux données réelles.
const racine = dirname(dirname(fileURLToPath(import.meta.url)));
const dossierData = join(racine, 'data');
mkdirSync(dossierData, { recursive: true });

const cheminBase = process.env.JEUX_DB || join(dossierData, 'jeux.db');

export const db = new DatabaseSync(cheminBase);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    pseudo        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    mot_de_passe  TEXT NOT NULL,
    cree_le       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    jeton      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cree_le    TEXT NOT NULL DEFAULT (datetime('now')),
    expire_le  TEXT NOT NULL
  );

  -- ---------------------------------------------------------------
  -- Grand livre en double entrée
  -- ---------------------------------------------------------------
  -- Quatre genres de comptes :
  --   emission   : source des jetons virtuels. Son solde négatif = masse en circulation.
  --   joueur     : le portefeuille d'un joueur.
  --   sequestre  : les mises d'une partie, immobilisées le temps du jeu.
  --   maison     : les commissions encaissées.
  CREATE TABLE IF NOT EXISTS comptes (
    id       INTEGER PRIMARY KEY,
    cle      TEXT NOT NULL UNIQUE,
    genre    TEXT NOT NULL CHECK (genre IN ('emission','joueur','sequestre','maison')),
    user_id  INTEGER REFERENCES users(id),
    devise   TEXT NOT NULL DEFAULT 'JET',
    cree_le  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id       INTEGER PRIMARY KEY,
    genre    TEXT NOT NULL,
    ref      TEXT,
    cree_le  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Une écriture = un mouvement sur un compte. La somme des écritures
  -- d'une même transaction vaut toujours exactement zéro.
  CREATE TABLE IF NOT EXISTS ecritures (
    id         INTEGER PRIMARY KEY,
    tx_id      INTEGER NOT NULL REFERENCES transactions(id),
    compte_id  INTEGER NOT NULL REFERENCES comptes(id),
    montant    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ecritures_compte ON ecritures(compte_id);
  CREATE INDEX IF NOT EXISTS idx_ecritures_tx     ON ecritures(tx_id);

  -- ---------------------------------------------------------------
  -- Parties
  -- ---------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS parties (
    id                INTEGER PRIMARY KEY,
    jeu               TEXT NOT NULL,
    mode              TEXT NOT NULL CHECK (mode IN ('gratuit','argent')),
    etat              TEXT NOT NULL CHECK (etat IN ('ouverte','verrouillee','reglee','annulee')),
    mise              INTEGER NOT NULL,
    joueurs_min       INTEGER NOT NULL DEFAULT 2,
    commission_bp     INTEGER NOT NULL DEFAULT 500,   -- points de base : 500 = 5 %
    graine_serveur    TEXT NOT NULL,
    empreinte_graine  TEXT NOT NULL,
    graine_revelee    INTEGER NOT NULL DEFAULT 0,
    ouvre_le          TEXT NOT NULL DEFAULT (datetime('now')),
    ferme_le          TEXT,
    resultat          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_parties_etat ON parties(jeu, mode, etat);

  CREATE TABLE IF NOT EXISTS participations (
    id             INTEGER PRIMARY KEY,
    partie_id      INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id),
    choix          TEXT,
    graine_client  TEXT,
    montant        INTEGER NOT NULL DEFAULT 0,
    role           TEXT,
    gain           INTEGER NOT NULL DEFAULT 0,
    rejoint_le     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (partie_id, user_id)
  );
`);

// Petites migrations idempotentes : ajoute les colonnes manquantes aux bases
// créées par une version antérieure du schéma.
for (const [table, colonne, definition] of [
  ['participations', 'montant', 'INTEGER NOT NULL DEFAULT 0'],
  ['participations', 'role', 'TEXT'],
]) {
  const colonnes = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!colonnes.some((c) => c.name === colonne)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${definition}`);
  }
}

/**
 * Exécute `fn` dans une transaction SQL. Tout est écrit, ou rien ne l'est.
 * Indispensable pour le grand livre : une écriture orpheline déséquilibrerait
 * les comptes de façon permanente.
 *
 * La fonction est réentrante. SQLite n'accepte pas d'imbriquer les BEGIN, or
 * les couches supérieures s'appellent entre elles (rejoindre() appelle miser(),
 * qui veut sa propre transaction). Les appels imbriqués utilisent donc un point
 * de sauvegarde : ils peuvent échouer et être défaits sans annuler le tout,
 * et seule la transaction la plus externe valide réellement.
 */
let profondeur = 0;

export function transaction(fn) {
  const nom = `pt_${profondeur}`;
  if (profondeur === 0) {
    db.exec('BEGIN IMMEDIATE');
  } else {
    db.exec(`SAVEPOINT ${nom}`);
  }
  profondeur++;

  try {
    const resultat = fn();
    profondeur--;
    if (profondeur === 0) {
      db.exec('COMMIT');
    } else {
      db.exec(`RELEASE ${nom}`);
    }
    return resultat;
  } catch (erreur) {
    profondeur--;
    if (profondeur === 0) {
      db.exec('ROLLBACK');
    } else {
      db.exec(`ROLLBACK TO ${nom}`);
      db.exec(`RELEASE ${nom}`);
    }
    throw erreur;
  }
}
