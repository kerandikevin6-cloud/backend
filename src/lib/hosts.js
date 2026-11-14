/* ============================================================
   Session hosts: passwords and sign-in tokens

   Hosts are not Supabase users and not staff. Their password is
   hashed here with scrypt and their token is signed here, with a key
   derived from the service-role key so no new secret has to be set
   on Render. A host token is a different audience from a Supabase
   token, so it opens /host and nothing else.
   ============================================================ */
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';

const KEY = crypto
  .createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY)
  .update('nexas-host-portal-v1')
  .digest();
const AUDIENCE = 'nexas-host';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}

export function checkPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}

export async function signHostToken(hostId) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(hostId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('12h')
    .sign(KEY);
}

export async function verifyHostToken(token) {
  const { payload } = await jwtVerify(token, KEY, { audience: AUDIENCE, algorithms: ['HS256'] });
  if (!payload.sub) throw new Error('token has no subject');
  return payload.sub;
}
