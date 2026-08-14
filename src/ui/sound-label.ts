import { NO_SOUND } from '../sound/player';

/**
 * La ligne de réglage du son. Elle dit l'état courant, pas une invitation
 * vague : « Son : Ping » se lit d'un coup d'œil, « Régler le son » obligerait à
 * cliquer pour savoir où on en est.
 */
export function soundLabel(sound: string): string {
  return sound === NO_SOUND ? 'Son : aucun' : `Son : ${sound}`;
}

export function soundTooltip(sound: string): string {
  return [
    sound === NO_SOUND
      ? 'Aucun son quand une session change de statut.'
      : `« ${sound} » quand une session t'attend ou vient de finir.`,
    "Les autres bascules ne sonnent pas : une session passe seule d'en cours à l'arrêt,",
    'et un carillon à chaque fois deviendrait un bruit de fond.',
    'Cliquez pour changer.',
  ].join('\n');
}
