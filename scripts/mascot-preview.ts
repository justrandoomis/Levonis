/**
 * Renders the character engine to a static contact sheet so its states and its
 * travel can be LOOKED AT, not merely reasoned about.
 *
 * Motion work that is only ever read as code ships bugs no test catches — a
 * mouth that leaves the face at full yaw, an eye that inverts past the limb, a
 * body that goes concave under stretch. This samples the same pure functions
 * the app runs and writes an HTML page of frames; `npm run mascot:preview`
 * then screenshots it with the Chromium already on the machine.
 *
 * Development tooling only. Nothing in src/ imports it.
 */
import { writeFileSync } from 'node:fs';
import { sampleCharacter, VIEWBOX, type CharacterInput } from '../src/components/bloub/character/engine.ts';
import { planTravel, sampleTravel } from '../src/components/bloub/character/travel.ts';
import type { MascotState } from '../src/lib/mascot.ts';

const STATES: MascotState[] = [
  'idle', 'loading', 'typing', 'navigating', 'returning',
  'arrival', 'success', 'notify', 'tap', 'error', 'warning', 'sleep',
];

function svg(render: ReturnType<typeof sampleCharacter>, size = 132): string {
  const eyes = render.eyes
    .map((e) => (e.visible ? `<ellipse rx="${e.rx}" ry="${e.ry}" transform="${e.matrix}" fill="#F2EAD3"/>` : ''))
    .join('');
  const badge = render.alert > 0
    ? `<circle cx="78" cy="22" r="7" fill="#E8B84B" opacity="${render.alert.toFixed(2)}"/>`
    : '';
  return `<svg viewBox="${VIEWBOX}" width="${size}" height="${size}">
    <defs><radialGradient id="g" cx="38%" cy="30%" r="78%">
      <stop offset="0%" stop-color="#4A5231"/><stop offset="62%" stop-color="#333A20"/><stop offset="100%" stop-color="#20250F"/>
    </radialGradient></defs>
    <path d="${render.body}" fill="url(#g)" stroke="#6E7845" stroke-width="1.1"/>
    <path d="${render.gloss}" fill="none" stroke="#98A56A" stroke-width="2.6" stroke-linecap="round" opacity="0.34"/>
    ${eyes}
    <path d="${render.mouth}" fill="none" stroke="#F2EAD3" stroke-width="${render.mouthWeight}" stroke-linecap="round" opacity="0.92"/>
    ${badge}
  </svg>`;
}

const cell = (label: string, body: string) =>
  `<figure><div class="box">${body}</div><figcaption>${label}</figcaption></figure>`;

const sections: string[] = [];

// Every state, held, so the resting pose of each can be compared side by side.
sections.push(`<h2>States at rest (t = 6.0s, fully blended)</h2><div class="grid">${STATES.map((state) => {
  const input: CharacterInput = { t: 6, state, from: null, age: 4, travel: null, reduced: false };
  return cell(state, svg(sampleCharacter(input)));
}).join('')}</div>`);

// Idle across half a minute: the brief's own acceptance test is that thirty
// seconds of watching shows no loop, so sample thirty seconds of it.
sections.push(`<h2>Idle over 30s (every 1.25s) — look for a repeat</h2><div class="grid small">${
  Array.from({ length: 24 }, (_, i) => {
    const t = i * 1.25;
    return cell(`${t.toFixed(2)}s`, svg({ ...sampleCharacter({ t, state: 'idle', from: null, age: 99, travel: null, reduced: false }) }, 84));
  }).join('')
}</div>`);

// The blend into a reaction, frame by frame, to prove nothing snaps.
for (const [from, to] of [['idle', 'success'], ['idle', 'error'], ['idle', 'notify'], ['loading', 'idle']] as Array<[MascotState, MascotState]>) {
  sections.push(`<h2>Blend ${from} &rarr; ${to}</h2><div class="grid small">${
    Array.from({ length: 10 }, (_, i) => {
      const age = i * 0.045;
      return cell(`${(age * 1000).toFixed(0)}ms`, svg(sampleCharacter({ t: 6 + age, state: to, from, age, travel: null, reduced: false }), 84));
    }).join('')
  }</div>`);
}

// The first journey: centre of an iPad viewport down to the home dock.
const plan = planTravel({ x: 420, y: 250, size: 300 }, { x: 560, y: 660, size: 88 }, { boot: true });
sections.push(`<h2>Boot journey — centre &rarr; bottom home (total ${plan.total.toFixed(2)}s)</h2><div class="grid small">${
  Array.from({ length: 16 }, (_, i) => {
    const elapsed = (i / 15) * plan.total;
    const tv = sampleTravel(plan, elapsed);
    const render = sampleCharacter({ t: 6 + elapsed, state: 'returning', from: 'loading', age: elapsed, travel: tv, reduced: false });
    return cell(`${(elapsed * 1000).toFixed(0)}ms ${tv.phase}<br/>size ${tv.size.toFixed(0)} lead ${tv.lead.toFixed(2)}`, svg(render, 84));
  }).join('')
}</div>`);

// Loading, sampled slowly, to see the search sweep actually sweep.
sections.push(`<h2>Loading sweep (every 0.35s)</h2><div class="grid small">${
  Array.from({ length: 16 }, (_, i) => {
    const t = i * 0.35;
    return cell(`${t.toFixed(2)}s`, svg(sampleCharacter({ t, state: 'loading', from: null, age: 9, travel: null, reduced: false }), 84));
  }).join('')
}</div>`);

writeFileSync(
  new URL('../.mascot-preview.html', import.meta.url),
  `<!doctype html><meta charset="utf-8"><style>
    body{background:#0B0D07;color:#C8CBB4;font:13px/1.4 system-ui;margin:0;padding:24px}
    h2{font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:#E8B84B;margin:28px 0 10px;font-weight:700}
    .grid{display:flex;flex-wrap:wrap;gap:10px}
    figure{margin:0;text-align:center}
    .box{background:#14170D;border:1px solid #2A2F1B;border-radius:12px;padding:4px;line-height:0}
    figcaption{font-size:10px;margin-top:4px;color:#8A8F74}
  </style>${sections.join('')}`,
);
console.log('wrote .mascot-preview.html');
