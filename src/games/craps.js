// Craps de rue — orchestration d'une table.
//
// Une table par mode ('gratuit' ou 'argent'). Le cycle :
//
//   attente     un joueur se déclare tireur et pose sa mise
//   couverture  les autres couvrent, jusqu'à concurrence de la mise du tireur
//   lancers     le tireur lance ; come out, puis son point
//   reglement   la cagnotte est distribuée, la graine révélée, le tireur passe
//
// Règle d'argent : le tireur ne joue que ce qui a été couvert contre lui.
// S'il pose 500 et qu'on ne couvre que 300, on lui rend 200 avant de jouer.
// La maison ne couvre jamais — elle prélève une cote sur la cagnotte, rien de plus.

import { db } from '../db.js';
import * as parties from '../parties.js';
import { rembourserPartiel, soldeJoueur } from '../ledger.js';
import { diffuser, envoyer } from '../realtime.js';
import { lancer, somme, estSnakeEyes } from './des.js';
import { evaluer, libelle, ISSUE } from './craps-regles.js';

const DELAI_COUVERTURE_MS = 25_000;
const DELAI_LANCER_MS = 30_000; // si le tireur décroche, on lance à sa place
const MISE_MIN = 10;
const MISE_MAX = 5000;
const COMMISSION_BP = 500; // 5 %

const tables = new Map();

function table(mode) {
  if (!tables.has(mode)) {
    tables.set(mode, {
      mode,
      phase: 'attente',
      partieId: null,
      tireur: null,
      miseTireur: 0,
      couvertures: new Map(), // userId -> montant
      point: null,
      nonce: 0,
      dernierLancer: null,
      minuterie: null,
    });
  }
  return tables.get(mode);
}

const salon = (mode) => `craps:${mode}`;

function armer(t, delai, action) {
  clearTimeout(t.minuterie);
  t.minuterie = setTimeout(() => {
    try {
      action();
    } catch (erreur) {
      console.error('craps — minuterie :', erreur.message);
    }
  }, delai);
  t.minuterie.unref?.();
}

function totalCouvert(t) {
  return [...t.couvertures.values()].reduce((somme, montant) => somme + montant, 0);
}

function pseudoDe(userId) {
  return db.prepare('SELECT pseudo FROM users WHERE id = ?').get(userId)?.pseudo ?? '?';
}

function etatPublic(t) {
  return {
    type: 'etat',
    jeu: 'craps',
    mode: t.mode,
    phase: t.phase,
    tireur: t.tireur ? { id: t.tireur, pseudo: pseudoDe(t.tireur) } : null,
    miseTireur: t.miseTireur,
    couvert: totalCouvert(t),
    couvreurs: [...t.couvertures].map(([id, montant]) => ({ pseudo: pseudoDe(id), montant })),
    point: t.point,
    dernierLancer: t.dernierLancer,
    cagnotte: totalCouvert(t) * 2,
    miseMin: MISE_MIN,
    miseMax: MISE_MAX,
  };
}

function publier(t, extra = null) {
  diffuser(salon(t.mode), etatPublic(t));
  if (extra) diffuser(salon(t.mode), extra);
}

function reinitialiser(t) {
  clearTimeout(t.minuterie);
  Object.assign(t, {
    phase: 'attente',
    partieId: null,
    tireur: null,
    miseTireur: 0,
    couvertures: new Map(),
    point: null,
    nonce: 0,
    dernierLancer: null,
    minuterie: null,
  });
}

// --- Actions du joueur ---------------------------------------------------

function tirer(t, joueur, montant) {
  if (t.phase !== 'attente') throw new Error('Une manche est déjà en cours');
  if (!Number.isSafeInteger(montant) || montant < MISE_MIN || montant > MISE_MAX) {
    throw new Error(`La mise doit être entre ${MISE_MIN} et ${MISE_MAX} jetons`);
  }
  if (t.mode === 'argent' && soldeJoueur(joueur.id) < montant) {
    throw new Error('Solde insuffisant');
  }

  // En gratuit, un joueur seul peut s'entraîner : pas de quorum à atteindre.
  const partie = parties.ouvrirPartie({
    jeu: 'craps',
    mode: t.mode,
    mise: 0,
    joueursMin: t.mode === 'gratuit' ? 1 : 2,
    commissionBp: COMMISSION_BP,
  });

  parties.engager(partie.id, joueur.id, montant, 'tireur');

  t.partieId = partie.id;
  t.tireur = joueur.id;
  t.miseTireur = montant;
  t.phase = 'couverture';

  armer(t, DELAI_COUVERTURE_MS, () => cloturerCouverture(t));
  publier(t, {
    type: 'annonce',
    message: `${joueur.pseudo} tire pour ${montant} jetons. Qui couvre ?`,
  });
}

function couvrir(t, joueur, montant) {
  if (t.phase !== 'couverture') throw new Error('Ce n’est pas le moment de couvrir');
  if (joueur.id === t.tireur) throw new Error('Le tireur ne peut pas se couvrir lui-même');

  const restant = t.miseTireur - totalCouvert(t);
  if (restant <= 0) throw new Error('La mise est déjà entièrement couverte');
  if (!Number.isSafeInteger(montant) || montant <= 0) throw new Error('Montant invalide');
  if (montant > restant) throw new Error(`Il ne reste que ${restant} jetons à couvrir`);
  if (t.mode === 'argent' && soldeJoueur(joueur.id) < montant) {
    throw new Error('Solde insuffisant');
  }

  parties.engager(t.partieId, joueur.id, montant, 'couvreur');
  t.couvertures.set(joueur.id, (t.couvertures.get(joueur.id) ?? 0) + montant);

  publier(t, { type: 'annonce', message: `${joueur.pseudo} couvre ${montant} jetons.` });

  if (totalCouvert(t) >= t.miseTireur) cloturerCouverture(t);
}

/** Fin des mises : on verrouille, on rend l'excédent non couvert, on passe aux dés. */
function cloturerCouverture(t) {
  if (t.phase !== 'couverture') return;
  clearTimeout(t.minuterie);

  const partie = parties.verrouiller(t.partieId);

  if (partie.etat === 'annulee') {
    publier(t, {
      type: 'annonce',
      message: 'Personne n’a couvert — manche annulée, mises rendues.',
    });
    reinitialiser(t);
    publier(t);
    return;
  }

  const couvert = totalCouvert(t);
  const nonCouvert = t.miseTireur - couvert;
  if (nonCouvert > 0 && t.mode === 'argent') {
    rembourserPartiel(t.partieId, t.tireur, nonCouvert);
  }
  if (nonCouvert > 0) {
    t.miseTireur = couvert;
    publier(t, {
      type: 'annonce',
      message: `${nonCouvert} jetons non couverts sont rendus au tireur.`,
    });
  }

  t.phase = 'lancers';
  armer(t, DELAI_LANCER_MS, () => lancerDes(t, t.tireur, true));
  publier(t, { type: 'annonce', message: 'Les mises sont faites. Au tireur de lancer.' });
}

function lancerDes(t, userId, automatique = false) {
  if (t.phase !== 'lancers') throw new Error('Ce n’est pas le moment de lancer');
  if (userId !== t.tireur) throw new Error('Seul le tireur lance');

  clearTimeout(t.minuterie);

  const partie = parties.lire(t.partieId);
  const participation = db
    .prepare('SELECT graine_client FROM participations WHERE partie_id = ? AND user_id = ?')
    .get(t.partieId, t.tireur);

  t.nonce += 1;
  const des = lancer(partie.graine_serveur, participation.graine_client, t.nonce, 2);
  const total = somme(des);
  const resultat = evaluer(total, t.point);

  t.dernierLancer = {
    des,
    total,
    snakeEyes: estSnakeEyes(des),
    automatique,
    issue: resultat.issue,
  };

  if (resultat.issue === ISSUE.POINT) {
    t.point = resultat.point;
    armer(t, DELAI_LANCER_MS, () => lancerDes(t, t.tireur, true));
    publier(t, { type: 'annonce', message: `Le point est ${resultat.point}. Le tireur relance.` });
    return;
  }

  if (resultat.issue === ISSUE.CONTINUE) {
    armer(t, DELAI_LANCER_MS, () => lancerDes(t, t.tireur, true));
    publier(t, { type: 'annonce', message: `${total} — on relance.` });
    return;
  }

  regler(t, resultat);
}

function regler(t, resultat) {
  const tireurGagne = resultat.issue === ISSUE.GAGNE;

  const gagnants = tireurGagne
    ? [{ userId: t.tireur, parts: 1 }]
    : [...t.couvertures].map(([userId, montant]) => ({ userId, parts: montant }));

  parties.reglerPartie(t.partieId, gagnants, {
    issue: resultat.issue,
    raison: resultat.raison,
    dernierLancer: t.dernierLancer,
    point: t.point,
  });

  const vue = parties.versClient(parties.lire(t.partieId));

  t.phase = 'reglement';
  publier(t, {
    type: 'fin',
    message: libelle(resultat.raison),
    tireurGagne,
    cagnotte: totalCouvert(t) * 2,
    commissionBp: COMMISSION_BP,
    preuve: {
      empreinteGraine: vue.empreinteGraine,
      graineServeur: vue.graineServeur,
      lancers: t.nonce,
    },
  });

  const ancienTireur = t.tireur;
  setTimeout(() => {
    reinitialiser(t);
    publier(t, {
      type: 'annonce',
      message: `Table libre. ${pseudoDe(ancienTireur)} passe les dés.`,
    });
  }, 6000).unref?.();
}

// --- Interface avec le hub temps réel ------------------------------------

export const craps = {
  nom: 'Craps de rue',
  resume:
    '7 ou 11 gagne, snake eyes perd. Sinon tu vises ton point avant le 7. Les joueurs se couvrent entre eux.',
  joueursMin: 2,
  soloPossible: true, // en mode gratuit, pour s'entraîner
  commissionBp: COMMISSION_BP,
  lien: '/craps.html',

  surEntree(connexion, message) {
    const t = table(message.mode === 'argent' ? 'argent' : 'gratuit');
    envoyer(connexion, etatPublic(t));
  },

  surMessage(connexion, message) {
    const mode = connexion.salon.split(':')[1];
    const t = table(mode);
    const joueur = connexion.joueur;

    switch (message.action) {
      case 'tirer':
        return tirer(t, joueur, Number(message.montant));
      case 'couvrir':
        return couvrir(t, joueur, Number(message.montant));
      case 'commencer':
        // Le tireur déclare « les jeux sont faits » sans attendre la minuterie.
        if (joueur.id !== t.tireur) throw new Error('Seul le tireur clôt les mises');
        if (t.phase !== 'couverture') throw new Error('Les mises sont déjà closes');
        return cloturerCouverture(t);
      case 'lancer':
        return lancerDes(t, joueur.id);
      case 'etat':
        return envoyer(connexion, etatPublic(t));
      default:
        throw new Error('Action inconnue');
    }
  },
};
