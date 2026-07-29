// Tests du socle : ce qui doit rester vrai quoi qu'il arrive aux jeux.
// Base vierge à chaque exécution.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEUX_DB = join(mkdtempSync(join(tmpdir(), 'jeux-test-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

const { inscrire } = await import('../src/auth.js');
const ledger = await import('../src/ledger.js');
const parties = await import('../src/parties.js');
const fair = await import('../src/fair.js');

const joueurs = {};
for (const nom of ['alice', 'bruno', 'chloe']) {
  joueurs[nom] = await inscrire(nom, 'motdepasse123');
}

test('la dotation d’accueil crédite le joueur', () => {
  assert.equal(ledger.soldeJoueur(joueurs.alice), 5000);
});

test('une transaction déséquilibrée est refusée', () => {
  assert.throws(
    () =>
      ledger.passer('test', null, [
        { compte: ledger.compteJoueur(joueurs.alice), montant: 100 },
        { compte: ledger.compteMaison(), montant: -50 },
      ]),
    /déséquilibrée/
  );
});

test('un joueur ne peut pas passer sous zéro', () => {
  assert.throws(
    () =>
      ledger.passer('test', null, [
        { compte: ledger.compteJoueur(joueurs.alice), montant: -999_999 },
        { compte: ledger.compteMaison(), montant: +999_999 },
      ]),
    /Solde insuffisant/
  );
  assert.equal(ledger.soldeJoueur(joueurs.alice), 5000);
});

test('les montants à virgule sont refusés', () => {
  assert.throws(
    () =>
      ledger.passer('test', null, [
        { compte: ledger.compteJoueur(joueurs.alice), montant: -10.5 },
        { compte: ledger.compteMaison(), montant: +10.5 },
      ]),
    /non entier/
  );
});

test('une partie payante répartit la cagnotte et prélève la commission', () => {
  const partie = parties.ouvrirPartie({ jeu: 'test', mode: 'argent', mise: 100, joueursMin: 3 });

  parties.rejoindre(partie.id, joueurs.alice);
  parties.rejoindre(partie.id, joueurs.bruno);
  parties.rejoindre(partie.id, joueurs.chloe);

  assert.equal(ledger.soldeJoueur(joueurs.alice), 4900);
  assert.equal(ledger.solde(ledger.compteSequestre(partie.id)), 300);

  const maisonAvant = ledger.solde(ledger.compteMaison());
  parties.verrouiller(partie.id);
  parties.reglerPartie(partie.id, [{ userId: joueurs.alice, parts: 1 }]);

  // 300 de cagnotte, 5 % de commission = 15, donc 285 au gagnant.
  assert.equal(ledger.solde(ledger.compteMaison()) - maisonAvant, 15);
  assert.equal(ledger.soldeJoueur(joueurs.alice), 4900 + 285);
  assert.equal(ledger.solde(ledger.compteSequestre(partie.id)), 0);
});

test('faute de quorum, la partie est annulée et tout le monde remboursé', () => {
  const avant = ledger.soldeJoueur(joueurs.bruno);
  const partie = parties.ouvrirPartie({ jeu: 'test', mode: 'argent', mise: 250, joueursMin: 3 });

  parties.rejoindre(partie.id, joueurs.bruno);
  assert.equal(ledger.soldeJoueur(joueurs.bruno), avant - 250);

  const apres = parties.verrouiller(partie.id);
  assert.equal(apres.etat, 'annulee');
  assert.equal(ledger.soldeJoueur(joueurs.bruno), avant);
  assert.equal(ledger.solde(ledger.compteSequestre(partie.id)), 0);
});

test('une partie gratuite ne bouge aucun jeton', () => {
  const avant = ledger.soldeJoueur(joueurs.chloe);
  const partie = parties.ouvrirPartie({ jeu: 'test', mode: 'gratuit', joueursMin: 1 });

  parties.rejoindre(partie.id, joueurs.chloe);
  parties.verrouiller(partie.id);
  parties.reglerPartie(partie.id, [{ userId: joueurs.chloe, parts: 1 }]);

  assert.equal(ledger.soldeJoueur(joueurs.chloe), avant);
});

test('la graine serveur reste cachée jusqu’au règlement', () => {
  const partie = parties.ouvrirPartie({ jeu: 'test', mode: 'gratuit', joueursMin: 1 });
  assert.equal(parties.versClient(parties.lire(partie.id)).graineServeur, null);

  parties.rejoindre(partie.id, joueurs.alice);
  parties.verrouiller(partie.id);
  parties.reglerPartie(partie.id, [{ userId: joueurs.alice, parts: 1 }]);

  const vue = parties.versClient(parties.lire(partie.id));
  assert.ok(vue.graineServeur);
  assert.ok(fair.verifier(vue.graineServeur, vue.empreinteGraine));
});

test('le tirage est reproductible et le mélange sans biais grossier', () => {
  const graine = fair.nouvelleGraine();
  assert.equal(fair.tirage(graine, 'client', 1), fair.tirage(graine, 'client', 1));
  assert.notEqual(fair.tirage(graine, 'client', 1), fair.tirage(graine, 'client', 2));

  const compteurs = new Array(6).fill(0);
  for (let i = 0; i < 6000; i++) compteurs[fair.versEntier(graine, 'c', i, 6)]++;
  for (const n of compteurs) assert.ok(n > 850 && n < 1150, `distribution suspecte : ${compteurs}`);
});

test('le grand livre reste équilibré après tout ça', () => {
  const { equilibre, total } = ledger.verifierIntegrite();
  assert.ok(equilibre, `grand livre déséquilibré : total = ${total}`);
});
