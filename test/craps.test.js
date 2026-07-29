// Règles du craps et lancers de dés.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JEUX_DB = join(mkdtempSync(join(tmpdir(), 'jeux-craps-')), 'test.db');

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluerComeOut, evaluerPoint, ISSUE } from '../src/games/craps-regles.js';
import { lancer, somme, estSnakeEyes } from '../src/games/des.js';
import { nouvelleGraine } from '../src/fair.js';

test('come out : 7 et 11 gagnent', () => {
  for (const total of [7, 11]) {
    assert.equal(evaluerComeOut(total).issue, ISSUE.GAGNE);
  }
});

test('come out : snake eyes est identifié distinctement', () => {
  const resultat = evaluerComeOut(2);
  assert.equal(resultat.issue, ISSUE.PERD);
  assert.equal(resultat.raison, 'snake-eyes');
});

test('come out : 3 et 12 perdent aussi', () => {
  for (const total of [3, 12]) {
    assert.equal(evaluerComeOut(total).issue, ISSUE.PERD);
  }
});

test('come out : tout le reste établit le point', () => {
  for (const total of [4, 5, 6, 8, 9, 10]) {
    const resultat = evaluerComeOut(total);
    assert.equal(resultat.issue, ISSUE.POINT);
    assert.equal(resultat.point, total);
  }
});

test('phase de point : refaire son point gagne, le 7 perd', () => {
  assert.equal(evaluerPoint(6, 6).issue, ISSUE.GAGNE);
  assert.equal(evaluerPoint(7, 6).issue, ISSUE.PERD);
  assert.equal(evaluerPoint(7, 6).raison, 'seven-out');
  assert.equal(evaluerPoint(5, 6).issue, ISSUE.CONTINUE);
});

test('en phase de point, le 11 ne gagne plus', () => {
  // Piège classique : 11 gagne au come out, mais ne vaut rien ensuite.
  assert.equal(evaluerPoint(11, 8).issue, ISSUE.CONTINUE);
});

test('en phase de point, le 2 ne perd plus', () => {
  assert.equal(evaluerPoint(2, 8).issue, ISSUE.CONTINUE);
});

test('les dés tombent bien entre 1 et 6, et le lancer est reproductible', () => {
  const graine = nouvelleGraine();
  for (let i = 0; i < 500; i++) {
    const des = lancer(graine, 'client', i, 2);
    assert.equal(des.length, 2);
    for (const de of des) assert.ok(de >= 1 && de <= 6, `dé hors bornes : ${de}`);
  }
  assert.deepEqual(lancer(graine, 'c', 42, 2), lancer(graine, 'c', 42, 2));
});

test('snake eyes est détecté', () => {
  assert.ok(estSnakeEyes([1, 1]));
  assert.ok(!estSnakeEyes([1, 2]));
  assert.ok(!estSnakeEyes([1, 1, 1]));
});

test('la distribution des sommes suit bien celle de deux dés', () => {
  const graine = nouvelleGraine();
  const compteurs = new Array(13).fill(0);
  const tirages = 60_000;
  for (let i = 0; i < tirages; i++) compteurs[somme(lancer(graine, 'c', i, 2))]++;

  // Le 7 doit sortir ~1/6 du temps, le 2 ~1/36.
  const part7 = compteurs[7] / tirages;
  const part2 = compteurs[2] / tirages;
  assert.ok(Math.abs(part7 - 1 / 6) < 0.01, `7 sort ${(part7 * 100).toFixed(2)} %`);
  assert.ok(Math.abs(part2 - 1 / 36) < 0.005, `2 sort ${(part2 * 100).toFixed(2)} %`);
  assert.equal(compteurs[0] + compteurs[1], 0);
});

test('l’avantage du tireur est bien celui du craps (~49,3 %)', () => {
  // Espérance connue du pass line : 244/495 ≈ 49,29 % de victoires.
  const graine = nouvelleGraine();
  let victoires = 0;
  const manches = 20_000;
  let nonce = 0;

  for (let m = 0; m < manches; m++) {
    let resultat = evaluerComeOut(somme(lancer(graine, 'c', nonce++, 2)));
    while (resultat.issue === ISSUE.POINT || resultat.issue === ISSUE.CONTINUE) {
      const point = resultat.point ?? resultat.pointCourant;
      resultat = evaluerPoint(somme(lancer(graine, 'c', nonce++, 2)), point);
      resultat.point = point;
    }
    if (resultat.issue === ISSUE.GAGNE) victoires++;
  }

  const taux = victoires / manches;
  assert.ok(Math.abs(taux - 244 / 495) < 0.015, `taux de victoire du tireur : ${(taux * 100).toFixed(2)} %`);
});
