// Règles du craps de rue, en fonctions pures.
//
// Aucun accès à la base, aucun état : on donne une somme de dés, on obtient
// une issue. C'est ce qui rend les règles vérifiables au test unitaire, et ce
// qui garantit qu'un bogue d'orchestration ne peut pas changer qui gagne.
//
// Déroulement :
//   Premier lancer (le « come out ») —
//     7 ou 11        : le tireur gagne (un « naturel »)
//     2, 3 ou 12     : le tireur perd (2 = snake eyes)
//     autre          : ce nombre devient son « point »
//   Ensuite, il relance jusqu'à —
//     refaire le point : il gagne
//     sortir un 7      : il perd (le « seven out »)

export const ISSUE = {
  GAGNE: 'gagne',
  PERD: 'perd',
  POINT: 'point',
  CONTINUE: 'continue',
};

/** Évalue le premier lancer. */
export function evaluerComeOut(sommeDes) {
  if (sommeDes === 7 || sommeDes === 11) {
    return { issue: ISSUE.GAGNE, raison: 'naturel' };
  }
  if (sommeDes === 2) {
    return { issue: ISSUE.PERD, raison: 'snake-eyes' };
  }
  if (sommeDes === 3 || sommeDes === 12) {
    return { issue: ISSUE.PERD, raison: 'craps' };
  }
  return { issue: ISSUE.POINT, point: sommeDes };
}

/** Évalue un lancer une fois le point établi. */
export function evaluerPoint(sommeDes, point) {
  if (sommeDes === point) {
    return { issue: ISSUE.GAGNE, raison: 'point-refait' };
  }
  if (sommeDes === 7) {
    return { issue: ISSUE.PERD, raison: 'seven-out' };
  }
  return { issue: ISSUE.CONTINUE };
}

/** Aiguille vers la bonne règle selon la phase. */
export function evaluer(sommeDes, point = null) {
  return point === null ? evaluerComeOut(sommeDes) : evaluerPoint(sommeDes, point);
}

const LIBELLES = {
  naturel: 'Naturel — le tireur gagne',
  'snake-eyes': 'Snake eyes — le tireur perd',
  craps: 'Craps — le tireur perd',
  'point-refait': 'Point refait — le tireur gagne',
  'seven-out': 'Seven out — le tireur perd',
};

export const libelle = (raison) => LIBELLES[raison] ?? '';
