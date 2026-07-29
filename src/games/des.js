// Lancers de dés vérifiables.
//
// Chaque dé sort du module provably fair : le joueur peut recalculer
// exactement les mêmes valeurs après la partie, à partir de la graine serveur
// révélée et de sa propre graine.

import { versEntier } from '../fair.js';

/**
 * @param {string} graineServeur  secrète jusqu'au règlement
 * @param {string} graineClient   fournie par le joueur
 * @param {string|number} nonce   distinct à chaque lancer d'une même partie
 * @param {number} nombre         combien de dés
 * @returns {number[]} valeurs de 1 à 6
 */
export function lancer(graineServeur, graineClient, nonce, nombre = 2) {
  return Array.from({ length: nombre }, (_, index) =>
    versEntier(graineServeur, graineClient, `${nonce}:de:${index}`, 6) + 1
  );
}

export const somme = (des) => des.reduce((total, de) => total + de, 0);

/** Vrai si le lancer est un double 1 — les yeux de serpent. */
export const estSnakeEyes = (des) => des.length === 2 && des[0] === 1 && des[1] === 1;
