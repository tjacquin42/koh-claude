#!/usr/bin/env node
/**
 * Fabrique les deux icônes de l'extension à partir du contour de Koh Rong.
 *
 * Le contour est relevé À LA MAIN sur une vue satellite de l'île — d'où la
 * table de points ci-dessous, qui est la SOURCE et non un sous-produit. Un SVG
 * dessiné directement se retoucherait au jugé ; ici, corriger la côte veut dire
 * corriger un point, et les deux icônes suivent ensemble.
 *
 * Deux icônes, parce qu'elles ne sont pas regardées de la même façon :
 * - la barre d'activité affiche 24 px et recolore la forme : silhouette pleine,
 *   monochrome, simplifiée jusqu'à ce que la côte reste lisible à cette taille ;
 * - la place de marché affiche 256 px : le trait de côte y garde ses détours.
 *
 * Usage : node scripts/make-icons.cjs
 */
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** Le tour de l'île, dans le sens des aiguilles depuis la pointe nord (pixels de la vue source). */
const OUTLINE = [
  [540, 25], [600, 60], [650, 140], [710, 168], [730, 100], [790, 140],
  [770, 232], [792, 300], [775, 420], [800, 470], [790, 560], [830, 610],
  [852, 592], [905, 572], [962, 592], [1022, 545], [1090, 572], [1122, 622],
  [1142, 690], [1212, 700], [1300, 678], [1340, 690], [1308, 752], [1336, 800],
  [1232, 880], [1170, 932], [1150, 992], [1078, 975], [985, 1032], [922, 1180],
  [898, 1268], [836, 1252], [806, 1160], [792, 1032], [778, 900], [735, 802],
  [700, 760], [612, 690], [520, 712], [430, 748], [352, 772], [300, 692],
  [270, 612], [266, 522], [212, 432], [126, 486], [70, 432], [160, 302],
  [166, 182], [200, 128], [300, 130], [400, 155], [470, 132],
];

/** Distance d'un point au segment ab — le critère de Ramer-Douglas-Peucker. */
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Retire les points qui ne changent pas la silhouette de plus de `epsilon`.
 *
 * Réduire à 24 px un tracé de cinquante points ne donne pas une île plus fidèle :
 * les criques tombent sous le pixel et se mélangent en une bouillie grise. Mieux
 * vaut décider CE QU'ON GARDE que laisser le rendu trancher au hasard.
 */
function simplify(points, epsilon) {
  if (points.length < 3) return [...points];
  let worst = 0;
  let at = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = distanceToSegment(points[i], points[0], points[points.length - 1]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= epsilon) return [points[0], points[points.length - 1]];
  const left = simplify(points.slice(0, at + 1), epsilon);
  const right = simplify(points.slice(at), epsilon);
  return [...left.slice(0, -1), ...right];
}

/**
 * Retire les pointes trop aiguës pour la taille visée.
 *
 * L'île a une crique étroite au nord. Réduite à 24 px, elle mesure moins d'un
 * pixel de large et se rend en cheveu — une aiguille noire plantée dans la
 * silhouette, qu'on lit comme un défaut de tracé et non comme une côte. La
 * simplification seule ne l'enlève pas : la crique est PROFONDE, donc RDP la
 * juge essentielle ; c'est son angle, pas son écart, qui la condamne.
 */
function dropSpikes(points, minAngleDeg) {
  const limit = (minAngleDeg * Math.PI) / 180;
  let kept = [...points];
  for (let pass = 0; pass < 4; pass++) {
    const next = kept.filter((p, i) => {
      const a = kept[(i - 1 + kept.length) % kept.length];
      const b = kept[(i + 1) % kept.length];
      const angle = Math.abs(
        Math.atan2(a[1] - p[1], a[0] - p[0]) - Math.atan2(b[1] - p[1], b[0] - p[0]),
      );
      const between = angle > Math.PI ? 2 * Math.PI - angle : angle;
      return between > limit;
    });
    if (next.length === kept.length || next.length < 8) return kept;
    kept = next;
  }
  return kept;
}

/** Ramène le contour dans un carré de `size`, centré, en gardant ses proportions. */
function fit(points, size, padding) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY);
  const scale = (size - 2 * padding) / span;
  const offsetX = padding + ((size - 2 * padding) - (Math.max(...xs) - minX) * scale) / 2;
  const offsetY = padding + ((size - 2 * padding) - (Math.max(...ys) - minY) * scale) / 2;
  return points.map(([x, y]) => [(x - minX) * scale + offsetX, (y - minY) * scale + offsetY]);
}

/**
 * Un chemin fermé et lissé (Catmull-Rom converti en cubiques).
 *
 * Une côte n'est pas une ligne brisée : reliée au segment, la silhouette prend
 * un air de polygone de jeu vidéo. `tension` à 0 rendrait les segments droits,
 * à 1 la courbe passe par tous les points en s'arrondissant.
 */
function smoothClosedPath(points, tension) {
  const n = points.length;
  const round = (v) => Math.round(v * 100) / 100;
  let d = `M${round(points[0][0])} ${round(points[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * tension, p1[1] + ((p2[1] - p0[1]) / 6) * tension];
    const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * tension, p2[1] - ((p3[1] - p1[1]) / 6) * tension];
    d += `C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  return `${d}Z`;
}

const resources = join(__dirname, '..', 'resources');

// --- Barre d'activité : 24 px, monochrome, recolorée par VSCode ---
// Le fichier s'appelle koh-rong.svg et non plus island.svg : l'icône est servie
// au rendu par une URL de fichier, que l'éditeur met en cache. Le paquet gardant
// toujours la même version et le même chemin, réinstaller ne changeait pas
// l'URL — et l'ancien dessin restait affiché après un rechargement de fenêtre.
const small = smoothClosedPath(fit(dropSpikes(simplify(OUTLINE, 55), 42), 24, 1.2), 0.5);
writeFileSync(
  join(resources, 'koh-rong.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path d="${small}" fill="#000"/>
</svg>
`,
  'utf8',
);

// --- Place de marché : 256 px, en couleur ---
// Le haut-fond est le MÊME chemin, tracé au trait : l'agrandir séparément
// donnait un anneau épais d'un côté et absent de l'autre, puisqu'une mise à
// l'échelle ne s'éloigne pas de la côte, elle s'éloigne du centre.
const big = smoothClosedPath(fit(OUTLINE, 256, 34), 0.7);
writeFileSync(
  join(resources, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#123642"/>
      <stop offset="1" stop-color="#0A1F28"/>
    </linearGradient>
    <linearGradient id="land" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#8BE0A0"/>
      <stop offset="1" stop-color="#3FA872"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#sea)"/>
  <path d="${big}" fill="none" stroke="#2E8494" stroke-width="13" stroke-linejoin="round" opacity="0.5"/>
  <path d="${big}" fill="none" stroke="#3FA8B8" stroke-width="5" stroke-linejoin="round" opacity="0.5"/>
  <path d="${big}" fill="url(#land)"/>
</svg>
`,
  'utf8',
);

console.log(
  `contour : ${OUTLINE.length} points, réduit à ${dropSpikes(simplify(OUTLINE, 55), 42).length} pour 24 px`,
);
