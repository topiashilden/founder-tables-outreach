// A curated list of startup events for the Event map (event DISCOVERY only). Each entry was checked by hand on the
// date in `checked`, from the source in `checkedFrom`; re-check before relying on it. None of these comes with an
// attendee list: public event sites do not publish their attendees. See docs/event-data.md for where lists come from.
//
//   <script src="events/curated.js"></script>
//   el.config = { ...yourConfig, events: window.FT_CURATED_EVENTS };
//   el.addAttendees('slush-2026', csvText, "the organiser's export")   // once you have a list
(function (root) {
  const EVENTS = [
    {
      id: 'slush-2026', name: 'Slush', city: 'Helsinki', start: '2026-11-18', end: '2026-11-19',
      url: 'https://slush.org', checked: '2026-11-10', checkedFrom: 'https://www.therecursive.com/slush-2026/',
      public: 'Speakers and partners are listed on the site. Attendees are visible only inside the event app to ticket holders; there is no public attendee list.',
      attendees: [],
    },
    {
      id: 'techarena-2027', name: 'Techarena', city: 'Stockholm', start: '2027-02-03', end: '2027-02-04',
      url: 'https://techarena.se/events/techarena-2027', checked: '2026-11-10', checkedFrom: 'https://techarena.se/events/techarena-2027',
      public: 'Speakers and partners are listed on the site. No public attendee list.',
      attendees: [],
    },
  ];
  root.FT_CURATED_EVENTS = EVENTS;
  if (typeof module === 'object' && module.exports) module.exports = EVENTS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
