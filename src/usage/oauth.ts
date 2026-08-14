import { execFile } from 'node:child_process';
import { request } from 'node:https';

/**
 * La consommation, demandée directement à Anthropic.
 *
 * Pourquoi ce chemin plutôt que le pont de statusline : Claude Code ne passe
 * `rate_limits` qu'à la statusline, et la statusline ne se déclenche pas dans
 * une session hébergée par l'éditeur — mesuré, le fichier restait vide. Ce
 * chemin-ci ne dépend d'aucune autre application.
 *
 * Le jeton est celui que Claude Code a déjà déposé dans le trousseau de la
 * session : on ne s'authentifie pas à sa place, on réutilise son
 * authentification. Il n'est jamais écrit sur disque, jamais journalisé, et ne
 * quitte pas ce module.
 */
const SERVICE = 'Claude Code-credentials';
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 8_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Le jeton d'accès, ou `undefined` si on ne peut pas l'obtenir — trousseau
 * verrouillé, autorisation refusée, Claude Code authentifié autrement, ou
 * simplement une autre plateforme. Aucun de ces cas n'est une erreur : la vue
 * affiche « inconnue » et continue.
 *
 * `execFile`, jamais `exec` : rien de tout ceci ne doit traverser un shell.
 */
export function readAccessToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-w'], (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(accessTokenOf(stdout));
    });
  });
}

/**
 * Extrait le jeton du JSON du trousseau. Séparé de la lecture pour être
 * éprouvable sans trousseau — et sans jamais avoir besoin d'un vrai jeton.
 */
export function accessTokenOf(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const oauth = parsed['claudeAiOauth'];
  if (!isRecord(oauth)) return undefined;
  const token = oauth['accessToken'];
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Interroge le point d'usage. Toute réponse qui n'est pas un JSON exploitable
 * vaut `undefined` : ce point d'entrée n'est pas documenté et peut changer sans
 * prévenir, ce qui doit se traduire par « pas de mesure », jamais par une
 * erreur affichée ni par une exception qui remonterait dans le rendu.
 */
export function fetchUsage(token: string, url: string = USAGE_URL): Promise<unknown> {
  return new Promise((resolve) => {
    const done = (value: unknown): void => resolve(value);
    const req = request(
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          accept: 'application/json',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return done(undefined);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            done(JSON.parse(body) as unknown);
          } catch {
            done(undefined);
          }
        });
      },
    );
    req.on('error', () => done(undefined));
    req.on('timeout', () => {
      req.destroy();
      done(undefined);
    });
    req.end();
  });
}
