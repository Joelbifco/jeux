// Hub temps réel.
//
// Les joueurs sont regroupés par « salon » (une table de jeu). Le serveur
// diffuse l'état à tout le salon plutôt que de laisser chaque client
// interroger l'API en boucle.
//
// Principe de sécurité : le client n'envoie jamais que des intentions
// ('je rejoins', 'je choisis 42'). Aucune décision de jeu, aucun montant, aucun
// résultat ne vient du navigateur — tout est recalculé côté serveur.

import { WebSocketServer } from 'ws';
import { joueurDeSession } from './auth.js';

const salons = new Map(); // nom du salon -> Set de connexions

function lireCookie(entete, nom) {
  if (!entete) return null;
  for (const morceau of entete.split(';')) {
    const [cle, ...reste] = morceau.trim().split('=');
    if (cle === nom) return decodeURIComponent(reste.join('='));
  }
  return null;
}

export function diffuser(salon, message) {
  const membres = salons.get(salon);
  if (!membres) return;
  const charge = JSON.stringify(message);
  for (const connexion of membres) {
    if (connexion.readyState === connexion.OPEN) connexion.send(charge);
  }
}

export function envoyer(connexion, message) {
  if (connexion.readyState === connexion.OPEN) {
    connexion.send(JSON.stringify(message));
  }
}

export function membresDuSalon(salon) {
  return [...(salons.get(salon) ?? [])].map((c) => c.joueur);
}

function entrerDansSalon(connexion, salon) {
  quitterSalon(connexion);
  if (!salons.has(salon)) salons.set(salon, new Set());
  salons.get(salon).add(connexion);
  connexion.salon = salon;
}

function quitterSalon(connexion) {
  if (!connexion.salon) return;
  const membres = salons.get(connexion.salon);
  if (membres) {
    membres.delete(connexion);
    if (membres.size === 0) salons.delete(connexion.salon);
  }
  connexion.salon = null;
}

/**
 * @param {import('node:http').Server} serveurHttp
 * @param {Record<string, {surMessage: Function, surEntree?: Function, surSortie?: Function}>} jeux
 */
export function attacher(serveurHttp, jeux = {}) {
  const wss = new WebSocketServer({ server: serveurHttp, path: '/ws' });

  wss.on('connection', (connexion, requete) => {
    const joueur = joueurDeSession(lireCookie(requete.headers.cookie, 'session'));
    if (!joueur) {
      envoyer(connexion, { type: 'erreur', message: 'Connexion requise' });
      connexion.close();
      return;
    }

    connexion.joueur = joueur;
    connexion.salon = null;
    envoyer(connexion, { type: 'bienvenue', joueur });

    connexion.on('message', (brut) => {
      let message;
      try {
        message = JSON.parse(brut.toString());
      } catch {
        return envoyer(connexion, { type: 'erreur', message: 'Message illisible' });
      }

      try {
        if (message.type === 'entrer') {
          const jeu = jeux[message.jeu];
          if (!jeu) throw new Error('Jeu inconnu');
          entrerDansSalon(connexion, `${message.jeu}:${message.mode ?? 'gratuit'}`);
          jeu.surEntree?.(connexion, message);
          return;
        }

        if (!connexion.salon) throw new Error('Entre d’abord dans un salon');
        const nomJeu = connexion.salon.split(':')[0];
        jeux[nomJeu]?.surMessage(connexion, message);
      } catch (erreur) {
        envoyer(connexion, { type: 'erreur', message: erreur.message });
      }
    });

    connexion.on('close', () => {
      const nomJeu = connexion.salon?.split(':')[0];
      if (nomJeu) jeux[nomJeu]?.surSortie?.(connexion);
      quitterSalon(connexion);
    });
  });

  return wss;
}
