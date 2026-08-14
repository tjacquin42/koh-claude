import { rename, stat } from 'node:fs/promises';

/**
 * Reprend l'état laissé par l'ancien nom de l'extension.
 *
 * Un renommage de dossier, pas une copie : l'état est un tout — sessions,
 * classement, ordre choisi, sauvegardes — et une copie partielle interrompue
 * laisserait deux emplacements se contredire, sans qu'aucun ne fasse foi.
 *
 * Trois conditions, et il faut les trois :
 * 1. la nouvelle racine n'existe pas encore — si elle existe, elle fait foi et
 *    l'ancienne n'est plus qu'un résidu ; l'écraser effacerait du travail récent ;
 * 2. l'ancienne existe ;
 * 3. le renommage réussit — sinon on continue sans état, ce qui est le
 *    comportement d'une installation neuve, jamais une erreur affichée.
 *
 * Retourne ce qui s'est passé, pour que l'appelant puisse le dire une fois.
 */
export async function migrateLegacyHome(legacy: string, home: string): Promise<'migrated' | 'nothing'> {
  if (legacy === home) return 'nothing';
  try {
    await stat(home);
    return 'nothing';
  } catch {
    // La nouvelle racine n'existe pas : c'est le seul cas où reprendre l'ancienne
    // a un sens.
  }
  try {
    await stat(legacy);
  } catch {
    return 'nothing';
  }
  try {
    await rename(legacy, home);
    return 'migrated';
  } catch {
    // Volumes différents, permissions, course avec une autre fenêtre : on
    // repart d'un état vide plutôt que de bloquer l'activation.
    return 'nothing';
  }
}
