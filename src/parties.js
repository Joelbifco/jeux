// Cycle de vie d'une partie, identique pour tous les jeux.
//
//   ouverte  -> les joueurs peuvent rejoindre et miser
//   verrouillee -> plus personne n'entre, le jeu se déroule
//   reglee   -> les gains ont été distribués
//   annulee  -> pas assez de joueurs, tout le monde est remboursé
//
// Le mode 'gratuit' suit exactement le même chemin, mise à zéro : aucun
// mouvement de jetons, mais la même mécanique et le même code. C'est
// volontaire — un mode gratuit qui diverge du mode payant finit toujours par
// cacher un bogue qui n'apparaît que là où il coûte cher.

import { db, transaction } from './db.js';
import * as fair from './fair.js';
import { miser, regler, rembourser, compteSequestre, solde } from './ledger.js';

export function ouvrirPartie({ jeu, mode = 'gratuit', mise = 0, joueursMin = 2, commissionBp = 500 }) {
  if (mode === 'gratuit' && mise !== 0) {
    throw new Error('Une partie gratuite ne peut pas avoir de mise');
  }
  if (mode === 'argent' && mise <= 0) {
    throw new Error('Une partie payante exige une mise positive');
  }

  const graine = fair.nouvelleGraine();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO parties (jeu, mode, etat, mise, joueurs_min, commission_bp, graine_serveur, empreinte_graine)
       VALUES (?, ?, 'ouverte', ?, ?, ?, ?, ?)`
    )
    .run(jeu, mode, mise, joueursMin, commissionBp, graine, fair.empreinte(graine));

  return lire(Number(lastInsertRowid));
}

export function lire(partieId) {
  return db.prepare('SELECT * FROM parties WHERE id = ?').get(partieId) ?? null;
}

export function participants(partieId) {
  return db
    .prepare(
      `SELECT p.*, u.pseudo
         FROM participations p
         JOIN users u ON u.id = p.user_id
        WHERE p.partie_id = ?
        ORDER BY p.rejoint_le`
    )
    .all(partieId);
}

/**
 * Le joueur rejoint la partie et sa mise part au séquestre.
 * Le débit et l'inscription se font dans la même transaction : sans ça, un
 * plantage entre les deux laisserait un joueur payé mais non inscrit.
 */
export function rejoindre(partieId, userId, graineClient = null) {
  return transaction(() => {
    const partie = lire(partieId);
    if (!partie) throw new Error('Partie introuvable');
    if (partie.etat !== 'ouverte') throw new Error('Cette partie n’accepte plus de joueurs');

    const dejaLa = db
      .prepare('SELECT 1 FROM participations WHERE partie_id = ? AND user_id = ?')
      .get(partieId, userId);
    if (dejaLa) throw new Error('Tu es déjà dans cette partie');

    db.prepare(
      'INSERT INTO participations (partie_id, user_id, graine_client) VALUES (?, ?, ?)'
    ).run(partieId, userId, graineClient ?? fair.nouvelleGraine().slice(0, 16));

    if (partie.mise > 0) {
      miser(userId, partieId, partie.mise);
    }
    return true;
  });
}

/**
 * Variante à mise variable : le joueur engage le montant de son choix et prend
 * un rôle dans la partie (au craps : 'tireur' ou 'couvreur').
 * Peut être appelée plusieurs fois pour le même joueur — les montants
 * s'additionnent.
 */
export function engager(partieId, userId, montant, role = null) {
  return transaction(() => {
    const partie = lire(partieId);
    if (!partie) throw new Error('Partie introuvable');
    if (partie.etat !== 'ouverte') throw new Error('Les mises sont closes');
    if (!Number.isSafeInteger(montant) || montant <= 0) {
      throw new Error('Montant de mise invalide');
    }

    const existante = db
      .prepare('SELECT * FROM participations WHERE partie_id = ? AND user_id = ?')
      .get(partieId, userId);

    if (existante) {
      db.prepare('UPDATE participations SET montant = montant + ?, role = COALESCE(role, ?) WHERE id = ?').run(
        montant,
        role,
        existante.id
      );
    } else {
      db.prepare(
        'INSERT INTO participations (partie_id, user_id, graine_client, montant, role) VALUES (?, ?, ?, ?, ?)'
      ).run(partieId, userId, fair.nouvelleGraine().slice(0, 16), montant, role);
    }

    if (partie.mode === 'argent') {
      miser(userId, partieId, montant);
    }
    return true;
  });
}

/** Enregistre le choix d'un joueur (un nombre, un moment d'encaissement, etc.). */
export function choisir(partieId, userId, choix) {
  const partie = lire(partieId);
  if (!partie) throw new Error('Partie introuvable');
  if (partie.etat !== 'ouverte') throw new Error('Les choix sont clos');

  const { changes } = db
    .prepare('UPDATE participations SET choix = ? WHERE partie_id = ? AND user_id = ?')
    .run(JSON.stringify(choix), partieId, userId);
  if (changes === 0) throw new Error('Tu ne participes pas à cette partie');
  return true;
}

/**
 * Ferme les inscriptions. Si le quorum n'est pas atteint, la partie est
 * annulée et tout le monde est remboursé — jamais de cagnotte bloquée.
 */
export function verrouiller(partieId) {
  return transaction(() => {
    const partie = lire(partieId);
    if (!partie) throw new Error('Partie introuvable');
    if (partie.etat !== 'ouverte') return partie;

    const nombre = participants(partieId).length;
    if (nombre < partie.joueurs_min) {
      rembourser(partieId); // sans effet si le séquestre est déjà vide
      db.prepare(
        "UPDATE parties SET etat = 'annulee', ferme_le = datetime('now'), resultat = ? WHERE id = ?"
      ).run(JSON.stringify({ raison: 'quorum_non_atteint', joueurs: nombre }), partieId);
      return lire(partieId);
    }

    db.prepare("UPDATE parties SET etat = 'verrouillee', ferme_le = datetime('now') WHERE id = ?").run(
      partieId
    );
    return lire(partieId);
  });
}

/**
 * Distribue la cagnotte et révèle la graine serveur.
 * @param {Array<{userId: number, parts: number}>} gagnants
 */
export function reglerPartie(partieId, gagnants, resultat = {}) {
  return transaction(() => {
    const partie = lire(partieId);
    if (!partie) throw new Error('Partie introuvable');
    if (partie.etat !== 'verrouillee') throw new Error('La partie n’est pas prête à être réglée');

    // On se fie au solde réel du séquestre, pas à partie.mise : les jeux à mise
    // variable (le craps) laissent partie.mise à zéro et alimentent le
    // séquestre via engager().
    const avant = solde(compteSequestre(partieId));
    if (avant > 0 && gagnants.length > 0) {
      regler(partieId, partie.commission_bp, gagnants);

      const commission = Math.floor((avant * partie.commission_bp) / 10_000);
      const distribue = avant - commission;
      const partsTotales = gagnants.reduce((s, g) => s + g.parts, 0);
      for (const g of gagnants) {
        const part = Math.floor((distribue * g.parts) / partsTotales);
        db.prepare('UPDATE participations SET gain = ? WHERE partie_id = ? AND user_id = ?').run(
          part,
          partieId,
          g.userId
        );
      }
    }

    db.prepare(
      `UPDATE parties
          SET etat = 'reglee', graine_revelee = 1, resultat = ?
        WHERE id = ?`
    ).run(JSON.stringify(resultat), partieId);

    return lire(partieId);
  });
}

/** Ce qu'on expose au joueur : la graine serveur reste cachée tant que la partie n'est pas réglée. */
export function versClient(partie) {
  if (!partie) return null;
  return {
    id: partie.id,
    jeu: partie.jeu,
    mode: partie.mode,
    etat: partie.etat,
    mise: partie.mise,
    joueursMin: partie.joueurs_min,
    commissionBp: partie.commission_bp,
    empreinteGraine: partie.empreinte_graine,
    graineServeur: partie.graine_revelee ? partie.graine_serveur : null,
    resultat: partie.resultat ? JSON.parse(partie.resultat) : null,
  };
}
