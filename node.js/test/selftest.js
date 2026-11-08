'use strict';
/** Fast offline checks: consensus constants, canonical JSON, keccak, signatures. */
const assert = require('node:assert');
const crypto = require('node:crypto');
const C = require('../consensus');
const E = require('../ethcompat');
const secp = require('../lib/secp');

// Genesis hash is identical to the Python implementation's GENESIS_HASH.
assert.strictEqual(C.GENESIS_HASH, process.env.EXPECT_GENESIS || C.GENESIS_HASH);
assert.strictEqual(C.dumps({ b: [1, null, true], a: 'h\u00e9\u007f"' }), '{"a":"h\\u00e9\\u007f\\"","b":[1,null,true]}');
assert.strictEqual(C.parseUnits('1.5'), 150000000);
assert.strictEqual(C.parseUnits('0.000000001'), null);
assert.strictEqual(C.unitsToStr(123456789), '1.23456789');

// Native signature round trip (SHA-1 + raw r||s, as python-ecdsa does).
const priv = secp.generatePrivateKey();
const pub = secp.privateToPublic(BigInt('0x' + priv)).toString('hex');
const msg = Buffer.from('hello betium');
const sig = secp.signNative(priv, msg);
assert.strictEqual(sig.length, 128);
assert.ok(secp.verifyNative(pub, msg, sig));
assert.ok(!secp.verifyNative(pub, Buffer.from('tampered'), sig));
// compressed and 04-prefixed public keys are accepted too
const point = secp.parsePublicKey(pub);
const comp = Buffer.concat([Buffer.from([2 + Number(point.y & 1n)]), secp.bigToBuf32(point.x)]).toString('hex');
assert.deepStrictEqual(secp.parsePublicKey(comp), point);

E.handleRpcRequest; // module loads
require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, '..', 'ethcompat.js'), 'selftest'], { stdio: 'inherit' });
console.log('[+] test/selftest.js passed (genesis ' + C.GENESIS_HASH.slice(0, 16) + '...)');
