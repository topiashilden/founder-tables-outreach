// node examples/make-data.mjs: writes three INVENTED LinkedIn Connections.csv exports and INVENTED events for the example page.
// Everyone here is made up: names are random combinations, companies are invented, profile URLs are "demo-0001"
// placeholders that point at nobody. The CSV format is LinkedIn's (Notes preamble, empty emails).
// The three events are fictional examples ("Example ..."), so no real event is ever shown with an invented attendee list.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let seed = 20261110;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const FIRST = 'Ingrid Mikael Sara Jonas Elin Pekka Hanna Amira Lucas Freja Viktor Nora Oskar Maja Daniel Karin Tomas Lina Erik Aino Felix Emma Johan Sofia Anton Clara Ella Gustav Leila Petra Mattias Rasmus Albin Wilma Hugo Moa Ebba Isak Signe Leif Astrid Henrik Liv Torbjörn Saga Nils Marit Kasper Ida Rolf Tuva Bjørn Frida Anders Selma Jari Veera Otto Helmi Eero Sanna'.split(' ');
const LAST = 'Sjöberg Brandt Lindqvist Ek Nyberg Laine Berg Haddad Moreau Holm Dahl Aalto Wallin Strand Roos Vik Engel Persson Söder Virtanen Krüger Lund Falk Rinaldi Björk Weiss Norén Hed Karimi Svensson Ojala Holt Ström Nilsson Lindgren Sundin Berglund Eriksen Hansen Koskinen Mäkelä Heikkinen Jensen Olsen Larsen Pettersen Andersson Johansson Karlsson Gustafsson Bergström Forsberg Sandberg Lehtonen Niemi Hakala Salo'.split(' ');

// invented industrial startups: syllables + a sector word
const A = ['Kva', 'Vel', 'Nor', 'Sol', 'Lum', 'Ari', 'Zen', 'Bri', 'Tol', 'Mav', 'Rin', 'Eko', 'Fyr', 'Gra', 'Hel', 'Ivo', 'Kor', 'Lys', 'Mir', 'Nex', 'Oda', 'Pax', 'Qui', 'Rav', 'Sky', 'Tav', 'Ulm', 'Vyn', 'Wex', 'Yar', 'Zor', 'Alv'];
const B = ['anta', 'ora', 'ify', 'ium', 'ex', 'ly', 'ara', 'ino', 'eon', 'ova', 'ista', 'ent', 'aro', 'yx', 'ila'];
const KIND = ['Energy', 'Hydrogen', 'Grid', 'Batteries', 'Solar', 'Wind', 'Fusion', 'Steel', 'Materials', 'Robotics', 'Mining', 'Recycling', 'Manufacturing', 'Automation']; // half energy, half other industry
const ENERGY = /energy|hydrogen|grid|batter|solar|wind|fusion|power/i; // the field the demo prompt asks for
const usedCo = new Set();
const startup = () => { let n; do { n = `${pick(A)}${pick(B)} ${pick(KIND)}`; } while (usedCo.has(n)); usedCo.add(n); return n; };
const STARTUPS = Array.from({ length: 110 }, startup);
const FOUNDER_POS = ['Founder & CEO', 'Co-founder & CEO', 'Co-founder & CTO', 'Founder', 'CEO', 'Co-founder', 'Co-founder & COO', 'Co-founder & CPO'];

const OTHER_CO = ['Rimfrost Consulting', 'Kvarn Analytics', 'Lumo Home', 'Bara Foods', 'Sälta Apparel', 'Molnbas Cloud', 'Bruksfest', 'Kontorsvaror AB', 'Fjord Studio', 'Nordlys Media', 'Tindra Travel', 'Solvik Travel', 'Halla Design', 'Piano Studio', 'Brisa Retail', 'Vagn Freight', 'Hav Games', 'Mjölk Digital', 'Kiruna Consulting', 'Ekby Bank', 'Polar Insurance', 'Stråla Retail', 'Vind Recruitment', 'Lila Fashion', 'Tallbacken School', 'Nordisk Hotell', 'Ankar Software', 'Kajen Restaurants', 'Brygga Coffee', 'Lagom Furniture', 'Oden Security', 'Svalan Telecom', 'Hjorten Publishing', 'Gnista Payments', 'Ryd Advisors', 'Torg Marketplace', 'Ljus Education', 'Fjäril Capital', 'Alm Ventures', 'Bergsro Capital'];
const OTHER_POS = ['Software Engineer', 'Account Executive', 'Marketing Manager', 'Product Designer', 'Recruiter', 'Consultant', 'Data Analyst', 'Customer Success Manager', 'Student', 'HR Business Partner', 'Sales Director', 'Project Manager', 'Brand Manager', 'Finance Manager', 'Intern', 'Operations Coordinator', 'Content Lead', 'Engineering Manager', 'Investment Manager', 'Partner', 'Angel Investor', 'Head of Growth'];
const FIELD = /founder|\bceo\b|chief executive/i; // what the demo's "Founders" topic matches
if (OTHER_POS.some((p) => FIELD.test(p))) throw new Error('other positions must not match the founder field');

const OWNERS = [{ id: 'you', weight: 0.5 }, { id: 'alex', weight: 0.3 }, { id: 'sam', weight: 0.2 }]; // a platform team member, a Venture Partner, a portfolio founder

const used = new Set();
const person = (company, position, i) => {
  let f, l, k;
  do { f = pick(FIRST); l = pick(LAST); k = f + l; } while (used.has(k));
  used.add(k);
  return { first: f, last: l, company, position, url: `https://www.linkedin.com/in/demo-${String(i).padStart(4, '0')}`, owners: [] };
};

const people = [];
STARTUPS.forEach((co, i) => { const n = i < 35 ? 2 : 1; for (let k = 0; k < n; k++) people.push(person(co, pick(FOUNDER_POS), people.length + 1)); }); // 35*2 + 75 = 145 founders
while (people.length < 380) people.push(person(pick(OTHER_CO), pick(OTHER_POS), people.length + 1));
const isField = (p) => FIELD.test(p.position);

const own = () => { let r = rnd(), a = 0; for (const o of OWNERS) { a += o.weight; if (r < a) return o.id; } return 'you'; };
people.forEach((p) => {
  p.owners.push(own());
  if (rnd() < (isField(p) ? 0.22 : 0.04)) { let o; do { o = own(); } while (p.owners.includes(o)); p.owners.push(o); }
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const date = () => `${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')} ${pick(MONTHS)} ${2014 + Math.floor(rnd() * 12)}`;
const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const out = join(dirname(fileURLToPath(import.meta.url)), 'data');
mkdirSync(out, { recursive: true });
const noUrl = { you: 0, alex: 3, sam: 2 }; // a few exports have people without a profile URL, as real ones do
for (const o of OWNERS) {
  const rows = people.filter((p) => p.owners.includes(o.id));
  let drop = noUrl[o.id];
  const lines = rows.map((p) => {
    const strip = drop > 0 && !isField(p) && rnd() < 0.2 && drop-- > 0;
    return [p.first, p.last, strip ? '' : p.url, '', p.company, p.position, date()].map(q).join(',');
  });
  const text = 'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing. This is invented demo data."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\n' + lines.join('\n') + '\n';
  writeFileSync(join(out, `${o.id}-Connections.csv`), text);
  console.log(o.id, rows.length, 'connections');
}

// ---- events: invented attendee and partner lists. Some attendees are people in the networks (same profile URL). ----
const CITIES = [['Stockholm', 59.33, 18.07], ['Gothenburg', 57.71, 11.97], ['Malmö', 55.6, 13.0], ['Luleå', 65.58, 22.15], ['Helsinki', 60.17, 24.94], ['Tampere', 61.5, 23.76], ['Copenhagen', 55.68, 12.57], ['Aarhus', 56.16, 10.21], ['Bergen', 60.39, 5.32], ['Trondheim', 63.43, 10.4], ['Oslo', 59.91, 10.75], ['Hamburg', 53.55, 9.99], ['Düsseldorf', 51.23, 6.78], ['Rotterdam', 51.92, 4.48], ['Antwerp', 51.22, 4.4], ['Katowice', 50.26, 19.02], ['Gdańsk', 54.35, 18.65], ['Vienna', 48.21, 16.37], ['Zürich', 47.38, 8.54], ['Paris', 48.86, 2.35], ['London', 51.51, -0.13], ['Manchester', 53.48, -2.24], ['Dublin', 53.35, -6.26], ['Tallinn', 59.44, 24.75], ['Riga', 56.95, 24.11], ['Berlin', 52.52, 13.4], ['Munich', 48.14, 11.58], ['Prague', 50.08, 14.44]];
const city = (name) => CITIES.find((c) => c[0] === name);
const founders = people.filter((p) => isField(p) && ENERGY.test(p.company)); // energy founders: who the demo dinner is for
const EVENTS = [
  { id: 'example-industry-summit', name: 'Example Industry Summit', city: 'Stockholm', start: '2026-11-09', end: '2026-11-10', total: 84, known: { you: 5, alex: 4, sam: 4, shared: 3 } },
  { id: 'example-founder-day', name: 'Example Founder Day', city: 'Helsinki', start: '2027-01-21', end: '2027-01-21', total: 54, known: { you: 3, alex: 3, sam: 2, shared: 2 } },
  { id: 'example-climate-forum', name: 'Example Climate Forum', city: 'Copenhagen', start: '2027-02-10', end: '2027-02-11', total: 60, known: { you: 3, alex: 2, sam: 3, shared: 2 } },
];
const usedKnown = new Set();
const events = EVENTS.map((e, ei) => {
  const [, elat, elon] = city(e.city);
  const away = () => pick(CITIES.filter((c) => c[0] !== e.city));
  const rows = [];
  const take = (n, test) => shuffle(founders.filter((p) => test(p) && !usedKnown.has(p.url))).slice(0, n).forEach((p) => { usedKnown.add(p.url); rows.push(p); });
  take(e.known.shared, (p) => p.owners.length > 1);
  take(e.known.you, (p) => p.owners.length === 1 && p.owners[0] === 'you');
  take(e.known.alex, (p) => p.owners.length === 1 && p.owners[0] === 'alex');
  take(e.known.sam, (p) => p.owners.length === 1 && p.owners[0] === 'sam');
  const attendees = rows.map((p) => { const c = away(); return { first: p.first, last: p.last, url: p.url, company: p.company, position: p.position, city: c[0], lat: c[1], lon: c[2], kind: 'attendee' }; });
  let n = 9000 + ei * 100;
  while (attendees.length < e.total) { // everyone else: invented, in nobody's network; some at startups the networks do know
    const isF = rnd() < 0.6, co = isF ? (rnd() < 0.3 ? pick(STARTUPS) : startup()) : pick(OTHER_CO), c = rnd() < 0.2 ? city(e.city) : pick(CITIES);
    const q2 = person(co, isF ? pick(FOUNDER_POS) : pick(OTHER_POS), n++);
    attendees.push({ first: q2.first, last: q2.last, url: q2.url, company: q2.company, position: q2.position, city: c[0], lat: c[1], lon: c[2], kind: rnd() < 0.15 ? 'partner' : rnd() < 0.1 ? 'speaker' : 'attendee' });
  }
  return { id: e.id, name: e.name, city: e.city, lat: elat, lon: elon, start: e.start, end: e.end, source: "the organiser's attendee and partner export", invented: true, attendees: shuffle(attendees) };
});
// One script for the example page (works from file://): the three networks as CSV text, and the events.
const roles = { you: ['Me', 'Platform team', true], alex: ['Alex', 'Venture Partner', false], sam: ['Sam', 'Portfolio founder', false] };
const nets = OWNERS.map((o) => ({ name: roles[o.id][0], role: roles[o.id][1], me: roles[o.id][2], csv: readFileSync(join(out, `${o.id}-Connections.csv`), 'utf8') }));
writeFileSync(join(dirname(out), 'example-data.js'), '// INVENTED example community and events, generated by make-data.mjs. Every person and attendee list is made up.\nwindow.FT_EXAMPLE_NETWORKS = ' + JSON.stringify(nets) + ';\nwindow.FT_EXAMPLE_EVENTS = ' + JSON.stringify(events) + ';\n');
console.log('events', events.map((e) => e.name + ' · ' + e.city + ': ' + e.attendees.length).join(', '));
console.log('people', people.length, 'founders', people.filter(isField).length, 'energy founders', founders.length, 'shared', people.filter((p) => p.owners.length > 1).length);
