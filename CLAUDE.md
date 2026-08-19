# jeux — plateforme de jeux

Un **socle commun** (comptes, grand livre, provably fair, cycle de partie) sur lequel
se branchent des **modules de jeu**. Premier module en place : le **craps**.

## Démarrer
Configuration `jeux` dans `.claude/launch.json` (port 3100, `autoPort`).
Sinon `npm start` — port 3000 par défaut, `PORT` pour changer.
Tests : `npm test` (runner intégré de Node, dossier `test/`).

## Structure
| Fichier | Rôle |
|---|---|
| `server.js` | HTTP + API + fichiers statiques |
| `src/auth.js` | Comptes et sessions — mots de passe hachés en scrypt |
| `src/db.js` | Base et schéma via `node:sqlite` (intégré, rien à compiler) |
| `src/ledger.js` | Grand livre en double entrée |
| `src/fair.js` | Provably fair : engagement SHA-256 + graine du joueur |
| `src/parties.js` | Cycle de vie : ouverte → verrouillée → réglée (ou annulée) |
| `src/realtime.js` | Hub WebSocket, joueurs regroupés par salon |
| `src/games/` | Modules de jeu, enregistrés dans `index.js` |
| `public/` | `index.html`, `craps.html` |

## Règles non négociables
- **Les montants sont des entiers de jetons.** Jamais de nombre à virgule sur de
  l'argent : les erreurs d'arrondi finissent toujours par créer ou détruire de la valeur.
- **Toute transaction somme à zéro** dans le grand livre. Un bogue peut donner des
  jetons au mauvais joueur, il ne peut pas en inventer.
- **Le client n'envoie que des intentions** (« je rejoins », « je mise »). Aucune
  décision, aucun montant, aucun résultat ne vient du navigateur — tout est
  recalculé côté serveur.
- **Le mode gratuit suit exactement le même code** que le mode payant, mise à zéro.
  Un mode gratuit qui diverge finit par cacher un bogue qui n'apparaît qu'en payant.

## Conventions
Code, commentaires et identifiants **en français** (`inscrire`, `joueurDeSession`,
`verifierIntegrite`). ES modules (`"type": "module"`). Une seule dépendance : `ws` —
garder ce dépôt le plus proche possible du Node standard.
