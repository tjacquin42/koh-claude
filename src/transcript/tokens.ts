import type { Session } from '../events/types';
import { readTranscript, type TranscriptStats } from './reader';

/**
 * Attache à chaque session les compteurs de tokens de son transcript.
 *
 * Isolée par session : `readTranscript` ne protège que le cas du fichier
 * absent (open() qui échoue). Tout le reste — permission refusée, chemin
 * devenu un dossier, descripteurs épuisés, volume démonté en cours de
 * lecture — lève encore, et la seule garantie possible est qu'aucune de ces
 * causes ne doit priver les *autres* sessions de leurs compteurs, ni faire
 * disparaître l'appelant sans qu'il ait pu rendre les sessions qui ont
 * fonctionné. Une session dont la lecture échoue garde simplement ses
 * anciens compteurs (ou n'en a jamais eu) ; le prochain appel réessaiera.
 */
export async function withTokens(
  sessions: Map<string, Session>,
  transcripts: Map<string, TranscriptStats>,
  onFailure?: (session: Session, err: unknown) => void,
): Promise<Map<string, Session>> {
  for (const s of sessions.values()) {
    if (s.transcriptPath === undefined) continue;
    try {
      const stats = await readTranscript(s.transcriptPath, transcripts.get(s.id));
      transcripts.set(s.id, stats);
      s.tokens = { input: stats.input, output: stats.output };
      if (s.branch === undefined && stats.branch !== undefined) s.branch = stats.branch;
    } catch (err) {
      onFailure?.(s, err);
    }
  }
  return sessions;
}
