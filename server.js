// Serveur HTTP + API + fichiers statiques.
// Le temps réel est branché par src/realtime.js, les jeux s'enregistrent
// dans src/games/index.js.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inscrire, connecter, fermerSession, joueurDeSession, purgerSessions } from './src/auth.js';
import { verifierIntegrite } from './src/ledger.js';
import { attacher } from './src/realtime.js';
import { jeux } from './src/games/index.js';

const racine = dirname(fileURLToPath(import.meta.url));
const dossierPublic = join(racine, 'public');
const PORT = Number(process.env.PORT) || 3000;
const EN_PROD = process.env.NODE_ENV === 'production';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function lireCookie(entete, nom) {
  if (!entete) return null;
  for (const morceau of entete.split(';')) {
    const [cle, ...reste] = morceau.trim().split('=');
    if (cle === nom) return decodeURIComponent(reste.join('='));
  }
  return null;
}

function repondre(reponse, code, corps, entetes = {}) {
  reponse.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...entetes });
  reponse.end(JSON.stringify(corps));
}

async function lireCorps(requete) {
  const morceaux = [];
  let taille = 0;
  for await (const morceau of requete) {
    taille += morceau.length;
    if (taille > 64 * 1024) throw new Error('Requête trop volumineuse');
    morceaux.push(morceau);
  }
  if (morceaux.length === 0) return {};
  return JSON.parse(Buffer.concat(morceaux).toString());
}

function cookieSession(jeton, jours = 30) {
  const parties = [
    `session=${jeton}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${jours * 24 * 3600}`,
  ];
  if (EN_PROD) parties.push('Secure');
  return parties.join('; ');
}

async function servirStatique(chemin, reponse) {
  // normalize + préfixe obligatoire : empêche ../../ de sortir de public/
  const demande = chemin === '/' ? '/index.html' : chemin;
  const complet = normalize(join(dossierPublic, demande));
  if (!complet.startsWith(dossierPublic)) {
    return repondre(reponse, 403, { erreur: 'Interdit' });
  }

  try {
    const contenu = await readFile(complet);
    reponse.writeHead(200, { 'Content-Type': TYPES[extname(complet)] ?? 'application/octet-stream' });
    reponse.end(contenu);
  } catch {
    repondre(reponse, 404, { erreur: 'Introuvable' });
  }
}

const serveur = createServer(async (requete, reponse) => {
  const url = new URL(requete.url, `http://${requete.headers.host}`);
  const chemin = url.pathname;

  if (!chemin.startsWith('/api/')) {
    return servirStatique(chemin, reponse);
  }

  try {
    if (chemin === '/api/inscription' && requete.method === 'POST') {
      const { pseudo, motDePasse } = await lireCorps(requete);
      const userId = await inscrire(pseudo, motDePasse);
      const jeton = (await connecter(pseudo, motDePasse));
      return repondre(reponse, 201, { joueur: joueurDeSession(jeton) }, { 'Set-Cookie': cookieSession(jeton) });
    }

    if (chemin === '/api/connexion' && requete.method === 'POST') {
      const { pseudo, motDePasse } = await lireCorps(requete);
      const jeton = await connecter(pseudo, motDePasse);
      return repondre(reponse, 200, { joueur: joueurDeSession(jeton) }, { 'Set-Cookie': cookieSession(jeton) });
    }

    if (chemin === '/api/deconnexion' && requete.method === 'POST') {
      fermerSession(lireCookie(requete.headers.cookie, 'session'));
      return repondre(reponse, 200, { ok: true }, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0' });
    }

    if (chemin === '/api/moi') {
      const joueur = joueurDeSession(lireCookie(requete.headers.cookie, 'session'));
      return repondre(reponse, joueur ? 200 : 401, joueur ? { joueur } : { erreur: 'Non connecté' });
    }

    if (chemin === '/api/jeux') {
      return repondre(reponse, 200, {
        jeux: Object.entries(jeux).map(([cle, jeu]) => ({
          cle,
          nom: jeu.nom,
          resume: jeu.resume,
          joueursMin: jeu.joueursMin,
          soloPossible: jeu.soloPossible ?? false,
          lien: jeu.lien ?? null,
        })),
      });
    }

    return repondre(reponse, 404, { erreur: 'Route inconnue' });
  } catch (erreur) {
    return repondre(reponse, 400, { erreur: erreur.message });
  }
});

attacher(serveur, jeux);

// Le grand livre doit être équilibré au démarrage. S'il ne l'est pas, il y a
// eu corruption : on refuse de démarrer plutôt que d'aggraver le problème.
const integrite = verifierIntegrite();
if (!integrite.equilibre) {
  console.error('ARRÊT — grand livre déséquilibré :', integrite);
  process.exit(1);
}

purgerSessions();
setInterval(purgerSessions, 6 * 3600 * 1000).unref();

serveur.listen(PORT, () => {
  console.log(`Serveur de jeux démarré sur http://localhost:${PORT}`);
});
