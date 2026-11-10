// Attendee lists: parsing, the city lookup, and matching to the networks (by LinkedIn URL only). Invented people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { core } = createRequire(import.meta.url)('../founder-tables-outreach.js');

test('an organiser export with LinkedIn URLs: people, companies, cities, kinds; emails never read', () => {
  const csv = 'Ticket ID,First Name,Last Name,Email,LinkedIn Profile,Company,Job Title,City,Ticket Type\n'
    + '1,Ida,Lund,ida@example.com,https://www.linkedin.com/in/demo-1/,Nordhavn Steel Oy,Head of Energy,Stockholm,Founder pass\n'
    + '2,Kai,Moe,,,Kalkvik Cement,CEO,Oslo,Speaker\n'
    + '3,,,,,Gnista Payments,,,Partner\n'
    + '4,,,,,,,,\n';
  const { rows, report } = core.parseAttendees(csv);
  assert.equal(rows.length, 3, 'blank rows skipped, company-only partner kept');
  assert.equal(report.withUrl, 1);
  assert.deepEqual(rows.map((r) => r.kind), ['attendee', 'speaker', 'partner']);
  assert.ok(!JSON.stringify(rows).includes('@'), 'no email kept');
  assert.equal(rows[0].url, 'https://www.linkedin.com/in/demo-1/');
});

test('a public speaker list with a single Name column and no URLs warns that only companies can match', () => {
  const { rows, report } = core.parseAttendees('Name;Company;Title\nAino Weiss;Paxova Steel;Founder & CEO\n');
  assert.deepEqual([rows[0].first, rows[0].last, rows[0].company], ['Aino', 'Weiss', 'Paxova Steel']);
  assert.ok(report.warnings.some((w) => /No LinkedIn URL column/.test(w)));
  assert.match(core.parseAttendees('a,b\n1,2').report.error, /No header/);
});

test('city lookup: known cities get coordinates, unknown ones none (still matched, just not drawn)', () => {
  assert.deepEqual(core.geocode('Stockholm'), [59.33, 18.07]);
  assert.deepEqual(core.geocode('Malmö, Sweden'), [55.6, 13.0]);
  assert.deepEqual(core.geocode('Düsseldorf'), [51.23, 6.78]);
  assert.equal(core.geocode('Nowhereville'), null);
});

test('matching: a person by profile URL, a company by name; a name alone never merges', () => {
  const people = core.mergePeople([{ id: 'a', name: 'Alex', me: false, rows: [
    { first: 'Ida', last: 'Lund', url: 'https://linkedin.com/in/Demo-1', company: 'Nordhavn Steel', position: 'Head of Energy' },
    { first: 'Kai', last: 'Moe', url: 'https://www.linkedin.com/in/demo-2', company: 'Kalkvik Cement', position: 'CTO' },
  ] }]);
  const { rows } = core.parseAttendees('First Name,Last Name,LinkedIn,Company\nIda,Lund,https://www.linkedin.com/in/demo-1/,Nordhavn Steel Oy\nKai,Moe,,Kalkvik Cement\n,,,Gnista Payments\n');
  const m = core.matchEvent({ id: 'e', name: 'X', attendees: rows }, people);
  assert.equal(m.known.length, 1, 'Ida by URL; Kai has no URL in the list, so not merged by name');
  assert.equal(m.rows[1].colleagues.length, 1, 'but Kalkvik Cement is a company someone knows');
  assert.equal(m.companies, 2);
});
