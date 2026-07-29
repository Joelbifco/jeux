// Comptes joueurs et sessions.
//
// Mots de passe hachés avec scrypt : lent par conception, donc coûteux à
// attaquer par force brute même si la base fuit un jour.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { doter, soldeJoueur } from './ledger.js';

const scryptAsync = promisify(scrypt);

const DUREE_SESSION_JOURS = 30;
const DOTATION_ACCUEIL = 5000; // jetons gratuits offerts à l'inscription

async function hacher(motDePasse) {
  const sel = randomBytes(16);
  const derive = await scryptAsync(motDePasse, sel, 64);
  return `${sel.toString('hex')}:${derive.toString('hex')}`;
}

async function comparer(motDePasse, stocke) {
  const [selHex, deriveHex] = stocke.split(':');
  const derive = await scryptAsync(motDePasse, Buffer.from(selHex, 'hex'), 64);
  const attendu = Buffer.from(deriveHex, 'hex');
  if (derive.length !== attendu.length) return false;
  return timingSafeEqual(derive, attendu);
}

export async function inscrire(pseudo, motDePasse) {
  const nom = String(pseudo ?? '').trim();
  if (nom.length < 3 || nom.length > 20) {
    throw new Error('Le pseudo doit faire entre 3 et 20 caractères');
  }
  if (!/^[\w\-À-ÿ]+$/.test(nom)) {
    throw new Error('Le pseudo ne peut contenir que des lettres, chiffres, - et _');
  }
  if (String(motDePasse ?? '').length < 8) {
    throw new Error('Le mot de passe doit faire au moins 8 caractères');
  }
  if (db.prepare('SELECT 1 FROM users WHERE pseudo = ?').get(nom)) {
    throw new Error('Ce pseudo est déjà pris');
  }

  const hash = await hacher(motDePasse);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (pseudo, mot_de_passe) VALUES (?, ?)')
    .run(nom, hash);
  const userId = Number(lastInsertRowid);

  doter(userId, DOTATION_ACCUEIL);
  return userId;
}

export async function connecter(pseudo, motDePasse) {
  const utilisateur = db
    .prepare('SELECT * FROM users WHERE pseudo = ?')
    .get(String(pseudo ?? '').trim());

  // On hache quand même si le compte n'existe pas : sinon le temps de réponse
  // révèle quels pseudos sont enregistrés.
  if (!utilisateur) {
    await hacher(String(motDePasse ?? ''));
    throw new Error('Pseudo ou mot de passe invalide');
  }
  if (!(await comparer(motDePasse, utilisateur.mot_de_passe))) {
    throw new Error('Pseudo ou mot de passe invalide');
  }

  return ouvrirSession(utilisateur.id);
}

export function ouvrirSession(userId) {
  const jeton = randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions (jeton, user_id, expire_le)
     VALUES (?, ?, datetime('now', ?))`
  ).run(jeton, userId, `+${DUREE_SESSION_JOURS} days`);
  return jeton;
}

export function fermerSession(jeton) {
  db.prepare('DELETE FROM sessions WHERE jeton = ?').run(jeton);
}

/** Retourne le joueur associé à un jeton de session, ou null. */
export function joueurDeSession(jeton) {
  if (!jeton) return null;
  const ligne = db
    .prepare(
      `SELECT u.id, u.pseudo
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.jeton = ? AND s.expire_le > datetime('now')`
    )
    .get(jeton);
  if (!ligne) return null;
  return { id: ligne.id, pseudo: ligne.pseudo, solde: soldeJoueur(ligne.id) };
}

/** Ménage des sessions expirées, à appeler de temps en temps. */
export function purgerSessions() {
  db.prepare("DELETE FROM sessions WHERE expire_le <= datetime('now')").run();
}
