import React,{useEffect,useRef,useState,useCallback}from'react';
import'./App.css';

const EL=['🔥','💧','🌍','💨','✨','⚡','❄️','🌿'];
const EN_ELEM=['Fire','Water','Earth','Air','Aether','Lightning','Ice','Nature'];
// Perceptually-distinct palette for dark background.
// Based on ColorBrewer Dark2 hue positions, reordered for best n=3..8 subsets,
// with L and S varied to compensate for close hue pairs (Tableau Paired technique).
// n=3: 95° min gap (orange / blue / green — maximally distinct)
// n=4..6: 43°+ min gap — all clearly different
// n=7..8: 28° hue gap but ΔL=14% ΔS=28% (vivid orange vs pale rose — very different)
// [hue, saturation%, lightness%]
// 8 perceptually distinct colors — no two look similar.
// orange / blue / green / yellow / violet / teal / light-pink / indigo
// Close hue pairs differ in lightness: orange L=62 vs yellow L=72, teal L=55 vs indigo L=56→more sat
const ELC=[
  [ 12, 96, 62],  // 🔥 orange-red   — fire        vivid L=62
  [213, 88, 66],  // 💧 sky blue     — water
  [130, 68, 50],  // 🌍 forest green — earth        dark
  [ 52, 98, 72],  // 💨 yellow       — air          bright L=72
  [292, 80, 62],  // ✨ violet       — aether
  [176, 84, 55],  // ⚡ teal-cyan    — lightning
  [330, 75, 80],  // ❄️ light pink   — ice          very light L=80
  [248, 78, 56],  // 🌿 indigo       — nature        deep L=56
];
const PC=['#4f8ef7','#f05252'];
const EMPTY=255;
const KN=[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const elc=n=>ELC.slice(0,n).map(([h,s,l])=>`hsl(${h},${s}%,${l}%)`);
const pad2=n=>String(n).padStart(2,'0');
const fmtT=s=>`${pad2(Math.floor(s/60))}:${pad2(s%60)}`;
const coord=(r,c)=>String.fromCharCode(65+c)+(r+1);

// ── AUDIO ─────────────────────────────────────────
class SFX{
  constructor(){this._ctx=null}
  _ac(){try{return this._ctx||(this._ctx=new(window.AudioContext||window.webkitAudioContext)())}catch{return null}}
  _t(f,tp,d,v=.13,dl=0){
    const c=this._ac();if(!c)return;
    try{const o=c.createOscillator(),g=c.createGain();
      o.connect(g);g.connect(c.destination);o.type=tp;o.frequency.value=f;
      g.gain.setValueAtTime(v,c.currentTime+dl);
      g.gain.exponentialRampToValueAtTime(.001,c.currentTime+dl+d);
      o.start(c.currentTime+dl);o.stop(c.currentTime+dl+d)}catch{}}
  select(){this._t(440,'sine',.1,.1)}
  move(){this._t(330,'sine',.07,.1);this._t(495,'sine',.09,.08,.06)}
  merge(){[220,330,440,550].forEach((f,i)=>this._t(f,'triangle',.14,.11,i*.05))}
  capture(){this._t(150,'sawtooth',.07,.13);this._t(260,'sawtooth',.1,.1,.06);this._t(400,'sine',.12,.08,.13)}
  win(){[523,659,784,1047].forEach((f,i)=>this._t(f,'sine',.3,.14,i*.11))}
  undo(){this._t(220,'sawtooth',.08,.08)}
}
const sfx=new SFX();

// ── ENGINE HELPERS ────────────────────────────────
function mkTargets(sz){
  const w=v=>(v+sz)%sz;
  return Array(sz).fill(0).map((_,r)=>Array(sz).fill(0).map((_,c)=>{
    const seen=new Set();
    return KN.map(([dr,dc])=>[w(r+dr),w(c+dc)]).filter(([tr,tc])=>{
      const k=tr*sz+tc;if(seen.has(k))return false;seen.add(k);return true;
    });
  }));
}
const bts=(v,n)=>{let k=0;for(let i=0;i<n;i++)if(v&(1<<i))k++;return k};

function mkNeutral(sz,n){
  const b=new Uint8Array(sz*sz);
  for(let r=0;r<sz;r++)for(let c=0;c<sz;c++)b[r*sz+c]=1<<((r+c)%n);
  return{board:b,owner:new Uint8Array(sz*sz).fill(EMPTY)};
}
// layout: 'sym' symmetric, 'asym' asymmetric, 'rand' random, 'chaos' chaotic
function mkOwned(sz,n,layout='sym'){
  const b=new Uint8Array(sz*sz),o=new Uint8Array(sz*sz).fill(EMPTY);
  const half=Math.floor(sz/2),mid=Math.floor(sz/2);

  if(layout==='sym'){
    // 5×4: mathematically optimal layout
    // Criteria: 0 same-player knight conflicts, perfect 3×3×3×3 balance,
    // all 4 elements around center diagonally, 0 orthogonal clustering
    // Row0: F A F W E  Row1: E F A E W
    // Row2: W A center F A
    // Row3: E W E A F  Row4: W E W F A
    const SPEC_5x4=[[0,3,0,1,2],[2,0,3,2,1],[1,3,-1,0,3],[2,1,2,3,0],[1,2,1,0,3]];
    if(sz===5&&n===4){
      for(let r=0;r<5;r++)for(let c=0;c<5;c++){
        const i=r*5+c,el=SPEC_5x4[r][c];
        if(el===-1)continue;
        b[i]=1<<el;o[i]=(r<2||(r===2&&c<2))?1:0;
      }
    } else {
      for(let r=0;r<sz;r++)for(let c=0;c<sz;c++){
        const i=r*sz+c;
        if(sz%2===1&&r===mid&&c===mid)continue;
        if(r<half){b[i]=1<<(c%n);o[i]=1;}
        else if(r>=sz-half){b[i]=1<<(c%n);o[i]=0;}
        else if(sz%2===1&&r===mid){const el=Math.min(c,sz-1-c)%n;b[i]=1<<el;o[i]=(c<mid)?1:0;}
      }
    }
  } else if(layout==='asym'){
    // Asymmetric: same piece count but elements assigned differently per side
    for(let r=0;r<sz;r++)for(let c=0;c<sz;c++){
      const i=r*sz+c;
      if(sz%2===1&&r===mid&&c===mid)continue;
      if(r<half){b[i]=1<<((c*3+r)%n);o[i]=1;}           // AI: stripes at angle
      else if(r>=sz-half){b[i]=1<<((c+r)%n);o[i]=0;}    // Human: diagonal
      else if(sz%2===1&&r===mid){const el=(c*2)%n;b[i]=1<<el;o[i]=(c<mid)?1:0;}
    }
  } else if(layout==='rand'){
    // Random: same piece count per player, random element assignment
    const cells0=[],cells1=[];
    for(let r=0;r<sz;r++)for(let c=0;c<sz;c++){
      const i=r*sz+c;
      if(sz%2===1&&r===mid&&c===mid)continue;
      if(r<half)cells1.push(i);
      else if(r>=sz-half)cells0.push(i);
      else if(sz%2===1&&r===mid){(c<mid?cells1:cells0).push(i);}
    }
    cells0.forEach((i,k)=>{b[i]=1<<(k%n);o[i]=0;});
    cells1.forEach((i,k)=>{b[i]=1<<(k%n);o[i]=1;});
    // Shuffle elements randomly
    for(let p=0;p<sz*sz;p++){
      if(o[p]===EMPTY)continue;
      const pool=o[p]===0?cells0:cells1;
      const j=pool[Math.floor(Math.random()*pool.length)];
      const tmp=b[p];b[p]=b[j];b[j]=tmp;
    }
  } else {
    // chaos: pieces spread across entire board, no clear front lines
    // Each player gets sz*half pieces scattered randomly across the whole board
    const allCells=[];
    for(let i=0;i<sz*sz;i++){
      if(sz%2===1&&i===mid*sz+mid)continue;
      allCells.push(i);
    }
    // Shuffle all cells
    for(let i=allCells.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[allCells[i],allCells[j]]=[allCells[j],allCells[i]];}
    const total=allCells.length,half2=Math.floor(total/2);
    for(let k=0;k<total;k++){
      const i=allCells[k];
      o[i]=k<half2?0:1;
      b[i]=1<<(Math.floor(Math.random()*n));
    }
  }
  return{board:b,owner:o};
}

// ── ZOBRIST ───────────────────────────────────────
const ZOB=(()=>{
  const r64=()=>{
    const h=BigInt(Math.floor(Math.random()*0xFFFFFFFF));
    const l=BigInt(Math.floor(Math.random()*0xFFFFFFFF));
    return(h<<32n)|l;
  };
  return{t:Array(64).fill(0).map(()=>Array(256).fill(0).map(()=>[r64(),r64(),r64()])),side:r64()};
})();

// ── AI PARAMS ─────────────────────────────────────
const AI_DEPTH={
  owned:{
    3:{easy:1,medium:2,hard:3,expert:4,impossible:5},
    4:{easy:1,medium:2,hard:3,expert:3,impossible:4},
    5:{easy:1,medium:2,hard:2,expert:3,impossible:3},
    6:{easy:1,medium:1,hard:2,expert:2,impossible:3},
    7:{easy:1,medium:1,hard:2,expert:2,impossible:2},
    8:{easy:1,medium:1,hard:1,expert:2,impossible:2},
  },
  neutral:{
    3:{easy:1,medium:2,hard:3,expert:4,impossible:5},
    4:{easy:1,medium:2,hard:3,expert:4,impossible:5},
    5:{easy:1,medium:2,hard:3,expert:3,impossible:4},
    6:{easy:1,medium:2,hard:3,expert:3,impossible:4},
    7:{easy:1,medium:2,hard:2,expert:3,impossible:3},
    8:{easy:1,medium:2,hard:2,expert:3,impossible:3},
  },
};
const NODE_LIMIT={3:200000,4:80000,5:40000,6:30000,7:20000,8:15000};
const TIME_LIMIT_MS=600;

// ── ENGINE ────────────────────────────────────────
class Engine{
  constructor(sz=5,n=5,owned=false,layout='sym'){
    this.sz=sz;this.n=n;this.owned=owned;this.layout=layout;
    this.win=(1<<n)-1;this.tg=mkTargets(sz);
    this.board=new Uint8Array(sz*sz);this.owner=new Uint8Array(sz*sz).fill(EMPTY);
    this.hash=0n;this.cp=0;this.winner=null;this.wr=null;
    this.mc=0;this.nodes=0;this.tt=new Map();this.hist=[];
    this.reset();
  }
  _i(r,c){return r*this.sz+c}
  _v(r,c){return this.board[this._i(r,c)]}
  _o(r,c){return this.owner[this._i(r,c)]}
  counts(){
    let a=0,b=0;
    for(let i=0;i<this.sz*this.sz;i++){if(this.owner[i]===0)a++;else if(this.owner[i]===1)b++}
    return[a,b];
  }
  moves(){
    const m=[];
    for(let r=0;r<this.sz;r++)for(let c=0;c<this.sz;c++){
      const i=this._i(r,c);if(!this.board[i])continue;
      if(this.owned&&this.owner[i]!==this.cp)continue;
      for(const t of this.tg[r][c])m.push({from:[r,c],to:t});
    }
    return m;
  }
  winMoves(){
    const w=[];
    for(let r=0;r<this.sz;r++)for(let c=0;c<this.sz;c++){
      const i=this._i(r,c);if(!this.board[i])continue;
      if(this.owned&&this.owner[i]!==this.cp)continue;
      const v=this.board[i];
      for(const[tr,tc]of this.tg[r][c])
        if((v|this.board[this._i(tr,tc)])===this.win)w.push({from:[r,c],to:[tr,tc]});
    }
    return w;
  }
  threatMap(){
    const s=new Set();
    this.winMoves().forEach(m=>{s.add(`${m.from[0]},${m.from[1]}`);s.add(`${m.to[0]},${m.to[1]}`)});
    return s;
  }
  capThreat(){
    if(!this.owned)return new Set();
    const s=new Set(),op=1-this.cp;
    for(let r=0;r<this.sz;r++)for(let c=0;c<this.sz;c++){
      if(this.owner[this._i(r,c)]!==op)continue;
      for(const[tr,tc]of this.tg[r][c])
        if(this.owner[this._i(tr,tc)]===this.cp)s.add(`${tr},${tc}`);
    }
    return s;
  }
  _xor(r,c){const i=this._i(r,c),v=this.board[i],o=this.owner[i];if(v)this.hash^=ZOB.t[i<64?i:63][v&255][o===EMPTY?2:o]}
  snap(){return{board:new Uint8Array(this.board),owner:new Uint8Array(this.owner),cp:this.cp,winner:this.winner,wr:this.wr,mc:this.mc,hash:this.hash}}
  load(s){this.board=new Uint8Array(s.board);this.owner=new Uint8Array(s.owner);this.cp=s.cp;this.winner=s.winner;this.wr=s.wr;this.mc=s.mc;this.hash=s.hash;this.tt.clear()}
  move(fr,fc,tr,tc){
    if(this.winner!=null)return{won:false,captured:false};
    const player=this.cp;this.hist.push(this.snap());
    const fi=this._i(fr,fc),ti=this._i(tr,tc);
    const fv=this.board[fi],tv=this.board[ti],to=this.owner[ti];
    this._xor(fr,fc);this._xor(tr,tc);
    const captured=this.owned&&to!==EMPTY&&to!==this.cp;
    const nv=fv|tv;
    this.board[fi]=0;this.owner[fi]=EMPTY;
    this.board[ti]=nv;this.owner[ti]=this.owned?this.cp:EMPTY;
    this._xor(tr,tc);this.mc++;this.hash^=ZOB.side;
    if(nv===this.win){this.winner=player;this.wr='elements';return{won:true,captured,player}}
    if(this.owned){
      const[a,b]=this.counts();
      if((player===0?b:a)===0){this.winner=player;this.wr='annihilation';return{won:true,captured,player}}
    }
    this.cp=1-this.cp;return{won:false,captured,player};
  }
  eval(){
    const pv=[0,60,600,4000,18000,90000,450000,2200000],mid=(this.sz-1)/2,wm=this.win;
    let sc=0;
    for(let r=0;r<this.sz;r++)for(let c=0;c<this.sz;c++){
      const i=this._i(r,c),v=this.board[i],o=this.owner[i];if(!v)continue;
      const cnt=bts(v,this.n),base=pv[cnt]+(this.sz-Math.abs(r-mid)-Math.abs(c-mid))*8;
      const sign=this.owned?(o===this.cp?1:-1):1;
      for(const[tr,tc]of this.tg[r][c]){
        const tv=this.board[this._i(tr,tc)],nv2=v|tv;
        if(nv2===wm)sc+=sign*120000;
        else if(bts(nv2,this.n)===this.n-1)sc+=sign*25000;
        if(this.owned&&this.owner[this._i(tr,tc)]===o&&v!==tv)sc+=sign*cnt*40;
      }
      sc+=sign*base;
    }
    if(this.owned){const[a,b]=this.counts();sc+=((this.cp===0?a:b)-(this.cp===0?b:a))*55}
    return sc;
  }
  minimax(d,a,b,mx,lim,nl){
    this.nodes++;
    if(this.winner!=null)return mx?-9999999:9999999;
    if(!d||Date.now()>lim||this.nodes>nl)return this.eval();
    const key=`${this.hash}:${d}`;
    const cv=this.tt.get(key);if(cv!=null)return cv;
    const ms=this.moves();if(!ms.length)return this.eval();
    ms.sort((x,y)=>{
      const sc=m=>{
        const tv=this._v(m.to[0],m.to[1]),fv=this._v(m.from[0],m.from[1]);
        return((fv|tv)===this.win?100000:0)
          +(this.owned&&this._o(m.to[0],m.to[1])!==EMPTY&&this._o(m.to[0],m.to[1])!==this.cp?3000:0)
          +bts(tv,this.n)*10+bts(fv,this.n)*5;
      };
      return sc(y)-sc(x);
    });
    let best=mx?-Infinity:Infinity;
    for(const m of ms){
      if(Date.now()>lim||this.nodes>nl)break;
      const s=this.snap();this.move(m.from[0],m.from[1],m.to[0],m.to[1]);
      const val=this.minimax(d-1,a,b,!mx,lim,nl);this.load(s);
      if(mx){best=Math.max(best,val);a=Math.max(a,best)}
      else{best=Math.min(best,val);b=Math.min(b,best)}
      if(a>=b)break;
    }
    this.tt.set(key,best);return best;
  }
  aiMove(lvl){
    const mk=this.owned?'owned':'neutral';
    const dm=AI_DEPTH[mk][this.sz]||AI_DEPTH[mk][5];
    const depth=dm[lvl]??2,nl=NODE_LIMIT[this.sz]||30000,lim=Date.now()+TIME_LIMIT_MS;
    this.nodes=0;
    const ms=this.moves();if(!ms.length)return null;
    for(const m of ms){const s=this.snap();const{won}=this.move(m.from[0],m.from[1],m.to[0],m.to[1]);this.load(s);if(won)return m}
    if(Date.now()>lim)return ms[0];
    let best=null,bs=-Infinity;
    for(const m of ms){
      if(Date.now()>lim||this.nodes>nl)break;
      const s=this.snap();this.move(m.from[0],m.from[1],m.to[0],m.to[1]);
      const sc=this.minimax(depth-1,-Infinity,Infinity,false,lim,nl);this.load(s);
      if(sc>bs){bs=sc;best=m}
    }
    return best??ms[0];
  }
  reset(){
    const{board,owner}=this.owned?mkOwned(this.sz,this.n,this.layout):mkNeutral(this.sz,this.n);
    this.board=board;this.owner=owner;this.hash=0n;
    for(let r=0;r<this.sz;r++)for(let c=0;c<this.sz;c++)this._xor(r,c);
    this.winner=null;this.wr=null;this.mc=0;this.cp=0;this.hist=[];this.tt.clear();
  }
}

// ── CONFETTI ──────────────────────────────────────
function spawnConfetti(){
  const cv=document.createElement('canvas');
  cv.style.cssText='position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:999';
  document.body.appendChild(cv);cv.width=window.innerWidth;cv.height=window.innerHeight;
  const ctx=cv.getContext('2d');
  const ps=Array.from({length:90},()=>({
    x:Math.random()*cv.width,y:-20,
    vx:(Math.random()-.5)*4,vy:Math.random()*4+2,
    col:`hsl(${Math.random()*360},80%,60%)`,
    sz:Math.random()*8+4,rot:Math.random()*360,rv:(Math.random()-.5)*8,
  }));
  let raf;
  const draw=()=>{
    ctx.clearRect(0,0,cv.width,cv.height);let alive=false;
    ps.forEach(p=>{p.x+=p.vx;p.y+=p.vy;p.rot+=p.rv;p.vy+=.1;
      if(p.y<cv.height+20)alive=true;
      ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.rot*Math.PI/180);
      ctx.fillStyle=p.col;ctx.fillRect(-p.sz/2,-p.sz/2,p.sz,p.sz*.6);ctx.restore()});
    if(alive)raf=requestAnimationFrame(draw);else cv.remove();
  };
  draw();setTimeout(()=>{cancelAnimationFrame(raf);cv.remove()},5000);
}

// ── useEngine ─────────────────────────────────────
function useEngine(sz,n,owned,layout){
  // Engine lives in a ref — never recreated by React renders
  const engRef=useRef(null);
  if(!engRef.current||engRef.current.sz!==sz||engRef.current.n!==n||engRef.current.owned!==owned||engRef.current.layout!==layout){
    engRef.current=new Engine(sz,n,owned,layout);
  }

  const[tick,setTick]=useState(0);
  const refresh=useCallback(()=>setTick(t=>t+1),[]);

  // Stable functions that always read from the live ref
  const doMove=useCallback((fr,fc,tr,tc)=>{
    const r=engRef.current.move(fr,fc,tr,tc);refresh();return r;
  },[refresh]);
  const doReset=useCallback(()=>{engRef.current.reset();refresh()},[refresh]);
  const doUndo=useCallback(()=>{
    const e=engRef.current;
    if(e.hist.length>0){e.load(e.hist.pop());sfx.undo();refresh()}
  },[refresh]);
  const getAI=useCallback(l=>engRef.current.aiMove(l),[]);
  const getWinMoves=useCallback(()=>engRef.current.winMoves(),[]);
  const getThreatMap=useCallback(()=>engRef.current.threatMap(),[]);
  const getCapThreat=useCallback(()=>engRef.current.capThreat(),[]);

  // Derive snapshot from live engine on every tick
  const e=engRef.current;
  const rows=[];
  for(let r=0;r<e.sz;r++){
    const row=[];
    for(let c=0;c<e.sz;c++){
      const i=e._i(r,c),v=e.board[i],o=e.owner[i];
      const idx=[];for(let k=0;k<e.n;k++)if(v&(1<<k))idx.push(k);
      row.push({idx,own:o});
    }
    rows.push(row);
  }
  const wm=e.winner==null?e.winMoves():[];

  return{
    eng:engRef.current,
    board:rows,cp:e.cp,winner:e.winner,wr:e.wr,mc:e.mc,
    nodes:e.nodes,canUndo:e.hist.length>0,counts:e.counts(),
    wm,
    thr:e.winner==null?e.threatMap():new Set(),
    ct:owned&&e.winner==null?e.capThreat():new Set(),
    doMove,reset:doReset,undo:doUndo,
    getAI,getWinMoves,getThreatMap,getCapThreat,
    // expose ref for imperative checks (avoids stale closure issues in AI timer)
    engRef,
  };
}

// ── useTimer ──────────────────────────────────────
function useTimer(){
  const[secs,setSecs]=useState(0);
  const iv=useRef(null),base=useRef(Date.now()),active=useRef(true);
  useEffect(()=>{
    iv.current=setInterval(()=>{if(active.current)setSecs(Math.floor((Date.now()-base.current)/1000))},500);
    return()=>clearInterval(iv.current);
  },[]);
  return{
    t:secs,fmt:fmtT(secs),
    stop:useCallback(()=>{active.current=false},[]),
    reset:useCallback(()=>{active.current=true;base.current=Date.now();setSecs(0)},[]),
  };
}


// ── useCellSize ───────────────────────────────────
// Computes the largest cell size that fits the board on screen.
// Accounts for: header, player strips, status bar, settings, legend,
// padding, gap between cells — everything that takes vertical/horizontal space.
function useCellSize(sz, owned){
  const[cell,setCell]=useState(64);
  useEffect(()=>{
    function calc(){
      const vw=window.innerWidth;
      const vh=window.innerHeight;
      // Estimate reserved vertical space (px): header+strips+statusbar+settings+legend+padding
      const reservedV = owned
        ? (40+42+42+38+42+36+60)  // header+2strips+sbar+settings+legend+padding+gaps
        : (40+38+42+36+60);       // header+sbar+settings+legend+padding+gaps
      const reservedH = vw < 700
        ? 24                       // narrow: only padding
        : 176+10+24;               // side panel + gap + padding
      const availH = Math.max(vh - reservedV, 160);
      const availW = Math.max(vw - reservedH, 160);
      const gapTotal = (sz-1)*5;
      const wrapPad  = Math.min(12, Math.floor(vw*0.012))*2;
      const fromH = Math.floor((availH - wrapPad - gapTotal) / sz);
      const fromW = Math.floor((availW - wrapPad - gapTotal) / sz);
      const raw = Math.min(fromH, fromW);
      // Clamp: min 36px (legible), max 96px (no need to be bigger)
      setCell(Math.max(36, Math.min(96, raw)));
    }
    calc();
    window.addEventListener('resize', calc);
    return()=>window.removeEventListener('resize', calc);
  },[sz, owned]);
  return cell;
}

// ── PIECE ─────────────────────────────────────────
const Piece=React.memo(({idx,own,theme,colors,owned})=>{
  if(!idx.length)return null;
  const bg=owned?(own===0?'o0':own===1?'o1':'n'):'n';
  if(theme==='colors'){
    const step=360/idx.length;
    const grad=idx.length===1?colors[idx[0]]
      :`conic-gradient(${idx.map((x,i)=>`${colors[x]} ${i*step}deg ${(i+1)*step}deg`).join(',')})`;
    return<><div className={`pbg ${bg}`}/><div className="pdisc" style={{background:grad}}/></>;
  }
  return<><div className={`pbg ${bg}`}/><div className={`pels c${idx.length}`}>{idx.map(x=><span key={x} className="el">{EL[x]}</span>)}</div></>;
});

// ── BOARD ─────────────────────────────────────────
const Board=React.memo(({board,theme,sel,validMoves,onClick,colors,wm,hints,cp,owned,lastMove,thr,ct,cellPx})=>{
  const sz=board.length,mid=Math.floor(sz/2);
  const wF=new Set(wm.map(m=>`${m.from[0]},${m.from[1]}`));
  const wT=new Set(wm.map(m=>`${m.to[0]},${m.to[1]}`));
  return(
    <div className="bwrap" style={{'--cell':`${cellPx}px`,'--gap':`${Math.max(3,Math.round(cellPx*0.07))}px`}}>
      <div className="board" style={{gridTemplateColumns:`repeat(${sz},var(--cell))`,gridTemplateRows:`repeat(${sz},var(--cell))`}}>
        {board.map((row,r)=>row.map(({idx,own},c)=>{
          const key=`${r},${c}`;
          const isSel=sel?.r===r&&sel?.c===c;
          // isV: this cell is a valid move target (not the selected cell itself)
          const isV=!isSel&&validMoves.some(([nr,nc])=>nr===r&&nc===c);
          const isWF=wF.has(key),isWT=wT.has(key);
          const isLast=lastMove&&(
            (lastMove.from[0]===r&&lastMove.from[1]===c)||
            (lastMove.to[0]===r&&lastMove.to[1]===c));
          const isCtr=owned&&sz%2===1&&r===mid&&c===mid&&own===EMPTY;
          const cls=[
            'cell',
            isSel ?'sel' :'',
            isV   ?'valid':'',   // ALL valid targets → green ring only, no other class
            isLast?'last':'',
            isWF  ?'wf'  :'',
            isWT  ?'wt'  :'',
            hints&&thr.has(key)&&!isWF&&!isWT?'thr':'',
            hints&&owned&&ct.has(key)?'ct':'',
            own===EMPTY?'mt':'',
            isCtr ?'nctr':'',
          ].filter(Boolean).join(' ');
          return(
            <div key={key} className={cls} onClick={()=>onClick(r,c)}>
              <Piece idx={idx} own={own} theme={theme} colors={colors} owned={owned}/>
            </div>
          );
        }))}
      </div>
    </div>
  );
});

// ── PLAYER STRIP ──────────────────────────────────
const PlayerStrip=React.memo(({p,label,active,counts,totalPieces,collectedSet,n})=>{
  const cnt=counts[p],pct=Math.min(100,Math.round(cnt/Math.max(totalPieces,1)*100));
  return(
    <div className={`pstrip p${p}${active?' active':''}`}>
      <div className="ps-av">{p===0?'You':'AI'}</div>
      <div className="ps-info">
        <div className="ps-name">{label}</div>
        <div className={`ps-st${active?' on':''}`}>{active?'YOUR TURN ▶':'waiting'}</div>
      </div>
      <div className="ps-els">
        {Array.from({length:n},(_,k)=>(
          <div key={k} className={`eldot ${collectedSet.has(k)?'have':'miss'}`} title={EN_ELEM[k]}>{EL[k]}</div>
        ))}
      </div>
      <div className="ps-cnt">
        <div className="ps-num">{cnt}</div>
        <div className="ps-bw"><div className="ps-bf" style={{width:`${pct}%`}}/></div>
      </div>
    </div>
  );
});

// ── INFO CARD ─────────────────────────────────────
const InfoCard=React.memo(({selCell,eng,colors,owned})=>{
  if(!selCell)return<div className="panel info-empty">Click a piece<br/>to inspect it</div>;
  const i=eng._i(selCell.r,selCell.c),v=eng.board[i],o=eng.owner[i];
  const idx=[];for(let k=0;k<eng.n;k++)if(v&(1<<k))idx.push(k);
  const pct=Math.round(idx.length/eng.n*100);
  return(
    <div className="panel">
      {owned&&o!==EMPTY&&(
        <div className="iowner" style={{background:`${PC[o]}22`,color:PC[o],border:`1px solid ${PC[o]}44`}}>
          {o===0?'Your piece':"Opponent's piece"}
        </div>
      )}
      <div className="slbl">Composition</div>
      <div className="progrow">
        <div className="progt"><div className="progf" style={{width:`${pct}%`}}/></div>
        <span className="progp">{pct}%</span>
      </div>
      <div className="echips">
        {Array.from({length:eng.n},(_,k)=>(
          <span key={k} className={`echip ${idx.includes(k)?'have':'miss'}`}
            style={idx.includes(k)?{'--ec':colors[k]}:{}}>
            {EL[k]} {EN_ELEM[k]}
          </span>
        ))}
      </div>
    </div>
  );
});

// ── MOVE LOG ──────────────────────────────────────
const MoveLog=React.memo(({moveLog,owned})=>{
  const ref=useRef(null);
  useEffect(()=>{if(ref.current)ref.current.scrollTop=ref.current.scrollHeight},[moveLog]);
  if(!moveLog.length)return null;
  const recent=moveLog.slice(-30),offset=moveLog.length-recent.length;
  return(
    <div className="panel">
      <div className="slbl">Move Log</div>
      <div ref={ref} className="log-list">
        {recent.map((h,k)=>(
          <div key={k} className="logrow">
            <span className="lnum">{offset+k+1}.</span>
            <span className="ldot" style={{background:PC[h.p]}}/>
            <span className="lmv">{coord(h.from[0],h.from[1])}→{coord(h.to[0],h.to[1])}</span>
            {owned&&h.cap&&<span className="lcap">⚔️</span>}
          </div>
        ))}
      </div>
    </div>
  );
});

// ── WIN SCREEN ────────────────────────────────────
// Uses a stable ref for onRematch so the 4-second timer always
// calls the *current* reset function even after re-renders.
const WinScreen=React.memo(({winner,wr,mode,owned,mc,elapsed,onRematch})=>{
  const title=winner===0
    ?(mode==='vsAI'?'You won!':'Player 1 wins!')
    :(mode==='vsAI'?'AI wins!':'Player 2 wins!');
  const reason=owned
    ?(wr==='elements'?'⚗️ All elements collected':'⚔️ All enemy pieces destroyed')
    :'⚗️ All elements collected';
  return(
    <div className="win-mask"><div className="win-box">
      <div className="wico">{owned&&wr==='annihilation'?'⚔️':'⚗️'}</div>
      <div className="wttl" style={{color:PC[winner]}}>{title}</div>
      <div className="wrsn">{reason}</div>
      <div className="wstats">
        <div className="wstat"><span>Moves</span><strong>{mc}</strong></div>
        <div className="wstat"><span>Time</span><strong>{fmtT(elapsed)}</strong></div>
      </div>
      <button className="btn-rm" onClick={onRematch}>🔄 Play again</button>
    </div></div>
  );
});

// ── GUIDE MODAL ───────────────────────────────────
const Guide=React.memo(({onClose})=>(
  <div className="win-mask" onClick={onClose}>
    <div className="guide-box" onClick={e=>e.stopPropagation()}>
      <button className="guide-close" onClick={onClose}>✕</button>
      <h2 className="guide-title">How to Play Aether Ultimate</h2>
      <section className="guide-section">
        <h3>⚡ Core Rules</h3>
        <p>Each cell holds a <strong>piece</strong> carrying elemental symbols (🔥💧🌍💨…). Pieces move like a <strong>chess knight</strong> (L-shape: 2+1). The board wraps — moving off one edge brings you out the other side.</p>
        <p>When a piece lands on another they <strong>merge</strong>: elements combine. <strong>Win:</strong> collect all N elements in one piece.</p>
      </section>
      <section className="guide-section">
        <h3>🎮 Modes</h3>
        <p><strong>Neutral</strong> — shared board, move any piece. First to merge all elements wins.</p>
        <p><strong>Owned 🔵🔴</strong> — you control blue (bottom), AI controls red (top). Also win by destroying all enemy pieces.</p>
      </section>
      <section className="guide-section">
        <h3>🟢 Board Indicators</h3>
        <ul>
          <li><span className="gi-ring ok"/> <strong>Green ring</strong> — valid move target</li>
          <li><span className="gi-ring win"/> <strong>Gold border</strong> — winning move available</li>
          <li>💡 badge = number of winning moves right now</li>
        </ul>
      </section>
      <section className="guide-section">
        <h3>♟️ Tactics</h3>
        <p><strong>Take win moves immediately</strong> — gold ring means you're one step away.</p>
        <p><strong>Neutral:</strong> merge pieces with different elements. Merging duplicates wastes a move.</p>
        <p><strong>Owned:</strong> captures both weaken the opponent and advance your collection. Fork threats (two simultaneous win paths) are decisive.</p>
      </section>
      <section className="guide-section">
        <h3>🧠 Strategy</h3>
        <p><strong>Diversity:</strong> keep pieces heterogeneous — one piece with 4 different elements beats four pieces each with one.</p>
        <p><strong>Tempo:</strong> every move that doesn't add a new element somewhere is a wasted move.</p>
        <p><strong>Piece economy (owned):</strong> prioritise captures that also advance your elements.</p>
      </section>
      <section className="guide-section">
        <h3>⚙️ Settings</h3>
        <ul>
          <li><strong>Board</strong> — 3×3 to 8×8</li>
          <li><strong>Elements</strong> — 3–8 (≤ board size). More = longer game.</li>
          <li><strong>Pieces</strong> — Neutral or Owned mode</li>
          <li><strong>AI level</strong> — Easy to ∞</li>
          <li><strong>Hints</strong> — show/hide winning-move highlights</li>
        </ul>
      </section>
    </div>
  </div>
));

// ── MAIN APP ──────────────────────────────────────

// ══════════════════════════════════════════════════════════════════
//  AETHER ✨  —  5×5 owned elemental strategy (integrated mode)
//
//  Rules:
//  • Each player: 3 pieces × 4 elements = 12 pieces
//  • Board: 5×5 torus. Center (2,2) = Aether cell (empty start)
//  • Movement: 1 or 3 elements → knight; 2 or 4 elements → bishop-1
//  • Only your own pieces move. Landing on enemy = capture (merge+annihilate)
//  • Annihilation: duplicate elements cancel on merge
//  • Illegal if annihilation destroys last global copy of any element
//  • Win: 4-element piece enters center (Aether), OR destroy all enemy pieces
//
//  Layout (validated: 0 same-player same-element knight conflicts):
//  F=fire🔥 W=water💧 E=earth🌍 A=air🌪
//    A  E  A  A  E   (P1/red top)
//    F  F  W  W  W
//    F  E  ✨  W  A   (center row)
//    F  E  F  E  A   (P0/blue bottom)
//    W  F  E  W  A
// ══════════════════════════════════════════════════════════════════

const AP_EL    = ['🔥','💧','🌍','🌪'];
const AP_EN    = ['Fire','Water','Earth','Air'];
const AP_CENTER= 12; // cell (2,2)
const AP_EMPTY = 255;
const AP_PC    = ['#4f8ef7','#f05252'];
const AP_KN    = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const AP_B1    = [[-1,-1],[-1,1],[1,-1],[1,1]];

// PIECE: Set of element indices (0-3). Max 4 unique elements.
// Merge: union, then cancel any element present in BOTH pieces (annihilation).
// Move type: 1 or 3 elements → knight; 2 or 4 elements → bishop-1.
// Win: piece with all 4 elements {0,1,2,3} enters center.

const AP_LAYOUT = [
  [0,3,0,1,2],  // row 0  P1/red:  F A F W E
  [2,0,3,2,1],  // row 1  P1/red:  E F A E W
  [1,3,-1,0,3], // row 2  mixed:   W A ✨ F A
  [2,1,2,3,0],  // row 3  P0/blue: E W E A F
  [1,2,1,0,3],  // row 4  P0/blue: W E W F A
];

function apOwner(r,c){
  if(r===2&&c===2)return AP_EMPTY;
  if(r<2||(r===2&&c<2))return 1;
  return 0;
}

function mkAPBoard(){
  return Array.from({length:25},(_,i)=>{
    const r=Math.floor(i/5),c=i%5,el=AP_LAYOUT[r][c];
    return{elems:el===-1?new Set():new Set([el]),owner:apOwner(r,c)};
  });
}

function apMoveType(elems){
  const n=elems.size;
  if(n===1||n===3)return'knight';
  if(n===2||n===4)return'bishop1';
  return null;
}

function apGetTargets(i,board,player){
  const cell=board[i];
  if(!cell.elems.size||cell.owner!==player)return[];
  const r=Math.floor(i/5),c=i%5,w=v=>(v+5)%5;
  const mt=apMoveType(cell.elems);
  if(!mt)return[];
  return(mt==='knight'?AP_KN:AP_B1)
    .map(([dr,dc])=>w(r+dr)*5+w(c+dc))
    .filter(ti=>!(ti===AP_CENTER&&cell.elems.size!==4));
}

// Merge: pure union — 1+1=1 (Set semantics, no annihilation)
// 🔥+🔥=🔥  🔥+💧=🔥💧  🔥💧+🔥🌍=🔥💧🌍
function apMergeElems(e1,e2){
  return{result:new Set([...e1,...e2]),annihilated:new Set()};
}

function apIsLegal(board,from,to,player){
  const src=board[from],dst=board[to];
  if(!src.elems.size||src.owner!==player)return false;
  return apGetTargets(from,board,player).includes(to);
}

// ── AETHER ENGINE ─────────────────────────────────────────────────
class APEngine{
  constructor(){
    this.board=mkAPBoard();
    this.cp=0;this.winner=null;this.wr=null;this.mc=0;this.hist=[];this.nodes=0;
  }
  snap(){
    return{
      board:this.board.map(c=>({elems:new Set(c.elems),owner:c.owner})),
      cp:this.cp,winner:this.winner,wr:this.wr,mc:this.mc,
    };
  }
  load(s){
    this.board=s.board.map(c=>({elems:new Set(c.elems),owner:c.owner}));
    this.cp=s.cp;this.winner=s.winner;this.wr=s.wr;this.mc=s.mc;
  }
  moves(){
    const ms=[];
    for(let i=0;i<25;i++){
      const c=this.board[i];
      if(!c.elems.size||c.owner!==this.cp)continue;
      for(const t of apGetTargets(i,this.board,this.cp))
        if(apIsLegal(this.board,i,t,this.cp))ms.push({from:i,to:t});
    }
    return ms;
  }
  counts(){
    let a=0,b=0;
    for(const c of this.board){if(c.owner===0)a++;else if(c.owner===1)b++;}
    return[a,b];
  }
  move(from,to){
    if(this.winner!=null)return{won:false};
    if(!apIsLegal(this.board,from,to,this.cp))return{won:false,illegal:true};
    const player=this.cp;
    this.hist.push(this.snap());
    const src=this.board[from],dst=this.board[to];
    const wasEnemy=dst.owner===1-player&&dst.elems.size>0;
    // Only win: 4-element piece enters center
    if(to===AP_CENTER&&src.elems.size===4){
      dst.elems=new Set(src.elems);dst.owner=player;
      src.elems=new Set();src.owner=AP_EMPTY;
      this.winner=player;this.wr='aether';this.mc++;
      return{won:true,reason:'aether',player};
    }
    const{result,annihilated}=apMergeElems(src.elems,dst.elems);
    src.elems=new Set();src.owner=AP_EMPTY;
    dst.elems=result;dst.owner=result.size>0?player:AP_EMPTY;
    this.mc++;this.cp=1-this.cp;
    return{won:false,annihilated,wasEnemy};
  }
  eval(){
    if(this.winner!=null)return this.winner===this.cp?9000000:-9000000;
    const cp=this.cp,sc=this.counts();
    let s=(cp===0?sc[0]-sc[1]:sc[1]-sc[0])*80;
    for(let i=0;i<25;i++){
      const c=this.board[i];if(!c.elems.size)continue;
      const n=c.elems.size,sign=c.owner===cp?1:-1;
      s+=sign*n*60;
      if(n===4){const r=Math.floor(i/5),col=i%5,d=Math.abs(r-2)+Math.abs(col-2);s+=sign*(5-d)*600;}
      s+=sign*apGetTargets(i,this.board,c.owner).length*5;
    }
    return s;
  }
  minimax(d,a,b,mx,lim,nl){
    this.nodes++;
    if(this.winner!=null)return mx?-9000000:9000000;
    if(!d||Date.now()>lim||this.nodes>nl)return this.eval();
    const ms=this.moves();if(!ms.length)return this.eval();
    ms.sort((x,y)=>{
      const v=m=>{
        const sf=this.board[m.from],dt=this.board[m.to];
        return(m.to===AP_CENTER&&sf.elems.size===4?2000000:0)
          +(sf.elems.size===4?200000:0)
          +(dt.owner===1-this.cp&&dt.elems.size?40000:0)
          +sf.elems.size*200+dt.elems.size*100;
      };
      return v(y)-v(x);
    });
    let best=mx?-Infinity:Infinity;
    for(const m of ms){
      if(Date.now()>lim||this.nodes>nl)break;
      const snap=this.snap();this.move(m.from,m.to);
      const v=this.minimax(d-1,a,b,!mx,lim,nl);this.load(snap);
      if(mx){best=Math.max(best,v);a=Math.max(a,best);}
      else{best=Math.min(best,v);b=Math.min(b,best);}
      if(a>=b)break;
    }
    return best;
  }
  aiMove(lvl){
    const D={easy:1,medium:2,hard:3,expert:4};
    const depth=D[lvl]||2,lim=Date.now()+700,nl=25000;
    this.nodes=0;
    const ms=this.moves();if(!ms.length)return null;
    for(const m of ms)if(m.to===AP_CENTER&&this.board[m.from].elems.size===4)return m;
    let best=null,bs=-Infinity;
    for(const m of ms){
      if(Date.now()>lim||this.nodes>nl)break;
      const snap=this.snap();this.move(m.from,m.to);
      const v=this.minimax(depth-1,-Infinity,Infinity,false,lim,nl);this.load(snap);
      if(v>bs){bs=v;best=m;}
    }
    return best??ms[0];
  }
  reset(){
    this.board=mkAPBoard();
    this.cp=0;this.winner=null;this.wr=null;this.mc=0;this.hist=[];
  }
}


// ── AETHER CELL ───────────────────────────────────────────────────
const APCell=React.memo(({idx,cell,isSel,isTarget,isLast,isCenter,onClick,cellPx})=>{
  const{elems,owner}=cell;
  const isEmpty=elems.length===0;
  const mt=isEmpty?null:apMoveType(new Set(elems));
  const isAether=elems.length===4;

  let cls='ap-cell';
  if(isCenter&&isEmpty)cls+=' ap-center';else if(isEmpty)cls+=' ap-mt';
  if(isSel)cls+=' ap-sel';
  if(isTarget)cls+=' ap-target';
  if(isLast&&!isSel)cls+=' ap-last';
  if(!isEmpty&&owner===0)cls+=' ap-own0';
  if(!isEmpty&&owner===1)cls+=' ap-own1';
  if(isAether)cls+=' ap-aether-ready';

  const fsScale=elems.length<=2?'.38':'.26';
  const fsMax=elems.length<=2?1.4:.9;
  return(
    <div className={cls} style={{width:cellPx,height:cellPx}} onClick={()=>onClick(idx)}>
      {isTarget&&<div className="ap-ring"/>}
      {!isEmpty?(
        <div className="ap-piece">
          <div className={`ap-pbg ${owner===0?'ap-p0':owner===1?'ap-p1':''}`}/>
          <div className={`ap-elems c${elems.length}`}>
            {elems.map((e,k)=>(
              <span key={k} className="ap-el"
                style={{fontSize:`clamp(.52rem,calc(${cellPx}px*${fsScale}),${fsMax}rem)`}}>
                {AP_EL[e]}
              </span>
            ))}
          </div>
          {mt&&<div className="ap-mt-badge">{mt==='knight'?'♞':'⬡'}</div>}
        </div>
      ):(isCenter&&(
        <div className="ap-center-icon">✨<div className="ap-center-lbl">AETHER</div></div>
      ))}
    </div>
  );
});

// ── AETHER PLAYER STRIP ───────────────────────────────────────────
const APPlayerStrip=React.memo(({p,label,active,count,board})=>{
  const elemCnt=[0,0,0,0];
  board.forEach(c=>{if(c.owner===p)c.elems.forEach(e=>elemCnt[e]++);});
  return(
    <div className={`pstrip p${p}${active?' active':''}`}>
      <div className="ps-av">{p===0?'You':'AI'}</div>
      <div className="ps-info">
        <div className="ps-name">{label}</div>
        <div className={`ps-st${active?' on':''}`}>{active?'YOUR TURN ▶':'waiting'}</div>
      </div>
      <div className="ps-els">
        {AP_EL.map((el,e)=>(
          <div key={e} className={`eldot ${elemCnt[e]>0?'have':'miss'}`} title={AP_EN[e]}>
            {el}{elemCnt[e]>1&&<sup style={{fontSize:'.55em',lineHeight:0}}>{elemCnt[e]}</sup>}
          </div>
        ))}
      </div>
      <div className="ps-cnt">
        <div className="ps-num">{count}</div>
        <div className="ps-bw"><div className="ps-bf" style={{width:`${Math.min(100,count/12*100)}%`}}/></div>
      </div>
    </div>
  );
});

// ── AETHER WIN SCREEN ─────────────────────────────────────────────
const APWinScreen=React.memo(({winner,wr,mc,elapsed,mode,onRematch})=>{
  const title=winner===0?(mode==='vsAI'?'You won!':'Player 1 wins!'):(mode==='vsAI'?'AI wins!':'Player 2 wins!');
  return(
    <div className="win-mask"><div className="win-box">
      <div className="wico">✨</div>
      <div className="wttl" style={{color:AP_PC[winner]}}>{title}</div>
      <div className="wrsn">✨ Aether claimed — all 4 elements in the center!</div>
      <div className="wstats">
        <div className="wstat"><span>Moves</span><strong>{mc}</strong></div>
        <div className="wstat"><span>Time</span><strong>{fmtT(elapsed)}</strong></div>
      </div>
      <button className="btn-rm" onClick={onRematch}>🔄 Play again</button>
    </div></div>
  );
});

// ── AETHER GUIDE ──────────────────────────────────────────────────
const APGuide=React.memo(({onClose})=>(
  <div className="win-mask" onClick={onClose}>
    <div className="guide-box" onClick={e=>e.stopPropagation()}>
      <button className="guide-close" onClick={onClose}>✕</button>
      <h2 className="guide-title">AETHER ✨ Rules</h2>
      <div className="guide-section"><h3>🗺️ Board</h3>
        <p>5×5 torus — all edges wrap. Center (2,2) = <strong>✨ Aether</strong>, empty at start. Blue pieces (yours) start at the bottom, red (AI) at the top.</p></div>
      <div className="guide-section"><h3>♟️ Movement</h3>
        <ul>
          <li><strong>1 or 3 elements</strong> → Knight move (L-shape)</li>
          <li><strong>2 or 4 elements</strong> → Bishop×1 (one diagonal step)</li>
          <li>Center only accepts a piece with all <strong>4 elements</strong></li>
        </ul></div>
      <div className="guide-section"><h3>⚗️ Merge &amp; Annihilation</h3>
        <p>Landing on any piece merges them — identical elements become one: 🔥+🔥=🔥. Example: 🔥💧 + 🔥🌍 &rarr; 🔥💧🌍.</p>
        <p>Goal: build a piece with all 4 elements (🔥💧🌍🌪) and move it into the ✨ center.</p></div>
      <div className="guide-section"><h3>🏆 Winning</h3>
        <p>Build a piece with exactly <strong>one of each element</strong> (🔥💧🌍🌪) and move it into the <strong>✨ center</strong>. The piece must move diagonally (bishop&times;1) &mdash; guard your path!</p></div>
      <div className="guide-section"><h3>💡 Tips</h3>
        <p>Build toward 4 elements by merging carefully — but a 4-element piece moves diagonally (slow!). Guard your path to the center. Use annihilation offensively to weaken enemies, but watch the global element rule.</p></div>
    </div>
  </div>
));

// ── AETHER GAME ───────────────────────────────────────────────────
function AetherGame({onBack}){
  const containerRef=useRef(null);
  const stateRef=useRef({
    eng:new APEngine(),
    sel:null,
    tgts:[],
    last:null,
    aiTimer:null,
    aiRunning:false,
    showWin:false,
    guide:false,
    mode:'vsAI',
    lvl:'medium',
    timerSec:0,
    timerBase:Date.now(),
    timerActive:true,
  });
  const[,forceRender]=useState(0);
  const bump=useCallback(()=>forceRender(n=>n+1),[]);
  const S=stateRef.current;

  // Timer
  useEffect(()=>{
    const iv=setInterval(()=>{
      if(!S.timerActive)return;
      const t=Math.floor((Date.now()-S.timerBase)/1000);
      if(t!==S.timerSec){S.timerSec=t;bump();}
    },500);
    return()=>clearInterval(iv);
  },[]);// eslint-disable-line

  // Cell size
  const[cellPx,setCellPx]=useState(80);
  useEffect(()=>{
    const calc=()=>{
      const vw=window.innerWidth,vh=window.innerHeight,narrow=vw<700;
      setCellPx(Math.max(48,Math.min(110,Math.min(
        Math.floor((Math.max(vh-(narrow?400:330),200)-40)/5),
        Math.floor((Math.max(vw-(narrow?20:210),200)-40)/5)
      ))));
    };
    calc();
    window.addEventListener('resize',calc);
    return()=>window.removeEventListener('resize',calc);
  },[]);

  const E=S.eng;

  const doReset=()=>{
    if(S.aiTimer){clearTimeout(S.aiTimer);S.aiTimer=null;}
    S.aiRunning=false;S.showWin=false;S.sel=null;S.tgts=[];S.last=null;
    S.timerSec=0;S.timerBase=Date.now();S.timerActive=true;
    E.reset();bump();
  };

  const triggerAI=()=>{
    if(S.mode!=='vsAI'||E.cp!==1||E.winner!=null||S.aiTimer)return;
    S.aiRunning=true;bump();
    S.aiTimer=setTimeout(()=>{
      S.aiTimer=null;
      if(E.winner!=null||E.cp!==1){S.aiRunning=false;bump();return;}
      const m=E.aiMove(S.lvl);
      if(m){
        E.move(m.from,m.to);
        S.last=m;
      }
      S.aiRunning=false;
      // check win
      if(E.winner!=null&&!S.showWin){
        S.timerActive=false;
        sfx.win();
        setTimeout(()=>{S.showWin=true;bump();spawnConfetti();},350);
      }
      bump();
    },S.lvl==='easy'?400:900);
  };

  const handleCell=(idx)=>{
    if(E.winner!=null||S.aiRunning)return;
    if(S.mode==='vsAI'&&E.cp===1)return;
    const cell=E.board[idx];
    const isMine=cell.elems.size>0&&cell.owner===E.cp;
    const isTarget=S.tgts.includes(idx);
    if(S.sel===null){
      if(!isMine)return;
      sfx.select();
      S.sel=idx;
      S.tgts=apGetTargets(idx,E.board,E.cp);
      bump();
      return;
    }
    if(idx===S.sel){S.sel=null;S.tgts=[];bump();return;}
    if(isTarget){
      const fromIdx=S.sel;
      const res=E.move(fromIdx,idx);
      S.sel=null;S.tgts=[];S.last={from:fromIdx,to:idx};
      if(res.annihilated?.size>0)sfx.merge();
      else if(res.wasEnemy)sfx.capture();
      else sfx.move();
      if(E.winner!=null&&!S.showWin){
        S.timerActive=false;
        sfx.win();
        setTimeout(()=>{S.showWin=true;bump();spawnConfetti();},350);
      }
      bump();
      if(!res.won)triggerAI();
      return;
    }
    if(isMine){
      sfx.select();
      S.sel=idx;
      S.tgts=apGetTargets(idx,E.board,E.cp);
      bump();
      return;
    }
    S.sel=null;S.tgts=[];bump();
  };

  const doUndo=()=>{
    if(!E.hist.length)return;
    E.load(E.hist.pop());sfx.undo();
    if(S.mode==='vsAI'&&E.hist.length>0&&E.cp===1)E.load(E.hist.pop());
    S.sel=null;S.tgts=[];S.last=null;bump();
  };

  // Snapshot for render
  const board=E.board.map(c=>({elems:[...c.elems],owner:c.owner}));
  const counts=E.counts();
  const{winner,wr,mc,cp}=E;

  let stTxt,stCol;
  if(winner!=null){
    stTxt=`✨ ${winner===0?(S.mode==='vsAI'?'You won!':'P1 wins!'):(S.mode==='vsAI'?'AI wins!':'P2 wins!')}`;
    stCol='var(--gold)';
  }else if(S.aiRunning){stTxt='🤖 Thinking...';stCol=AP_PC[1];}
  else{stTxt=cp===0?'● Your turn':(S.mode==='vsAI'?`● AI's turn`:"● P2's turn");stCol=AP_PC[cp];}

  return(
    <div className="app" ref={containerRef}>
      {S.guide&&<APGuide onClose={()=>{S.guide=false;bump();}}/>}
      {S.showWin&&winner!=null&&(
        <APWinScreen winner={winner} wr={wr} mc={mc} elapsed={S.timerSec}
          mode={S.mode} onRematch={doReset}/>
      )}
      <header className="hdr">
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          {onBack&&<button className="btn-help" onClick={onBack}>←</button>}
          <div className="htitle">AETHER<em style={{color:'var(--gold)',fontStyle:'normal'}}> ✨</em></div>
        </div>
        <div className="hbadges">
          <div className="badge timer">{fmtT(S.timerSec)}</div>
          <div className="badge">Move {mc+1}</div>
          <button className="btn-help" onClick={()=>{S.guide=true;bump();}}>?</button>
        </div>
      </header>

      <APPlayerStrip p={1}
        label={S.mode==='vsAI'?'Opponent (AI)':'Player 2'}
        active={cp===1&&winner==null&&!S.aiRunning}
        count={counts[1]} board={board}/>

      <div className={`sbar${winner!=null?' won':''}`} style={{'--sc':stCol}}>
        <span className={S.aiRunning?'thinking':''} style={{color:stCol}}>{stTxt}</span>
        <div className="sbar-r">
          {winner==null&&<span className="hbadge">🔵{counts[0]} · 🔴{counts[1]}</span>}
        </div>
      </div>

      <div className="game-row">
        <div className="bwrap" style={{padding:8}}>
          <div style={{
            display:'grid',
            gridTemplateColumns:`repeat(5,${cellPx}px)`,
            gridTemplateRows:`repeat(5,${cellPx}px)`,
            gap:4,
          }}>
            {board.map((cell,i)=>(
              <APCell key={i} idx={i} cell={cell}
                isCenter={i===AP_CENTER}
                isSel={S.sel===i}
                isTarget={S.tgts.includes(i)}
                isLast={S.last!=null&&(S.last.from===i||S.last.to===i)}
                onClick={handleCell}
                cellPx={cellPx}/>
            ))}
          </div>
        </div>

        <div className="side">
          <div className="panel">
            <div className="slbl">Movement</div>
            <div style={{fontSize:'.72rem',color:'var(--txt2)',lineHeight:1.8}}>
              <div>1 or 3 elems → <strong>♞</strong> Knight</div>
              <div>2 or 4 elems → <strong>⬡</strong> Diagonal×1</div>
              <div style={{color:'var(--gold)',marginTop:3}}>4 elems → enter ✨ center!</div>
            </div>
          </div>
          <div className="panel">
            <div className="slbl">Win by</div>
            <div style={{fontSize:'.72rem',color:'var(--txt2)',lineHeight:1.8}}>
              <div>✨ Move 4-elem piece to center</div>
            </div>
          </div>
          <button className="undo" onClick={doUndo} disabled={!E.hist.length}>
            ↩ Undo{E.hist.length?` (${E.hist.length})`:''}
          </button>
        </div>
      </div>

      <APPlayerStrip p={0}
        label={S.mode==='vsAI'?'You':'Player 1'}
        active={cp===0&&winner==null&&!S.aiRunning}
        count={counts[0]} board={board}/>

      <div className="settings">
        <div className="sg"><span className="sglbl">Mode</span>
          <div className="seg">
            <button className={S.mode==='vsAI'?'on':''}
              onClick={()=>{S.mode='vsAI';S.sel=null;S.tgts=[];E.reset();bump();}}>
              🤖 vs AI
            </button>
            <button className={S.mode==='twoPlayer'?'on':''}
              onClick={()=>{S.mode='twoPlayer';S.sel=null;S.tgts=[];E.reset();bump();}}>
              👥 2P
            </button>
          </div>
        </div>
        {S.mode==='vsAI'&&<>
          <div className="sdiv"/>
          <div className="sg"><span className="sglbl">AI</span>
            <div className="seg">
              {[['easy','Easy'],['medium','Med'],['hard','Hard'],['expert','Expert']].map(([l,lb])=>(
                <button key={l} className={S.lvl===l?'on':''}
                  onClick={()=>{S.lvl=l;bump();}}>{lb}
                </button>
              ))}
            </div>
          </div>
        </>}
        <button className="btn-new" onClick={doReset}>🔄 New</button>
      </div>

      <div className="legend">
        {AP_EL.map((el,i)=>(
          <div key={i} className="lgi">
            <span style={{fontSize:'.85rem'}}>{el}</span>
            <span>{AP_EN[i]}</span>
          </div>
        ))}
        <div className="lgi"><div className="lring"/><span>Valid move</span></div>
        <div className="lgi"><span>✨</span><span>Enter with 4 elems = WIN</span></div>
      </div>
    </div>
  );
}


// ── MODE PICKER ───────────────────────────────────────────────────
function ModePicker({onSelect}){
  return(
    <div className="app">
      <header className="hdr">
        <div className="htitle">AETHER <em>ULTIMATE</em></div>
      </header>
      <div className="mode-picker">
        <div>
          <div className="mode-picker-title">Choose Mode</div>
        </div>
        <button className="mode-btn" onClick={()=>onSelect('classic')}>
          <div className="mode-btn-title">AETHER <em>ULTIMATE</em></div>
          <div className="mode-btn-desc">
            Knight-move puzzle — collect all elements in one piece.<br/>
            Neutral or Owned pieces · 3×3 to 8×8 · vs AI or 2 players
          </div>
        </button>
        <button className="mode-btn" onClick={()=>onSelect('plus')} style={{borderColor:'rgba(251,191,36,.35)'}}>
          <div className="mode-btn-title">AETHER <em>✨</em></div>
          <div className="mode-btn-desc">
            4 elements × 3 pieces · 5×5 torus · owned pieces · annihilation<br/>
            Race to collect all 4 elements and claim the ✨ Aether center
          </div>
        </button>
      </div>
    </div>
  );
}

// ── ROOT ──────────────────────────────────────────────────────────
// Starts in classic mode. ✨ button in header opens AETHER+.
export default function Root(){
  const[gameMode,setGameMode]=useState('classic');
  if(gameMode==='plus')return<AetherGame onBack={()=>setGameMode('classic')}/>;
  return<App onAether={()=>setGameMode('plus')}/>;
}

function App({onBack,onAether}){
  const[sz,    setSzRaw]=useState(5);
  const[n,     setN    ]=useState(5);  // default 5 elements
  const[layout,setLayout]=useState('sym');  // owned layout
  const[theme, setTheme]=useState('elements');
  const[mode,  setMode ]=useState('vsAI');
  const[lvl,   setLvl  ]=useState('medium');
  const[owned, setOwned]=useState(false);
  const[hints, setHints]=useState(true);
  const[guide, setGuide]=useState(false);

  const[sel,        setSel       ]=useState(null);
  const[validMoves, setValidMoves]=useState([]);
  const[aiRunning,  setAiRunning ]=useState(false);
  const[moveLog,    setMoveLog   ]=useState([]);
  const[lastMove,   setLastMove  ]=useState(null);
  const[showWin,    setShowWin   ]=useState(false);

  const colors=React.useMemo(()=>elc(n),[n]);
  const cellPx=useCellSize(sz,owned);

  const{
    eng,engRef,board,cp,winner,wr,mc,nodes,canUndo,counts,wm,thr,ct,
    doMove,reset,undo,getAI,
  }=useEngine(sz,n,owned,layout);

  // Single ref for pending AI timeout — cancel on reset
  const aiTimer=useRef(null);
  const timer=useTimer();

  const coll=React.useMemo(()=>{
    const s=[new Set(),new Set()];
    board.forEach(row=>row.forEach(({idx,own})=>{if(own===0||own===1)idx.forEach(k=>s[own].add(k))}));
    return s;
  },[board]);
  const totalPieces=React.useMemo(()=>Math.floor(sz/2)*sz+(sz%2===1?(sz-1):0),[sz]);

  // Win detection
  useEffect(()=>{
    if(winner!=null&&!showWin){
      sfx.win();timer.stop();
      setTimeout(()=>{setShowWin(true);spawnConfetti()},350);
    }
  },[winner]);// eslint-disable-line

  const clearSel=useCallback(()=>{setSel(null);setValidMoves([])},[]);

  // ── handleReset ────────────────────────────────────────────────────────────
  // The single authoritative "new game" function.
  // Key guarantee: clears aiTimer BEFORE reset so no stale AI callback can fire.
  const handleReset=useCallback(()=>{
    // 1. Kill any pending AI timeout by id
    if(aiTimer.current!==null){
      clearTimeout(aiTimer.current);
      aiTimer.current=null;
    }
    // 2. Synchronously clear all UI state
    setAiRunning(false);
    setShowWin(false);
    setMoveLog([]);
    setLastMove(null);
    clearSel();
    timer.reset();
    // 3. Reset the engine (triggers re-render via tick)
    reset();
  // reset and clearSel are stable useCallbacks; timer.reset is stable too
  },[reset,clearSel,timer.reset]);// eslint-disable-line

  // Reset when owned mode or layout switches
  const prevOwned=useRef(owned);
  const prevLayout=useRef(layout);
  useEffect(()=>{
    const ownerChanged=prevOwned.current!==owned;
    const layoutChanged=prevLayout.current!==layout;
    prevOwned.current=owned;
    prevLayout.current=layout;
    if(ownerChanged||layoutChanged)handleReset();
  },[owned,layout]);// eslint-disable-line

  // ── execMove ───────────────────────────────────────────────────────────────
  const execMove=useCallback((fr,fc,tr,tc,player)=>{
    const tgtV=eng.board[eng._i(tr,tc)],tgtO=eng.owner[eng._i(tr,tc)];
    if(owned&&tgtO!==EMPTY&&tgtO!==player)sfx.capture();
    else if(tgtV)sfx.merge();
    else sfx.move();
    const res=doMove(fr,fc,tr,tc);
    setMoveLog(prev=>[...prev,{from:[fr,fc],to:[tr,tc],p:player,cap:!!res.captured}]);
    setLastMove({from:[fr,fc],to:[tr,tc]});
    return res;
  },[eng,owned,doMove]);

  // ── triggerAI ──────────────────────────────────────────────────────────────
  // Reads from engRef.current (not closure-captured eng) so it always sees
  // the post-reset engine state even if called from a stale closure.
  const triggerAI=useCallback(()=>{
    const e=engRef.current;
    if(mode!=='vsAI'||e.cp!==1||e.winner!=null||aiTimer.current!==null)return;
    setAiRunning(true);
    aiTimer.current=setTimeout(()=>{
      aiTimer.current=null;
      const e2=engRef.current; // read live ref — never stale
      if(e2.winner!=null||e2.cp!==1){setAiRunning(false);return}
      const m=getAI(lvl);
      if(m){
        const player=e2.cp;
        execMove(m.from[0],m.from[1],m.to[0],m.to[1],player);
      }
      setAiRunning(false);
    },lvl==='easy'?400:900);
  },[mode,lvl,getAI,execMove,engRef]);

  // ── handleCellClick ────────────────────────────────────────────────────────
  const handleCellClick=useCallback((r,c)=>{
    if(winner!=null||aiRunning)return;
    if(mode==='vsAI'&&cp===1)return;
    const v=eng.board[eng._i(r,c)],o=eng.owner[eng._i(r,c)];
    const mine=owned?o===cp:v>0;
    const isVld=validMoves.some(([nr,nc])=>nr===r&&nc===c);
    if(!sel){
      if(mine){sfx.select();setSel({r,c});setValidMoves(eng.tg[r][c])}
    }else{
      if(isVld){
        clearSel();
        const res=execMove(sel.r,sel.c,r,c,eng.cp);
        if(res&&!res.won)triggerAI();
      }else if(r===sel.r&&c===sel.c){
        clearSel();
      }else if(mine){
        sfx.select();setSel({r,c});setValidMoves(eng.tg[r][c]);
      }else{
        clearSel();
      }
    }
  },[winner,aiRunning,mode,cp,sel,validMoves,eng,owned,execMove,clearSel,triggerAI]);

  // ── handleUndo ─────────────────────────────────────────────────────────────
  const handleUndo=useCallback(()=>{
    if(!canUndo)return;
    undo(); // always undo at least 1 move
    // In vsAI mode, also undo the AI's preceding move so human can re-try
    if(mode==='vsAI'&&engRef.current.hist.length>0&&engRef.current.cp===1)undo();
    clearSel();setLastMove(null);
    setMoveLog(prev=>{
      const a=[...prev];
      if(a.length)a.pop();
      if(mode==='vsAI'&&a.length)a.pop();
      return a;
    });
  },[canUndo,undo,mode,engRef,clearSel]);

  const setSz=useCallback((v)=>{setSzRaw(v);setN(prev=>Math.min(prev,v))},[]);

  // Status bar
  let stTxt,stCol;
  if(winner!=null){
    stTxt=`🏆 ${winner===0?(mode==='vsAI'?'You won!':'Player 1 wins!'):(mode==='vsAI'?'AI wins!':'Player 2 wins!')}`;
    stCol='var(--gold)';
  }else if(aiRunning){
    stTxt='🤖 Thinking...';stCol=PC[1];
  }else{
    stTxt=cp===0?'● Your turn':(mode==='vsAI'?`● AI's turn`:'● Player 2\'s turn');
    stCol=PC[cp];
  }

  return(
    <div className="app">
      {guide&&<Guide onClose={()=>setGuide(false)}/>}
      {showWin&&winner!=null&&(
        <WinScreen winner={winner} wr={wr} mode={mode} owned={owned}
          mc={mc} elapsed={timer.t} onRematch={handleReset}/>
      )}

      <header className="hdr">
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          {onBack&&<button className="btn-help" onClick={onBack} title="Menu">←</button>}
          <div className="htitle">AETHER <em>ULTIMATE</em></div>
        </div>
        <div className="hbadges">
          <div className="badge timer">{timer.fmt}</div>
          <div className="badge">Move {mc+1}</div>
          {onAether&&<button className="btn-help" onClick={onAether} title="AETHER+ mode" style={{background:'rgba(251,191,36,.12)',borderColor:'rgba(251,191,36,.35)',color:'var(--gold)'}}>✨</button>}
          <button className="btn-help" onClick={()=>setGuide(true)}>?</button>
        </div>
      </header>

      {owned&&<PlayerStrip p={1} label={mode==='vsAI'?'Opponent (AI)':'Player 2'}
        active={cp===1&&winner==null&&!aiRunning}
        counts={counts} totalPieces={totalPieces} collectedSet={coll[1]} n={n}/>}

      <div className={`sbar${winner!=null?' won':''}`} style={{'--sc':stCol}}>
        <span className={aiRunning?'thinking':''} style={{color:stCol}}>{stTxt}</span>
        <div className="sbar-r">
          {aiRunning&&<span className="nc">{nodes} nodes</span>}
          {wm.length>0&&winner==null&&<span className="hbadge">💡 {wm.length} winning</span>}
        </div>
      </div>

      <div className="game-row">
        <Board board={board} theme={theme} sel={sel} validMoves={validMoves}
          onClick={handleCellClick} colors={colors} wm={wm} thr={thr} ct={ct}
          lastMove={lastMove} hints={hints} cp={cp} owned={owned} cellPx={cellPx}/>
        <div className="side">
          <InfoCard selCell={sel} eng={eng} colors={colors} owned={owned}/>
          <MoveLog moveLog={moveLog} owned={owned}/>
          <button className="undo" onClick={handleUndo} disabled={!canUndo}>↩ Undo{canUndo?` (${eng.hist.length})`:'' }</button>
        </div>
      </div>

      {owned&&<PlayerStrip p={0} label={mode==='vsAI'?'You':'Player 1'}
        active={cp===0&&winner==null&&!aiRunning}
        counts={counts} totalPieces={totalPieces} collectedSet={coll[0]} n={n}/>}

      <div className="settings">
        <div className="sg"><span className="sglbl">Board</span>
          <div className="seg">{[3,4,5,6,7,8].map(s=>(
            <button key={s} className={sz===s?'on':''} onClick={()=>setSz(s)}>{s}×{s}</button>
          ))}</div></div>
        <div className="sdiv"/>
        <div className="sg"><span className="sglbl">Elements</span>
          <div className="seg">{[3,4,5,6,7,8].filter(v=>v<=sz).map(k=>(
            <button key={k} className={n===k?'on':''} onClick={()=>setN(k)}>{k}</button>
          ))}</div></div>
        <div className="sdiv"/>
        <div className="sg"><span className="sglbl">Pieces</span>
          <div className="seg">
            <button className={!owned?'on':''} onClick={()=>setOwned(false)}>Neutral</button>
            <button className={owned?'on':''} onClick={()=>setOwned(true)}>🔵🔴 Owned</button>
          </div></div>
        {owned&&<><div className="sdiv"/>
          <div className="sg"><span className="sglbl">Layout</span>
            <div className="seg">
              {[['sym','⇌ Sym'],['asym','↯ Asym'],['rand','🎲 Rand'],['chaos','🌀 Chaos']].map(([v,lb])=>(
                <button key={v} className={layout===v?'on':''} onClick={()=>setLayout(v)}>{lb}</button>
              ))}
            </div></div></>}
        <div className="sdiv"/>
        <div className="sg"><span className="sglbl">Mode</span>
          <div className="seg">
            <button className={mode==='vsAI'?'on':''} onClick={()=>setMode('vsAI')}>🤖 vs AI</button>
            <button className={mode==='twoPlayer'?'on':''} onClick={()=>setMode('twoPlayer')}>👥 2 players</button>
          </div></div>
        {mode==='vsAI'&&<><div className="sdiv"/>
          <div className="sg"><span className="sglbl">AI</span>
            <div className="seg">{[['easy','Easy'],['medium','Med'],['hard','Hard'],['expert','Expert'],['impossible','∞']].map(([l,lb])=>(
              <button key={l} className={lvl===l?'on':''} onClick={()=>setLvl(l)}>{lb}</button>
            ))}</div></div></>}
        <div className="sdiv"/>
        <div className="sg"><span className="sglbl">View</span>
          <div className="seg">
            <button className={theme==='elements'?'on':''} onClick={()=>setTheme('elements')}>🔮</button>
            <button className={theme==='colors'?'on':''} onClick={()=>setTheme('colors')}>🌈</button>
          </div></div>
        <div className="sg"><span className="sglbl">Hints</span>
          <div className="seg">
            <button className={hints?'on':''} onClick={()=>setHints(h=>!h)}>{hints?'✅':'⬜'}</button>
          </div></div>
        <button className="btn-new" onClick={handleReset}>🔄 New</button>
      </div>

      <div className="legend">
        {owned&&<>
          <div className="lgi"><div className="lgsw" style={{background:'var(--p1b)',border:'2px solid var(--p1e)'}}/><span>Your piece</span></div>
          <div className="lgi"><div className="lgsw" style={{background:'var(--p2b)',border:'2px solid var(--p2e)'}}/><span>Opponent</span></div>
        </>}
        <div className="lgi"><span className="legend-ring ok"/><span>Valid move</span></div>
        <div className="lgi"><span className="legend-ring win"/><span>Winning move</span></div>
      </div>
    </div>
  );
}
