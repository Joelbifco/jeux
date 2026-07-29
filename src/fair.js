// Provably fair : le joueur peut vérifier lui-même qu'on n'a pas triché.
//
// Le principe, en trois temps :
//   1. Avant la partie, le serveur tire une graine secrète et publie son
//      empreinte SHA-256. L'empreinte l'engage : il ne peut plus changer la
//      graine sans que ça se voie.
//   2. Les joueurs fournissent leur propre graine, que le serveur ne contrôle
//      pas. Le résultat dépend des deux — donc ni le serveur ni le joueur ne
//      peut le décider seul.
//   3. Après la partie, le serveur révèle sa graine. N'importe qui peut
//      recalculer l'empreinte et le résultat, et confirmer qu'ils concordent.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Tire une graine serveur secrète (32 octets). */
export function nouvelleGraine() {
  return randomBytes(32).toString('hex');
}

/** L'engagement publié avant la partie. */
export function empreinte(graine) {
  return createHash('sha256').update(graine).digest('hex');
}

/**
 * Le tirage. Combine la graine serveur (secrète), la graine client (publique)
 * et un compteur, pour produire un condensé déterministe.
 */
export function tirage(graineServeur, graineClient, nonce = 0) {
  return createHmac('sha256', graineServeur)
    .update(`${graineClient}:${nonce}`)
    .digest('hex');
}

/**
 * Convertit un tirage en flottant dans [0, 1).
 * On lit 52 bits, soit exactement la précision d'un double — au-delà, les bits
 * supplémentaires seraient perdus à l'arrondi et fausseraient la distribution.
 */
export function versFlottant(condense) {
  return Number.parseInt(condense.slice(0, 13), 16) / 2 ** 52;
}

/**
 * Entier uniforme dans [0, borne).
 * On rejette les valeurs de la dernière tranche incomplète : un simple modulo
 * rendrait les petits nombres légèrement plus probables (biais du modulo).
 */
export function versEntier(graineServeur, graineClient, nonce, borne) {
  const maxUtilisable = 2 ** 52 - (2 ** 52 % borne);
  for (let essai = 0; essai < 100; essai++) {
    const brut = Number.parseInt(tirage(graineServeur, graineClient, `${nonce}:${essai}`).slice(0, 13), 16);
    if (brut < maxUtilisable) return brut % borne;
  }
  // Probabilité astronomiquement faible ; on ne laisse pas la boucle traîner.
  throw new Error('Tirage impossible après 100 essais');
}

/** Mélange vérifiable d'un tableau (Fisher-Yates alimenté par le tirage). */
export function melanger(tableau, graineServeur, graineClient, nonce = 0) {
  const copie = [...tableau];
  for (let i = copie.length - 1; i > 0; i--) {
    const j = versEntier(graineServeur, graineClient, `${nonce}:melange:${i}`, i + 1);
    [copie[i], copie[j]] = [copie[j], copie[i]];
  }
  return copie;
}

/**
 * Vérification indépendante, telle qu'un joueur la ferait.
 * Comparaison à temps constant pour ne pas laisser fuir d'information.
 */
export function verifier(graineRevelee, empreintePubliee) {
  const calculee = Buffer.from(empreinte(graineRevelee), 'hex');
  const publiee = Buffer.from(empreintePubliee, 'hex');
  if (calculee.length !== publiee.length) return false;
  return timingSafeEqual(calculee, publiee);
}
