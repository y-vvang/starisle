'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hash, verify } = require('../app/auth/password');

test('哈希结果不包含明文', async () => {
  const h = await hash('correct horse battery staple');
  assert.ok(!h.includes('correct'));
  assert.match(h, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
});

test('同一密码两次哈希不同(盐生效)', async () => {
  const a = await hash('same-password');
  const b = await hash('same-password');
  assert.notStrictEqual(a, b);
});

test('正确密码通过', async () => {
  const h = await hash('s3cret-pw');
  assert.strictEqual(await verify('s3cret-pw', h), true);
});

test('错误密码不通过', async () => {
  const h = await hash('s3cret-pw');
  assert.strictEqual(await verify('s3cret-pwX', h), false);
  assert.strictEqual(await verify('', h), false);
});

test('畸形存储值返回 false 而不是抛异常', async () => {
  for (const bad of ['', 'garbage', 'scrypt$1$2$3', 'bcrypt$x$y$z$w']) {
    assert.strictEqual(await verify('any', bad), false, `畸形值应返回 false: ${bad}`);
  }
});

test('长度不同的哈希不会因 timingSafeEqual 抛异常', async () => {
  const h = await hash('pw');
  const tampered = h.slice(0, -4);           // 截断 base64
  assert.strictEqual(await verify('pw', tampered), false);
});

test('哈希头部锁定 scrypt 代价参数,防止将来被无声调低', async () => {
  const h = await hash('any-password');
  const [scheme, n, r, p] = h.split('$');
  assert.strictEqual(scheme, 'scrypt');
  assert.strictEqual(Number(n), 65536);
  assert.strictEqual(Number(r), 8);
  assert.strictEqual(Number(p), 2);
});
