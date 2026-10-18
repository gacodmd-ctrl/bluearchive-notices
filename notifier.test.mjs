import test from 'node:test';
import assert from 'node:assert/strict';
import {SOURCES, ROLE_ID, parseItems, pendingItems, payload, postDiscord} from './notifier.mjs';

test('Japanese headline uses summary, not category label', () => {
  const [item] = parseItems(SOURCES.at(-1), {meta:{ok:true},data:{rows:[{id:9,title:'メンテナンス',summary:'Maintenance date',publishTime:1000}]}});
  assert.equal(item.title, 'Maintenance date');
  assert.equal(item.url, 'https://bluearchive.jp/news/newsJump/9');
});
test('old, seen and repeated records do not notify; new records sort chronologically', () => {
  const items = [{id:'1',published:10},{id:'2',published:50},{id:'3',published:40},{id:'3',published:40},{id:'4',published:60}];
  assert.deepEqual(pendingItems(items, {startedAt:30,seen:['2']}).map(x=>x.id), ['3','4']);
});
test('only the requested role can be pinged, including hostile headline text', () => {
  const body = payload(SOURCES[0], {title:'@everyone <@123> notice',url:'https://forum.nexon.com/',published:1000});
  assert.deepEqual(body.allowed_mentions, {parse:[],roles:[ROLE_ID],users:[],replied_user:false});
  assert.ok(body.content.includes(`<@&${ROLE_ID}>`));
});
test('invalid official feed fails rather than appearing as no new notices', () => {
  assert.throws(()=>parseItems(SOURCES[0],{}));
  assert.throws(()=>parseItems(SOURCES.at(-1),{meta:{ok:false},data:{rows:[]}}));
});
test('send success requires receipt and ambiguous errors are not blindly retried', async () => {
  let calls = 0;
  await assert.rejects(postDiscord('https://discord.com/api/webhooks/123/fake', {}, async()=>{calls++; throw Error('network');}), /uncertain/);
  assert.equal(calls,1);
  assert.deepEqual(await postDiscord('https://discord.com/api/webhooks/123/fake',{}, async()=>({ok:true,status:200,json:async()=>({id:'456'})})),{id:'456'});
});
