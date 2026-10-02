import assert from 'node:assert/strict';
import test from 'node:test';
import {isOpenableUrl,smsLinkSegments} from '../src/sms-links.ts';

const links=(body:string)=>smsLinkSegments(body).filter(s=>s.url).map(s=>s.url);

test('S87 shared vectors',()=>{
 assert.deepEqual(links('验证码见 https://a.com/x?y=1，请查收'),['https://a.com/x?y=1']);
 assert.deepEqual(links('点击 t.cn/A6abc 退订回T'),['http://t.cn/A6abc']);
 assert.deepEqual(links('访问 www.10086.cn。'),['http://www.10086.cn']);
 assert.deepEqual(links('(详见 https://x.org/a).'),['https://x.org/a']);
 assert.deepEqual(links('两个链接 https://a.cn 和 b.com/c'),['https://a.cn','http://b.com/c']);
 assert.deepEqual(links('HTTP://EXAMPLE.COM/A'),['HTTP://EXAMPLE.COM/A']);
 assert.deepEqual(links('邮箱 foo@bar.com'),[]);
 assert.deepEqual(links('版本 3.5.1 价格 12.50'),[]);
 assert.deepEqual(links('abc.community'),[]);
 assert.deepEqual(links('ftp://x.com'),[]);
 assert.deepEqual(links('https://'),[]);
 assert.deepEqual(links(''),[]);
});

test('segments keep every character of the body in order',()=>{
 for(const body of ['(详见 https://x.org/a).','两个链接 https://a.cn 和 b.com/c','点击 t.cn/A6abc 退订回T','https://.'])
  assert.equal(smsLinkSegments(body).map(s=>s.text).join(''),body);
 assert.deepEqual(smsLinkSegments('(详见 https://x.org/a).'),[{text:'(详见 '},{text:'https://x.org/a',url:'https://x.org/a'},{text:').'}]);
});

test('only http(s) is openable',()=>{
 assert.ok(isOpenableUrl('https://a.com/x'));
 assert.ok(isOpenableUrl('HTTP://EXAMPLE.COM/A'));
 assert.ok(!isOpenableUrl('javascript:alert(1)'));
 assert.ok(!isOpenableUrl('ftp://x.com'));
 assert.ok(!isOpenableUrl('not a url'));
});
