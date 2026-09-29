/** S57 配色：颜色序号 = SIM 在账号列表按 (slotIndex, id) 升序的名次；与展示顺序、在线与否无关。 */
const LIGHT=['#2457C5','#147D78','#B45309','#7C3AED','#BE185D','#4338CA','#8A5A2B','#0E7490'];
const DARK=['#66A8FF','#63D3CC','#FDBA74','#C4B5FD','#F9A8D4','#A5B4FC','#E0B48A','#67E8F9'];

type PaletteSim={id:string;slotIndex?:number|null};

export function simPaletteIndex(sim:PaletteSim,sims:readonly PaletteSim[]):number{
 const slot=(s:PaletteSim)=>s.slotIndex??Number.MAX_SAFE_INTEGER;
 const ranked=[...sims].sort((a,b)=>slot(a)-slot(b)||(a.id<b.id?-1:a.id>b.id?1:0));
 return Math.max(0,ranked.findIndex(s=>s.id===sim.id));
}

function hslHex(h:number,s:number,l:number):string{
 const a=s*Math.min(l,1-l),f=(n:number)=>{const k=(n+h/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1))));};
 return '#'+[f(0),f(8),f(4)].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase();
}

/** 序号 0–7 固定色，≥8 黄金角色相（浅 hsl(h,65%,28%) / 深 hsl(h,80%,75%)）。 */
export function simPaletteColor(sim:PaletteSim,sims:readonly PaletteSim[]):{light:string;dark:string}{
 const i=simPaletteIndex(sim,sims);
 if(i<LIGHT.length)return {light:LIGHT[i],dark:DARK[i]};
 const h=(i*137.508+20)%360;
 return {light:hslHex(h,.65,.28),dark:hslHex(h,.8,.75)};
}
