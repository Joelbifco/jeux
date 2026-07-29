// Grand livre en double entrée.
//
// Tout mouvement de jetons passe par ici, et une seule règle le gouverne :
// la somme des écritures d'une transaction vaut zéro. Les jetons ne sont
// jamais créés ni détruits, seulement déplacés d'un compte à un autre.
// Un bogue de jeu peut alors donner des jetons au mauvais joueur, mais il ne
// peut pas en inventer — et ça, c'est la différence entre une erreur qu'on
// corrige et une plateforme dont la comptabilité ne veut plus rien dire.

import { db, transaction } from './db.js';

const DEVISE = 'JET';

const litCompte = db.prepare('SELECT * FROM comptes WHERE cle = ?');
const creeCompte = db.prepare(
  'INSERT INTO comptes (cle, genre, user_id, devise) VALUES (?, ?, ?, ?)'
);
const litSolde = db.prepare(
  'SELECT COALESCE(SUM(montant), 0) AS solde FROM ecritures WHERE compte_id = ?'
);
const creeTx = db.prepare('INSERT INTO transactions (genre, ref) VALUES (?, ?)');
const creeEcriture = db.prepare(
  'INSERT INTO ecritures (tx_id, compte_id, montant) VALUES (?, ?, ?)'
);

/** Récupère un compte par sa clé, en le créant au besoin. */
function compte(cle, genre, userId = null) {
  const existant = litCompte.get(cle);
  if (existant) return existant.id;
  creeCompte.run(cle, genre, userId, DEVISE);
  return litCompte.get(cle).id;
}

export const compteEmission = () => compte(`emission:${DEVISE}`, 'emission');
export const compteMaison = () => compte(`maison:${DEVISE}`, 'maison');
export const compteJoueur = (userId) => compte(`joueur:${userId}:${DEVISE}`, 'joueur', userId);
export const compteSequestre = (partieId) => compte(`sequestre:${partieId}:${DEVISE}`, 'sequestre');

/** Solde d'un compte, en jetons entiers. */
export function solde(compteId) {
  return Number(litSolde.get(compteId).solde);
}

export function soldeJoueur(userId) {
  return solde(compteJoueur(userId));
}

/**
 * Passe une transaction équilibrée.
 *
 * @param {string} genre  'dotation' | 'mise' | 'gain' | 'commission' | 'remboursement'
 * @param {string|null} ref  référence libre (id de partie, en général)
 * @param {Array<{compte: number, montant: number}>} mouvements  montants signés
 */
export function passer(genre, ref, mouvements) {
  if (mouvements.length < 2) {
    throw new Error('Une transaction exige au moins deux écritures');
  }

  for (const { montant } of mouvements) {
    if (!Number.isSafeInteger(montant)) {
      throw new Error(`Montant non entier : ${montant}`);
    }
    if (montant === 0) {
      throw new Error('Écriture de montant nul');
    }
  }

  const total = mouvements.reduce((somme, m) => somme + m.montant, 0);
  if (total !== 0) {
    throw new Error(`Transaction déséquilibrée : somme = ${total}, attendu 0`);
  }

  return transaction(() => {
    // Un joueur ou un séquestre ne peut jamais passer sous zéro. Seuls les
    // comptes d'émission et de maison ont le droit d'être négatifs (l'émission
    // représente la masse en circulation, la maison une commission d'avance).
    const parCompte = new Map();
    for (const { compte: id, montant } of mouvements) {
      parCompte.set(id, (parCompte.get(id) ?? 0) + montant);
    }

    for (const [id, delta] of parCompte) {
      const infos = db.prepare('SELECT genre FROM comptes WHERE id = ?').get(id);
      if (!infos) throw new Error(`Compte inconnu : ${id}`);
      if (infos.genre === 'joueur' || infos.genre === 'sequestre') {
        const apres = solde(id) + delta;
        if (apres < 0) {
          throw new Error(`Solde insuffisant sur le compte ${id} : manque ${-apres} jetons`);
        }
      }
    }

    const { lastInsertRowid } = creeTx.run(genre, ref);
    const txId = Number(lastInsertRowid);
    for (const { compte: id, montant } of mouvements) {
      creeEcriture.run(txId, id, montant);
    }
    return txId;
  });
}

/** Crédite un joueur depuis le compte d'émission (jetons gratuits, bonus d'accueil). */
export function doter(userId, montant, ref = 'accueil') {
  return passer('dotation', ref, [
    { compte: compteEmission(), montant: -montant },
    { compte: compteJoueur(userId), montant: +montant },
  ]);
}

/** Déplace la mise d'un joueur vers le séquestre de la partie. */
export function miser(userId, partieId, montant) {
  return passer('mise', String(partieId), [
    { compte: compteJoueur(userId), montant: -montant },
    { compte: compteSequestre(partieId), montant: +montant },
  ]);
}

/**
 * Règle une partie : la commission part vers la maison, le reste est réparti
 * entre les gagnants. Le séquestre doit retomber exactement à zéro.
 *
 * @param {number} partieId
 * @param {number} commissionBp  commission en points de base (500 = 5 %)
 * @param {Array<{userId: number, parts: number}>} gagnants
 */
export function regler(partieId, commissionBp, gagnants) {
  const sequestre = compteSequestre(partieId);
  const cagnotte = solde(sequestre);
  if (cagnotte === 0) return null;

  const commission = Math.floor((cagnotte * commissionBp) / 10_000);
  const aRepartir = cagnotte - commission;

  const partsTotales = gagnants.reduce((somme, g) => somme + g.parts, 0);
  if (partsTotales <= 0) throw new Error('Aucune part à répartir');

  const mouvements = [{ compte: sequestre, montant: -cagnotte }];
  if (commission > 0) {
    mouvements.push({ compte: compteMaison(), montant: +commission });
  }

  // Répartition au prorata. Le reste de la division entière va au premier
  // gagnant plutôt que de disparaître — sinon le séquestre ne se viderait pas.
  let distribue = 0;
  gagnants.forEach((g, index) => {
    const part =
      index === gagnants.length - 1
        ? aRepartir - distribue
        : Math.floor((aRepartir * g.parts) / partsTotales);
    distribue += part;
    if (part > 0) {
      mouvements.push({ compte: compteJoueur(g.userId), montant: +part });
    }
  });

  return passer('gain', String(partieId), mouvements);
}

/** Annule une partie : chaque joueur récupère exactement sa mise. */
export function rembourser(partieId) {
  const sequestre = compteSequestre(partieId);
  const cagnotte = solde(sequestre);
  if (cagnotte === 0) return null;

  const mises = db
    .prepare(
      `SELECT e.compte_id, c.user_id, -SUM(e.montant) AS mise
         FROM ecritures e
         JOIN transactions t ON t.id = e.tx_id
         JOIN comptes c ON c.id = e.compte_id
        WHERE t.genre = 'mise' AND t.ref = ? AND c.genre = 'joueur'
        GROUP BY e.compte_id`
    )
    .all(String(partieId));

  const mouvements = [{ compte: sequestre, montant: -cagnotte }];
  for (const ligne of mises) {
    mouvements.push({ compte: ligne.compte_id, montant: Number(ligne.mise) });
  }

  return passer('remboursement', String(partieId), mouvements);
}

/**
 * Rend une partie de sa mise à un joueur avant le règlement.
 * Sert au craps : si les couvreurs n'égalent pas la mise du tireur, l'excédent
 * non couvert lui revient — il ne joue que ce qui a été effectivement misé
 * contre lui.
 */
export function rembourserPartiel(partieId, userId, montant) {
  if (montant <= 0) return null;
  return passer('remboursement', String(partieId), [
    { compte: compteSequestre(partieId), montant: -montant },
    { compte: compteJoueur(userId), montant: +montant },
  ]);
}

/**
 * Contrôle d'intégrité : la somme de TOUTES les écritures doit valoir zéro.
 * À appeler au démarrage et dans les tests. Si ça casse un jour, il faut
 * arrêter la plateforme, pas continuer.
 */
export function verifierIntegrite() {
  const { total } = db.prepare('SELECT COALESCE(SUM(montant), 0) AS total FROM ecritures').get();
  const desequilibrees = db
    .prepare(
      `SELECT tx_id, SUM(montant) AS somme
         FROM ecritures GROUP BY tx_id HAVING somme != 0`
    )
    .all();
  return { equilibre: Number(total) === 0 && desequilibrees.length === 0, total: Number(total), desequilibrees };
}
