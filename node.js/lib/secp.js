'use strict';
/**
 * secp256k1 helpers.
 *  - Pure BigInt curve math (Jacobian coordinates) for Ethereum public-key
 *    recovery, key derivation and the deterministic test signer.
 *  - Node's built-in OpenSSL for native Betium signatures. Native Betium
 *    transactions are ECDSA over SHA-1 with raw 64-byte r||s signatures, exactly
 *    what python-ecdsa's SigningKey.sign()/VerifyingKey.verify() produce.
 */

const crypto = require('node:crypto');

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
const G = [GX, GY];

const mod = (a, m = P) => ((a % m) + m) % m;

function modInv(a, m) {
  let r0 = mod(a, m);
  let r1 = m;
  let s0 = 1n;
  let s1 = 0n;
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error('value is not invertible');
  return mod(s0, m);
}

function modPow(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

// ---- Jacobian arithmetic (a = 0). Infinity is Z = 0. ----------------------

const INF = [0n, 1n, 0n];

function jDouble(pt) {
  const [X, Y, Z] = pt;
  if (Z === 0n || Y === 0n) return INF;
  const YY = (Y * Y) % P;
  const S = (4n * X * YY) % P;
  const M = (3n * X * X) % P;
  const X3 = mod(M * M - 2n * S);
  const Y3 = mod(M * (S - X3) - 8n * YY * YY);
  const Z3 = (2n * Y * Z) % P;
  return [X3, Y3, Z3];
}

function jAdd(p1, p2) {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const [X1, Y1, Z1] = p1;
  const [X2, Y2, Z2] = p2;
  const Z1Z1 = (Z1 * Z1) % P;
  const Z2Z2 = (Z2 * Z2) % P;
  const U1 = (X1 * Z2Z2) % P;
  const U2 = (X2 * Z1Z1) % P;
  const S1 = (Y1 * Z2 * Z2Z2) % P;
  const S2 = (Y2 * Z1 * Z1Z1) % P;
  if (U1 === U2) return S1 === S2 ? jDouble(p1) : INF;
  const H = mod(U2 - U1);
  const R = mod(S2 - S1);
  const HH = (H * H) % P;
  const HHH = (H * HH) % P;
  const V = (U1 * HH) % P;
  const X3 = mod(R * R - HHH - 2n * V);
  const Y3 = mod(R * (V - X3) - S1 * HHH);
  const Z3 = (H * Z1 * Z2) % P;
  return [X3, Y3, Z3];
}

function toJacobian(pt) {
  return pt === null ? INF : [pt[0], pt[1], 1n];
}

function toAffine(j) {
  if (j[2] === 0n) return null;
  const zi = modInv(j[2], P);
  const zi2 = (zi * zi) % P;
  return [(j[0] * zi2) % P, (j[1] * zi2 * zi) % P];
}

function mul(k, pt) {
  let result = INF;
  let addend = toJacobian(pt);
  let e = k;
  while (e > 0n) {
    if (e & 1n) result = jAdd(result, addend);
    addend = jDouble(addend);
    e >>= 1n;
  }
  return toAffine(result);
}

function add(a, b) {
  return toAffine(jAdd(toJacobian(a), toJacobian(b)));
}

function bigToBuf32(n) {
  return Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
}

function bufToBig(buf) {
  return buf.length === 0 ? 0n : BigInt('0x' + Buffer.from(buf).toString('hex'));
}

function isOnCurve(x, y) {
  return x > 0n && x < P && y > 0n && y < P && mod(y * y) === mod(x * x * x + 7n);
}

/** 32-byte private scalar (BigInt) -> 64-byte raw public key (x||y). */
function privateToPublic(priv) {
  const pt = mul(mod(priv, N), G);
  if (!pt) throw new Error('invalid private key');
  return Buffer.concat([bigToBuf32(pt[0]), bigToBuf32(pt[1])]);
}

/** Recover the 64-byte public key from an Ethereum-style signature. */
function recoverPubkey(msgHash, r, s, recid, ErrorClass = Error) {
  if (!(r >= 1n && r < N && s >= 1n && s < N) || (recid !== 0 && recid !== 1)) {
    throw new ErrorClass('Invalid signature values');
  }
  const x = r;
  const alpha = mod(x * x * x + 7n);
  const beta = modPow(alpha, (P + 1n) / 4n, P);
  if (mod(beta * beta) !== alpha) throw new ErrorClass('Signature point is not on the curve');
  const y = Number(beta & 1n) === recid ? beta : P - beta;
  const z = bufToBig(msgHash);
  const rInv = modInv(r, N);
  const sR = mul(s, [x, y]);
  const zG = mul(mod(-z, N), G);
  const q = mul(rInv, add(sR, zG));
  if (!q) throw new ErrorClass('Recovered point at infinity');
  return Buffer.concat([bigToBuf32(q[0]), bigToBuf32(q[1])]);
}

/** Deterministic signer used by tests and helper tooling (low-s, recid). */
function ethSign(privHex, msgHash) {
  const priv = BigInt('0x' + privHex);
  const z = bufToBig(msgHash);
  const kSeed = crypto.createHmac('sha256', bigToBuf32(priv)).update(msgHash).digest();
  let k = (bufToBig(kSeed) % (N - 1n)) + 1n;
  for (;;) {
    const pt = mul(k, G);
    let r = pt[0] % N;
    let s = (modInv(k, N) * (z + r * priv)) % N;
    if (r !== 0n && s !== 0n) {
      let recid = Number(pt[1] & 1n) | (pt[0] >= N ? 2 : 0);
      if (s > N / 2n) {
        s = N - s;
        recid ^= 1;
      }
      return { r, s, recid };
    }
    k = (k % (N - 1n)) + 1n;
  }
}

// ---- Native (SHA-1, raw r||s) ECDSA through Node's crypto ------------------

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

function strictHex(hex, what = 'hex') {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${what} is not valid hex`);
  }
  return Buffer.from(hex, 'hex');
}

/** Accepts 64-byte raw, 65-byte 04-prefixed, or 33-byte compressed public keys. */
function parsePublicKey(hex) {
  const raw = strictHex(hex, 'public key');
  let x;
  let y;
  if (raw.length === 64) {
    x = bufToBig(raw.subarray(0, 32));
    y = bufToBig(raw.subarray(32));
  } else if (raw.length === 65 && (raw[0] === 4 || raw[0] === 6 || raw[0] === 7)) {
    x = bufToBig(raw.subarray(1, 33));
    y = bufToBig(raw.subarray(33));
  } else if (raw.length === 33 && (raw[0] === 2 || raw[0] === 3)) {
    x = bufToBig(raw.subarray(1));
    const beta = modPow(mod(x * x * x + 7n), (P + 1n) / 4n, P);
    y = Number(beta & 1n) === (raw[0] & 1) ? beta : P - beta;
  } else {
    throw new Error('Unsupported public key encoding');
  }
  if (!isOnCurve(x, y)) throw new Error('Public key is not on the curve');
  return { x, y };
}

function publicKeyObject(hex) {
  const { x, y } = parsePublicKey(hex);
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'secp256k1', x: b64u(bigToBuf32(x)), y: b64u(bigToBuf32(y)) },
    format: 'jwk',
  });
}

function privateKeyObject(privHex) {
  const d = BigInt('0x' + privHex);
  const pub = privateToPublic(d);
  return crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'secp256k1',
      d: b64u(bigToBuf32(d)), x: b64u(pub.subarray(0, 32)), y: b64u(pub.subarray(32)),
    },
    format: 'jwk',
  });
}

/** Verify a python-ecdsa style signature (SHA-1, 64-byte r||s). */
function verifyNative(pubHex, data, sigHex) {
  const sig = strictHex(sigHex, 'signature');
  if (sig.length !== 64) return false;
  return crypto.verify('sha1', data, { key: publicKeyObject(pubHex), dsaEncoding: 'ieee-p1363' }, sig);
}

/** Sign like python-ecdsa's SigningKey.sign(): SHA-1, raw 64-byte r||s, as hex. */
function signNative(privHex, data) {
  const sig = crypto.sign('sha1', data, { key: privateKeyObject(privHex), dsaEncoding: 'ieee-p1363' });
  return sig.toString('hex');
}

/** Random valid private key as 64 hex chars. */
function generatePrivateKey() {
  for (;;) {
    const buf = crypto.randomBytes(32);
    const k = bufToBig(buf);
    if (k >= 1n && k < N) return buf.toString('hex');
  }
}

module.exports = {
  P, N, G, mod, modInv, modPow, mul, add, bigToBuf32, bufToBig, isOnCurve,
  privateToPublic, recoverPubkey, ethSign, strictHex, parsePublicKey,
  verifyNative, signNative, generatePrivateKey,
};
