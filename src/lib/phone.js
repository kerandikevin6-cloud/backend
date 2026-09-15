/* ============================================================
   Phone numbers
   People type 0712..., +254712..., 254 712 345 678. The provider wants
   one shape. Normalise once at the edge so nothing downstream has to
   guess.
   ============================================================ */
const DIAL = { KE: '254', UG: '256', TZ: '255', RW: '250', NG: '234', GH: '233', ZA: '27' };
const LEN = { KE: 9, UG: 9, TZ: 9, RW: 9, NG: 10, GH: 9, ZA: 9 };

export function normalisePhone(input, country = 'KE') {
  const dial = DIAL[country] || DIAL.KE;
  const want = LEN[country] || 9;

  let digits = String(input || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith(dial)) digits = digits.slice(dial.length);
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length !== want) return null;
  return dial + digits;
}
