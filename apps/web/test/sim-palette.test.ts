import assert from 'node:assert/strict';
import test from 'node:test';
import {simPaletteColor,simPaletteIndex} from '../src/sim-palette.ts';

test('S57 palette ranks SIMs by (slotIndex, id) regardless of input order',()=>{
 const sims=[{id:'b',slotIndex:0},{id:'z',slotIndex:null},{id:'a',slotIndex:1},{id:'a0',slotIndex:0}];
 const reversed=[...sims].reverse();
 for(const list of [sims,reversed])assert.deepEqual(['a0','b','a','z'].map(id=>simPaletteIndex({id},list)),[0,1,2,3]);
});

test('S57 palette uses the eight fixed colors first, then distinct deterministic golden-angle colors',()=>{
 const sims=Array.from({length:40},(_,i)=>({id:`sim-${String(i).padStart(2,'0')}`,slotIndex:i}));
 assert.deepEqual(sims.slice(0,8).map(s=>simPaletteColor(s,sims).light),['#2457C5','#147D78','#B45309','#7C3AED','#BE185D','#4338CA','#8A5A2B','#0E7490']);
 assert.deepEqual(sims.slice(0,8).map(s=>simPaletteColor(s,sims).dark),['#66A8FF','#63D3CC','#FDBA74','#C4B5FD','#F9A8D4','#A5B4FC','#E0B48A','#67E8F9']);
 const rest=sims.slice(8).map(s=>simPaletteColor(s,sims));
 assert.equal(new Set(rest.map(c=>c.light)).size,rest.length);
 assert.equal(new Set(rest.map(c=>c.dark)).size,rest.length);
 assert.deepEqual(sims.slice(8).map(s=>simPaletteColor(s,[...sims].reverse())),rest);
 assert.match(rest[0].light,/^#[0-9A-F]{6}$/);
});

test('S57 fallback light colors keep white text at 4.5:1 for indices 8..63',()=>{
 const lum=(hex:string)=>{const [r,g,b]=[1,3,5].map(i=>{const c=parseInt(hex.slice(i,i+2),16)/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};
 const sims=Array.from({length:64},(_,i)=>({id:`s${i}`,slotIndex:i}));
 for(const s of sims.slice(8)){const c=simPaletteColor(s,sims).light;assert.ok(1.05/(lum(c)+0.05)>=4.5,`${s.id} ${c}`);}
});
