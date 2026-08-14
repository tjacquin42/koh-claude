import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * La version n'est pas lue dans package.json : la convention du projet
 * (CLAUDE.md) dit qu'il reste à sa valeur d'origine et ne fait pas foi. Elle
 * vient du tag posé par la livraison, capté au build par
 * scripts/stamp-build.cjs — donc d'un fichier, comme tout ce qui vient de
 * l'extérieur, et validé sans cast.
 */
export function releaseLabel(stamp: unknown): string | undefined {
  if (typeof stamp !== 'object' || stamp === null) return undefined;
  const { version, ahead } = stamp as { version?: unknown; ahead?: unknown };
  if (typeof version !== 'string' || version.length === 0) return undefined;
  // « +7 » = sept commits après la dernière livraison. Un compte absent ou
  // douteux n'invente pas d'écart : on affiche la version seule.
  return typeof ahead === 'number' && ahead > 0 ? `${version}+${ahead}` : version;
}

/**
 * L'étoile dit que le paquet installé ne correspond pas exactement à ce commit
 * (voir scripts/stamp-build.cjs). Un marqueur sans commit ne vaut rien : on
 * n'affiche jamais l'étoile seule.
 */
export function buildCommit(stamp: unknown): string | undefined {
  if (typeof stamp !== 'object' || stamp === null) return undefined;
  const { commit, dirty } = stamp as { commit?: unknown; dirty?: unknown };
  if (typeof commit !== 'string' || commit.length === 0) return undefined;
  return dirty === true ? `${commit}*` : commit;
}

/**
 * Ce que la vue affiche à côté de son titre : « v0.2.0+7 · 1736ec0 ».
 *
 * Tant qu'aucune version n'a été livrée, le dépôt n'a pas de tag et il n'y a
 * rien à emprunter : on l'écrit, plutôt que d'afficher un numéro qui ne
 * correspond à aucune livraison. Le commit, lui, suffit déjà à répondre à la
 * seule question posée — est-ce bien le nouveau paquet qui tourne ?
 */
export function versionLabel(stamp: unknown): string {
  const release = releaseLabel(stamp) ?? vscode.l10n.t('no version');
  const commit = buildCommit(stamp);
  return commit === undefined ? release : `${release} · ${commit}`;
}

/**
 * Absent ou illisible vaut « pas d'horodatage », jamais une erreur : la même
 * règle que le fichier de classement (groups/store.ts). Un paquet reconstruit
 * hors dépôt doit s'afficher, pas refuser de s'afficher.
 */
export async function readBuildStamp(extensionPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(extensionPath, 'build-info.json'), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}
