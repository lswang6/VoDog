import test from 'node:test';
import assert from 'node:assert/strict';
import {EMPTY_BADGES,badgeLabel,callAwaitsReview,callShowsDot,threadHasUnread,decrementBadges,navBadgeCount,parseBadges,simBadgeCount} from '../src/badges.ts';

const badges={calls:3,sms:120,sims:[{simId:'a',calls:2,sms:100},{simId:'b',calls:1,sms:20}]};

test('S67: badge label hides 0 and caps at 99+',()=>{
 assert.equal(badgeLabel(0),'');
 assert.equal(badgeLabel(-1),'');
 assert.equal(badgeLabel(1),'1');
 assert.equal(badgeLabel(99),'99');
 assert.equal(badgeLabel(100),'99+');
});

test('S67: nav shows calls on 通话, sms on 短信, nothing elsewhere',()=>{
 assert.equal(navBadgeCount(badges,'通话'),3);
 assert.equal(navBadgeCount(badges,'短信'),120);
 assert.equal(navBadgeCount(badges,'记录'),0);
});

test('S67: SIM chip count follows the tab and sums elsewhere',()=>{
 assert.equal(simBadgeCount(badges,'a','通话'),2);
 assert.equal(simBadgeCount(badges,'a','短信'),100);
 assert.equal(simBadgeCount(badges,'a','记录'),102);
 assert.equal(simBadgeCount(badges,'missing','设置'),0);
});

test('S67: malformed /badges bodies are rejected so the last value is kept',()=>{
 for(const raw of [null,{},{calls:1,sms:2},{calls:'1',sms:0,sims:[]},'x'])assert.equal(parseBadges(raw),null);
 assert.deepEqual(parseBadges({calls:1,sms:0,sims:[{simId:'a',calls:1,sms:0},{bad:true}]}),{calls:1,sms:0,sims:[{simId:'a',calls:1,sms:0}]});
});

test('S67: optimistic decrement clamps at zero and only touches its SIM',()=>{
 const next=decrementBadges(badges,'b','calls',5);
 assert.equal(next.calls,0);
 assert.deepEqual(next.sims,[{simId:'a',calls:2,sms:100},{simId:'b',calls:0,sms:20}]);
 assert.equal(decrementBadges(EMPTY_BADGES,'a','sms',0),EMPTY_BADGES);
});

test('S67: only missed or AI-answered incoming calls decrement locally',()=>{
 const base={direction:'incoming',state:'ended'};
 assert.equal(callAwaitsReview(base),true);
 assert.equal(callAwaitsReview({...base,answeredAt:'t',answeredByPlatform:'ai'}),true);
 assert.equal(callAwaitsReview({...base,answeredAt:'t',conflictDisposition:'ai_answered'}),true);
 assert.equal(callAwaitsReview({...base,answeredAt:'t',answeredByPlatform:'web'}),false);
 assert.equal(callAwaitsReview({...base,failureReason:'number_blocked'}),false);
 assert.equal(callAwaitsReview({...base,direction:'outgoing'}),false);
 assert.equal(callAwaitsReview({...base,state:'incoming_ringing'}),false);
});

test('S67c: call row dot follows unseen and hides once opened locally',()=>{
 const none=new Set<string>();
 assert.equal(callShowsDot({id:'c1',unseen:true},none),true);
 assert.equal(callShowsDot({id:'c1',unseen:false},none),false);
 assert.equal(callShowsDot({id:'c1'},none),false);
 assert.equal(callShowsDot({id:'c1',unseen:true},new Set(['c1'])),false);
});

test('S67c: thread dot when any message is unread and not yet marked locally',()=>{
 const none=new Set<string>();
 assert.equal(threadHasUnread([{id:'a'},{id:'b',unread:false}],none),false);
 assert.equal(threadHasUnread([{id:'a'},{id:'b',unread:true}],none),true);
 assert.equal(threadHasUnread([{id:'a',unread:true},{id:'b',unread:true}],new Set(['a'])),true);
 assert.equal(threadHasUnread([{id:'a',unread:true},{id:'b',unread:true}],new Set(['a','b'])),false);
 assert.equal(threadHasUnread([],none),false);
});

test('S72: internal calls never await review',()=>{
 assert.equal(callAwaitsReview({direction:'incoming',state:'ended',internal:true}),false);
 assert.equal(callAwaitsReview({direction:'incoming',state:'ended'}),true);
});
