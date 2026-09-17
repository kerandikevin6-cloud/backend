/* ============================================================
   Phone numbers
   People type 0712..., +254712..., 254 712 345 678. The provider wants
   one shape. Normalise once at the edge so nothing downstream has to
   guess.
   ============================================================ */
const DIAL = { KE: '254', UG: '256', TZ: '255', RW: '250', NG: '234', GH: '233', ZA: '27' };
const LEN = { KE: 9, UG: 9, TZ: 9, RW: 9, NG: 10, GH: 9, ZA: 9 };

/* Which of the countries we reach a full international number belongs
   to. Longest code first, so 254 is not mistaken for 25 of something.
   Returns null when it matches none of them, which is the honest answer
   for a number on a rail we do not have. */
function countryOf(digits) {
  const codes = Object.keys(DIAL).sort((a, b) => DIAL[b].length - DIAL[a].length);
  for (const cc of codes) {
    if (digits.startsWith(DIAL[cc]) && digits.length === DIAL[cc].length + LEN[cc]) return cc;
  }
  return null;
}

export function normalisePhone(input, country = 'KE') {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);

  /* A number sent in full carries its own country, and that beats the
     one on the profile: somebody who signed up in Nairobi and is being
     paid out to a Ugandan number has told us which, and reading it off
     the profile instead is how the money goes to a number that does not
     exist. */
  const declared = countryOf(digits);
  if (declared) return digits;

  const dial = DIAL[country] || DIAL.KE;
  const want = LEN[country] || 9;

  if (digits.startsWith(dial)) digits = digits.slice(dial.length);
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length !== want) return null;
  return dial + digits;
}
