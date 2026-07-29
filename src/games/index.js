// Registre des jeux.
//
// Chaque jeu est un module autonome qui expose :
//   nom, resume, joueursMin, soloPossible, commissionBp
//   surEntree(connexion, message)   — un joueur entre dans le salon (facultatif)
//   surMessage(connexion, message)  — une intention du joueur
//   surSortie(connexion)            — déconnexion (facultatif)
//
// Le socle (comptes, grand livre, séquestre, provably fair) est déjà fait :
// un jeu n'a qu'à décider qui gagne, et appeler parties.reglerPartie().

import { envoyer } from '../realtime.js';
import { craps } from './craps.js';

/** Gabarit temporaire tant que le module du jeu n'est pas écrit. */
function aVenir(meta) {
  return {
    ...meta,
    surEntree(connexion) {
      envoyer(connexion, { type: 'info', message: `« ${meta.nom} » arrive bientôt.` });
    },
    surMessage(connexion) {
      envoyer(connexion, { type: 'erreur', message: 'Ce jeu n’est pas encore ouvert.' });
    },
  };
}

export const jeux = {
  craps,

  'nombre-unique': aVenir({
    nom: 'Le plus petit nombre unique',
    resume:
      'Choisis un nombre entre 1 et 100. Gagne le plus petit nombre que personne d’autre n’a choisi.',
    joueursMin: 3,
    soloPossible: false,
    commissionBp: 500,
  }),

  'dernier-saut': aVenir({
    nom: 'Le dernier à sauter',
    resume:
      'Le multiplicateur monte, puis s’écrase. Encaisse avant — et le dernier à sortir touche un bonus.',
    joueursMin: 2,
    soloPossible: true,
    commissionBp: 500,
  }),

  duel: aVenir({
    nom: 'Le duel',
    resume: 'Deux joueurs, mises égales, un tirage vérifiable. Le gagnant prend tout.',
    joueursMin: 2,
    soloPossible: false,
    commissionBp: 500,
  }),
};
