// Terrain / biome map editor (module). Export formats + coordinate convention: see the comment block at the top of /editor.html.
// The 3D preview lives in ./preview3d.js and uses the game's own loader (src/world/mapLoader.js).
import { createPreview } from './preview3d.js';
import { ROAD_TYPES, EDGE_TYPES, SURFACES, FEATURES, SIGN_MODES, DRIVE_SIDES, SIGN_STYLES, NODE_DEFAULTS, MAP_DEFAULTS } from '../world/roadMeta.js';
// =====================================================================================
// SECTION 1: constants, state
// =====================================================================================
const CLASSES = [
  {id:0,name:'grass',color:'#5da130'},{id:1,name:'forest',color:'#1f5c2a'},{id:2,name:'dirt',color:'#8a6a43'},
  {id:3,name:'sand',color:'#e0cf8f'},{id:4,name:'rock',color:'#7d7d7d'},{id:5,name:'snow',color:'#f2f6ff'},
  {id:6,name:'road',color:'#333333'},{id:7,name:'city',color:'#b0a0c0'}];
const CR = new Float32Array(8), CG = new Float32Array(8), CB = new Float32Array(8);
CLASSES.forEach((c,i)=>{const v=parseInt(c.color.slice(1),16);CR[i]=v>>16;CG[i]=(v>>8)&255;CB[i]=v&255;});
const TS = 64, MAXUNDO = 40;

let N = 1024;
const S = {world:2000, maxH:200, sea:0.1, driveSide:MAP_DEFAULTS.driveSide, signStyle:MAP_DEFAULTS.signStyle};
let H, WL, WC, scratchH, strokeA;             // height f32, waterLevel f32 (-1 none), weights[8] u8
let roads = [], nextRoadId = 1;
let mapCv, mctx, img, img32;
const brush = {radius:60, strength:0.5, hardness:0.5, shape:0};   // shape 0 smooth 1 linear 2 sharp
const opts = {flatTyped:false, flatMeters:50, mtScale:150, mtSharp:2, mtAmp:1, hlScale:250, hlAmp:1,
  waterDepth:6, flatPicked:null, cls:0, slope:35, snow:0.75, sand:0.03, shoulder:10, smoothM:40};
const view = {mode:'both', water:true, roads:true, markers:true, grid:false, biomeOp:0.4, waterOp:0.7, z:1, ox:0, oy:0};
let tool = 'raise';
let modified = false, lastSaveTs = 0;

const $ = id => document.getElementById(id);
function clamp(v,a,b){return v<a?a:v>b?b:v;}
function toast(m){const t=$('toast');t.textContent=m;t.style.opacity=1;clearTimeout(toast.t);toast.t=setTimeout(()=>t.style.opacity=0,2500);}

function allocate(n){
  N = n;
  H = new Float32Array(n*n); WL = new Float32Array(n*n).fill(-1);
  WC = []; for(let c=0;c<8;c++) WC.push(new Uint8Array(n*n)); WC[0].fill(255);
  scratchH = new Float32Array(n*n); strokeA = new Float32Array(n*n);
  mapCv = document.createElement('canvas'); mapCv.width = mapCv.height = n;
  mctx = mapCv.getContext('2d');
  img = mctx.createImageData(n,n); img32 = new Uint32Array(img.data.buffer);
  undoStack.length = 0; redoStack.length = 0; stroke = null;
  roads = []; nextRoadId = 1; selRoad = -1; selPt = -1; drawing = false;
  markers = []; nextMarkerId = 1; selMarker = -1; markersVer++;
}

// =====================================================================================
// SECTION 2: noise (Perlin) for Mountain / Hills
// =====================================================================================
const perm = new Uint8Array(512);
(function(){const p=[];for(let i=0;i<256;i++)p.push(i);let s=1234567;
  for(let i=255;i>0;i--){s=(s*1664525+1013904223)>>>0;const j=s%(i+1);[p[i],p[j]]=[p[j],p[i]];}
  for(let i=0;i<512;i++)perm[i]=p[i&255];})();
function g(h,a,b){switch(h&7){case 0:return a+b;case 1:return a-b;case 2:return -a+b;case 3:return -a-b;
    case 4:return a;case 5:return -a;case 6:return b;default:return -b;}}
function noise2(x,y){            // approx [-1,1]
  const X=Math.floor(x),Y=Math.floor(y);x-=X;y-=Y;
  const xi=X&255,yi=Y&255,u=x*x*x*(x*(x*6-15)+10),v=y*y*y*(y*(y*6-15)+10);
  const aa=perm[perm[xi]+yi],ab=perm[perm[xi]+yi+1],ba=perm[perm[xi+1]+yi],bb=perm[perm[xi+1]+yi+1];
  const x1=g(aa,x,y)+(g(ba,x-1,y)-g(aa,x,y))*u, x2=g(ab,x,y-1)+(g(bb,x-1,y-1)-g(ab,x,y-1))*u;
  return (x1+(x2-x1)*v)*0.9;
}
function fbm(x,y,oct){let s=0,a=1,n=0;for(let o=0;o<oct;o++){s+=a*noise2(x,y);n+=a;a*=0.5;x*=2;y*=2;}return s/n;}
function ridged(x,y,oct,sharp){      // ridged multifractal, ~[0,1]
  let sum=0,amp=1,norm=0,w=1;
  for(let o=0;o<oct;o++){
    let sg=1-Math.abs(noise2(x,y)); sg=Math.pow(sg<0?0:sg,sharp); sg*=w;
    w=clamp(sg*1.6,0,1); sum+=sg*amp; norm+=amp; amp*=0.5; x*=2.03; y*=2.03;
  }
  return sum/norm;
}

// =====================================================================================
// SECTION 3: undo / redo (dirty tile patches, only changed layers)
// =====================================================================================
const undoStack = [], redoStack = [];
let stroke = null;        // {layers:'hwc', tiles:Map}
const tilesPerRow = () => N/TS;
function readTile(layer,tx,ty){
  const x0=tx*TS,y0=ty*TS;
  if(layer==='c'){const o=new Uint8Array(8*TS*TS);
    for(let c=0;c<8;c++)for(let r=0;r<TS;r++)o.set(WC[c].subarray((y0+r)*N+x0,(y0+r)*N+x0+TS),(c*TS+r)*TS);return o;}
  const src = layer==='h'?H:WL, o=new Float32Array(TS*TS);
  for(let r=0;r<TS;r++)o.set(src.subarray((y0+r)*N+x0,(y0+r)*N+x0+TS),r*TS);
  return o;
}
function writeTile(layer,tx,ty,d){
  const x0=tx*TS,y0=ty*TS;
  if(layer==='c'){for(let c=0;c<8;c++)for(let r=0;r<TS;r++)WC[c].set(d.subarray((c*TS+r)*TS,(c*TS+r+1)*TS),(y0+r)*N+x0);return;}
  const dst = layer==='h'?H:WL;
  for(let r=0;r<TS;r++)dst.set(d.subarray(r*TS,(r+1)*TS),(y0+r)*N+x0);
}
function beginStroke(layers){stroke={layers,tiles:new Map(),roadsBefore:null};}
function touch(x0,y0,x1,y1){            // inclusive pixel rect; saves "before" state of tiles first time touched
  if(!stroke)return;
  x0=clamp(x0,0,N-1);y0=clamp(y0,0,N-1);x1=clamp(x1,0,N-1);y1=clamp(y1,0,N-1);
  const tpr=tilesPerRow();
  for(let ty=(y0/TS)|0;ty<=((y1/TS)|0);ty++)for(let tx=(x0/TS)|0;tx<=((x1/TS)|0);tx++){
    const k=ty*tpr+tx; if(stroke.tiles.has(k))continue;
    const t={tx,ty,b:{},a:{}};
    for(const l of stroke.layers)t.b[l]=readTile(l,tx,ty);
    if(stroke.layers.includes('h')){const sx=tx*TS,sy=ty*TS;
      for(let r=0;r<TS;r++){scratchH.set(H.subarray((sy+r)*N+sx,(sy+r)*N+sx+TS),(sy+r)*N+sx);strokeA.fill(0,(sy+r)*N+sx,(sy+r)*N+sx+TS);}}
    stroke.tiles.set(k,t);
  }
}
function pushHistory(e){undoStack.push(e);if(undoStack.length>MAXUNDO)undoStack.shift();redoStack.length=0;setModified();}
function endStroke(){
  if(!stroke)return; const s=stroke; stroke=null;
  if(!s.tiles.size)return;
  for(const t of s.tiles.values())for(const l of s.layers)t.a[l]=readTile(l,t.tx,t.ty);
  pushHistory({tiles:[...s.tiles.values()]});
}
function applyEntry(e,after){
  for(const t of e.tiles){const d=after?t.a:t.b;for(const l in d)writeTile(l,t.tx,t.ty,d[l]);
    edited(t.tx*TS,t.ty*TS,t.tx*TS+TS,t.ty*TS+TS);}
  if(e.roads){roads=JSON.parse(after?e.roads.a:e.roads.b);selRoad=Math.min(selRoad,roads.length-1);selPt=-1;drawing=false;refreshRoadUI();}
  if(e.markers){markers=JSON.parse(after?e.markers.a:e.markers.b);selMarker=Math.min(selMarker,markers.length-1);markersChanged();}
  if(e.roads)metaChanged();
  setModified();
}
function undo(){endStroke();const e=undoStack.pop();if(!e){toast('Nothing to undo');return;}applyEntry(e,false);redoStack.push(e);}
function redo(){const e=redoStack.pop();if(!e){toast('Nothing to redo');return;}applyEntry(e,true);undoStack.push(e);}
function setModified(){modified=true;needDraw=true;}

// =====================================================================================
// SECTION 4: rendering (incremental, dirty rect)
// =====================================================================================
let dirty = null, needDraw = true;
function markDirty(x0,y0,x1,y1){            // x1,y1 exclusive
  x0=Math.max(0,x0);y0=Math.max(0,y0);x1=Math.min(N,x1);y1=Math.min(N,y1);
  if(!dirty)dirty={x0,y0,x1,y1};else{dirty.x0=Math.min(dirty.x0,x0);dirty.y0=Math.min(dirty.y0,y0);dirty.x1=Math.max(dirty.x1,x1);dirty.y1=Math.max(dirty.y1,y1);}
  needDraw=true;
}
const RAMP = (()=>{const st=[[0,[56,98,70]],[.12,[80,128,70]],[.3,[138,160,84]],[.5,[170,150,100]],[.72,[140,122,108]],[.9,[200,196,194]],[1,[255,255,255]]];
  const r=new Float32Array(256),g=new Float32Array(256),b=new Float32Array(256);
  for(let i=0;i<256;i++){const t=i/255;let k=0;while(k<st.length-2&&t>st[k+1][0])k++;
    const a=st[k],c=st[k+1],f=clamp((t-a[0])/(c[0]-a[0]),0,1);
    r[i]=a[1][0]+(c[1][0]-a[1][0])*f;g[i]=a[1][1]+(c[1][1]-a[1][1])*f;b[i]=a[1][2]+(c[1][2]-a[1][2])*f;}
  return {r,g,b};})();
const LIGHT = (()=>{const x=-0.5,y=0.75,z=-0.45,l=Math.hypot(x,y,z);return [x/l,y/l,z/l];})();

function renderRegion(rx0,ry0,rx1,ry1){
  const mix = view.mode==='height'?0:view.mode==='biome'?1:view.biomeOp;
  const sc = S.maxH/(S.world/N)*1.5*0.5;
  const sea=S.sea, wop=view.waterOp, showW=view.water;
  const [LX,LY,LZ]=LIGHT;
  for(let y=ry0;y<ry1;y++){
    const yu=y>0?-N:0, yd=y<N-1?N:0;
    for(let x=rx0;x<rx1;x++){
      const i=y*N+x, h=H[i];
      const ri=(h*255+0.5)|0;
      let r=RAMP.r[ri],g=RAMP.g[ri],b=RAMP.b[ri];
      if(mix>0){
        let br=0,bg=0,bb=0;
        for(let c=0;c<8;c++){const w=WC[c][i];if(w){br+=w*CR[c];bg+=w*CG[c];bb+=w*CB[c];}}
        br/=255;bg/=255;bb/=255;
        r+=(br-r)*mix;g+=(bg-g)*mix;b+=(bb-b)*mix;
      }
      const dx=(H[i+(x<N-1?1:0)]-H[i-(x>0?1:0)])*sc, dz=(H[i+yd]-H[i+yu])*sc;
      let m=1+((-dx*LX+LY-dz*LZ)/Math.sqrt(dx*dx+dz*dz+1)-LY)*2.2;
      m=m<0.3?0.3:m>1.7?1.7:m; r*=m;g*=m;b*=m;
      if(showW){
        let depth=-1; if(h<sea)depth=sea-h;
        const lv=WL[i]; if(lv>=0&&lv>h&&lv-h>depth)depth=lv-h;
        if(depth>=0){
          const t=depth*10>1?1:depth*10, a=wop*(0.5+0.45*t);
          const wr=70-50*t, wg=140-90*t, wb=210-90*t;
          r+=(wr-r)*a;g+=(wg-g)*a;b+=(wb-b)*a;
        }
      }
      r=r>255?255:r;g=g>255?255:g;b=b>255?255:b;
      img32[i]=0xFF000000|((b|0)<<16)|((g|0)<<8)|(r|0);
    }
  }
}
function flushRender(){
  if(!dirty)return;
  const x0=Math.max(0,dirty.x0-1),y0=Math.max(0,dirty.y0-1),x1=Math.min(N,dirty.x1+1),y1=Math.min(N,dirty.y1+1);
  dirty=null;
  renderRegion(x0,y0,x1,y1);
  mctx.putImageData(img,0,0,x0,y0,x1-x0,y1-y0);
}
function fullRender(){markDirty(0,0,N,N);}
// pixel data changed (exclusive rect): re-render the 2D map AND tell the 3D preview (view-only changes use markDirty/fullRender instead)
let pv=null;
function edited(x0,y0,x1,y1){markDirty(x0,y0,x1,y1);if(pv)pv.invalidate({x0,y0,x1,y1});}
function metaChanged(){if(pv)pv.invalidate(null);}   // roads / markers / sea level / world size changed


// =====================================================================================
// SECTION 4b: adaptive grid overlay (separate canvas #gv; redrawn only when view/hover/grid state changes)
// =====================================================================================
// Metric grid: decades 1 m, 10 m, 100 m, ... shown when on-screen spacing >= ~10 px (fade 6..14 px).
// Quadrant overlay (quadtree): shown when the whole map fits in view OR the coarsest decade gives < minLinesAcross lines
// across the map. Tweak the QUAD constants to change the behaviour.
const QUAD = {maxDepth:3, minCellPx:150, hidePx:1500, minLinesAcross:4, color:'108,200,255'};
const GRID = {minPx:10, fadePx:4, maxDecade:5, maxLines:1500, labelPx:60};
const gv = $('gv'), gctx = gv.getContext('2d');
let gridInfo = '', gridSig = [];
function fmtM(m){return m>=1000?(+(m/1000).toFixed(3))+' km':(+m.toFixed(2))+' m';}
function gridDirty(){
  const sig=[view.ox,view.oy,view.z,hover?hover.sx:-1,hover?hover.sy:-1,view.grid,S.world,N,gv.width,gv.height];
  for(let i=0;i<sig.length;i++)if(sig[i]!==gridSig[i]){gridSig=sig;return true;}
  return false;
}
function haloText(t,x,y){gctx.lineWidth=3;gctx.strokeStyle='rgba(0,0,0,.75)';gctx.strokeText(t,x,y);gctx.fillStyle='#fff';gctx.fillText(t,x,y);}
function drawGrid(){
  const w=gv.width,h=gv.height;
  gctx.setTransform(1,0,0,1,0,0);gctx.clearRect(0,0,w,h);gctx.setLineDash([]);
  gridInfo='';
  if(!view.grid){updateStatus();return;}
  const z=view.z, ppm=z/(S.world/N), size=N*z, x0=view.ox,y0=view.oy,x1=x0+size,y1=y0+size;
  const vx0=Math.max(0,x0),vx1=Math.min(w,x1),vy0=Math.max(0,y0),vy1=Math.min(h,y1);
  if(vx1<=vx0||vy1<=vy0){gridInfo='Grid (map off-screen)';updateStatus();return;}
  let budget=GRID.maxLines, finest=-1, labelK=-1;
  const lv=[];
  for(let k=0;k<=GRID.maxDecade;k++){
    const sp=10**k*ppm; if(sp>=GRID.minPx&&finest<0)finest=k; if(sp>=GRID.labelPx&&labelK<0)labelK=k;
    const t=clamp((sp-(GRID.minPx-GRID.fadePx))/(2*GRID.fadePx),0,1), a=t*t*(3-2*t);
    if(a>0)lv.push({k,sp,a});
  }
  gctx.lineCap='butt';
  for(const L of lv){
    const step=10**L.k, mx0=Math.ceil((vx0-x0)/ppm/step), mx1=Math.min(Math.floor(S.world/step),Math.floor((vx1-x0)/ppm/step));
    const my0=Math.ceil((vy0-y0)/ppm/step), my1=Math.min(Math.floor(S.world/step),Math.floor((vy1-y0)/ppm/step));
    const cnt=Math.max(0,mx1-mx0+1)+Math.max(0,my1-my0+1); if(cnt>budget)continue; budget-=cnt;
    const minor=new Path2D(), major=new Path2D();
    for(let i=mx0;i<=mx1;i++){const sx=Math.round(x0+i*step*ppm)+.5,p=i%10===0?major:minor;p.moveTo(sx,vy0);p.lineTo(sx,vy1);}
    for(let i=my0;i<=my1;i++){const sy=Math.round(y0+i*step*ppm)+.5,p=i%10===0?major:minor;p.moveTo(vx0,sy);p.lineTo(vx1,sy);}
    gctx.lineWidth=1;gctx.strokeStyle='rgba(255,255,255,'+(0.16*L.a)+')';gctx.stroke(minor);
    gctx.lineWidth=1.5;gctx.strokeStyle='rgba(255,235,170,'+(0.45*L.a)+')';gctx.stroke(major);
  }
  if(finest>=0)gridInfo='Grid '+fmtM(10**finest);
  // metre labels along the viewport edges
  if(labelK>=0&&budget>0){
    const step=10**labelK,L=lv.find(q=>q.k===labelK), a=L?L.a:1;
    gctx.font='10px system-ui,sans-serif';gctx.globalAlpha=Math.min(1,a);gctx.textBaseline='top';gctx.textAlign='left';
    let n=0;
    for(let i=Math.ceil((vx0-x0)/ppm/step);i<=Math.floor(Math.min(S.world,(vx1-x0)/ppm)/step)&&n<60;i++,n++){
      const sx=Math.round(x0+i*step*ppm); haloText(fmtM(i*step),sx+3,2);}
    for(let i=Math.ceil((vy0-y0)/ppm/step);i<=Math.floor(Math.min(S.world,(vy1-y0)/ppm)/step)&&n<120;i++,n++){
      const sy=Math.round(y0+i*step*ppm); haloText(fmtM(i*step),3,sy+2);}
    gctx.globalAlpha=1;
  }
  // quadrant overlay
  let kc=0;while(10**(kc+1)<=S.world)kc++;
  const fits=x0>=0&&y0>=0&&x1<=w&&y1<=h;
  if(fits||Math.floor(S.world/10**kc)<QUAD.minLinesAcross){
    let D=1;while(D<QUAD.maxDepth&&size/2**(D+1)>=QUAD.minCellPx)D++;
    if(size/2**D<=QUAD.hidePx){
      const col=QUAD.color;
      for(let l=1;l<=D;l++){
        const p=new Path2D(),n=2**l;
        for(let j=1;j<n;j+=2){const sx=Math.round(x0+size*j/n)+.5,sy=Math.round(y0+size*j/n)+.5;
          if(sx>=vx0&&sx<=vx1){p.moveTo(sx,vy0);p.lineTo(sx,vy1);} if(sy>=vy0&&sy<=vy1){p.moveTo(vx0,sy);p.lineTo(vx1,sy);}}
        gctx.lineWidth=l===1?2:1.25;gctx.strokeStyle='rgba('+col+','+(0.8-0.18*(l-1))+')';gctx.stroke(p);
      }
      gridInfo+=(gridInfo?' | ':'')+'Quadrants '+2**D+'x'+2**D;
      if(hover){
        const [mx,my]=toMapPt(hover.sx,hover.sy), n=2**D;
        if(mx>=0&&my>=0&&mx<N&&my<N){
          const cx=Math.floor(mx/N*n),cy=Math.floor(my/N*n),cw=size/n,rx=x0+cx*cw,ry=y0+cy*cw;
          gctx.fillStyle='rgba('+col+',0.16)';gctx.fillRect(rx,ry,cw,cw);
          gctx.lineWidth=2;gctx.strokeStyle='rgba('+col+',1)';gctx.strokeRect(rx+1,ry+1,cw-2,cw-2);
          let name=[];for(let l=1;l<=D;l++){const bx=(cx>>(D-l))&1,by=(cy>>(D-l))&1;name.push((by?'S':'N')+(bx?'E':'W'));}
          const cm=S.world/n, t1=name.join(' > ')+'   ('+fmtM(cm)+' square)',
            t2='x '+fmtM(cx*cm)+' - '+fmtM((cx+1)*cm)+'    z '+fmtM(cy*cm)+' - '+fmtM((cy+1)*cm);
          gctx.font='12px system-ui,sans-serif';gctx.textBaseline='top';
          const bw=Math.max(gctx.measureText(t1).width,gctx.measureText(t2).width)+14,bh=38;
          const bx=clamp(rx+8,6,Math.max(6,w-bw-6)),by=clamp(ry+8,6,Math.max(6,h-bh-6));
          gctx.fillStyle='rgba(0,0,0,.72)';gctx.fillRect(bx,by,bw,bh);
          gctx.strokeStyle='rgba('+col+',.9)';gctx.lineWidth=1;gctx.strokeRect(bx+.5,by+.5,bw-1,bh-1);
          gctx.fillStyle='#fff';gctx.fillText(t1,bx+7,by+4);gctx.fillStyle='#bfe6ff';gctx.fillText(t2,bx+7,by+21);
        }
      }
    }
  }
  updateStatus();
}

// ---- canvas draw (view transform, overlays) ----
const cv = $('cv'), ctx = cv.getContext('2d');
let hover = null;       // {sx,sy,mx,my}
function toMapPt(sx,sy){return [(sx-view.ox)/view.z,(sy-view.oy)/view.z];}
function fitView(){
  const w=cv.width,h=cv.height; view.z=Math.min(w,h)/N*0.95; view.ox=(w-N*view.z)/2; view.oy=(h-N*view.z)/2; needDraw=true;
}
function draw(){
  const w=cv.width,h=cv.height,z=view.z;
  ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle='#0e0f12'; ctx.fillRect(0,0,w,h);
  ctx.imageSmoothingEnabled = z<1;
  const sx0=Math.max(0,Math.floor(-view.ox/z)),sy0=Math.max(0,Math.floor(-view.oy/z));
  const sx1=Math.min(N,Math.ceil((w-view.ox)/z)),sy1=Math.min(N,Math.ceil((h-view.oy)/z));
  if(sx1>sx0&&sy1>sy0)ctx.drawImage(mapCv,sx0,sy0,sx1-sx0,sy1-sy0,view.ox+sx0*z,view.oy+sy0*z,(sx1-sx0)*z,(sy1-sy0)*z);
  ctx.strokeStyle='#555';ctx.lineWidth=1;ctx.strokeRect(view.ox-.5,view.oy-.5,N*z+1,N*z+1);
  if(view.roads||tool==='road')drawRoads();
  drawCursor();
}
// (grid is drawn by drawGrid() in SECTION 4b on the separate overlay canvas #gv)
function drawRoads(){
  const z=view.z, cell=S.world/N; badgeHits=[];
  roads.forEach((rd,ri)=>{
    if(rd.points.length<1)return;
    const sel = ri===selRoad, sm = sampleRoad(rd,Math.max(1,4/z));
    const wpx=Math.max(2,rd.width/cell*z);
    const pS=new Path2D(), pB=new Path2D(); let cur=null;
    for(let j=0;j<sm.x.length-1;j++){
      const br=!!rd.points[sm.seg[j]].bridge, p=br?pB:pS;
      if(cur!==br){p.moveTo(view.ox+sm.x[j]*z,view.oy+sm.z[j]*z);cur=br;}
      p.lineTo(view.ox+sm.x[j+1]*z,view.oy+sm.z[j+1]*z);
    }
    ctx.lineCap='round';ctx.lineJoin='round';
    ctx.setLineDash([]);ctx.lineWidth=wpx;ctx.strokeStyle=sel?'rgba(255,220,80,.35)':'rgba(255,255,255,.22)';ctx.stroke(pS);
    ctx.lineWidth=sel?2:1.5;ctx.strokeStyle=sel?'#ffd84a':'#e8e8e8';ctx.stroke(pS);
    ctx.setLineDash([8,6]);ctx.lineWidth=sel?3:2;ctx.strokeStyle='#ff7a3c';ctx.stroke(pB);ctx.setLineDash([]);
    drawRoadMeta(rd,sm,wpx);
    if(sel||tool==='road'){
      rd.points.forEach((p,pi)=>{
        ctx.beginPath();ctx.arc(view.ox+p.x*N*z,view.oy+p.z*N*z,pi===selPt&&sel?6:4,0,6.3);
        ctx.fillStyle=pi===selPt&&sel?'#fff':p.bridge?'#ff7a3c':sel?'#ffd84a':'#bbb';ctx.fill();ctx.strokeStyle='#000';ctx.lineWidth=1;ctx.stroke();
        if(sel&&selPts.has(pi)&&selOwner===selPt){ctx.beginPath();ctx.arc(view.ox+p.x*N*z,view.oy+p.z*N*z,9,0,6.3);ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}});
    }
  });
  drawAutoBridges(cell);
}
// bridges the LOADER adds over water (roadBridges.js), taken from the 3D preview's map (so they only show while the preview is on, Split / Preview mode)
function drawAutoBridges(cell){
  const ab=pv&&mode!=='paint'&&pv.map&&pv.map.roadDetail&&pv.map.roadDetail.autoBridges; if(!ab||!ab.length)return;
  ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([8,6]);ctx.lineWidth=3;ctx.strokeStyle='#38bdf8';ctx.font='11px sans-serif';ctx.fillStyle='#38bdf8';
  for(const b of ab){
    const q=b.path,p=new Path2D();
    for(let i=0;i<q.length;i+=2){const X=view.ox+q[i]/cell*view.z,Y=view.oy+q[i+1]/cell*view.z;i?p.lineTo(X,Y):p.moveTo(X,Y);}
    ctx.stroke(p);
    if(view.z>=0.5){const m=(q.length>>2)<<1;ctx.fillText('auto bridge over water',view.ox+q[m]/cell*view.z+6,view.oy+q[m+1]/cell*view.z-6);}
  }
  ctx.restore();
}
// ---- road metadata overlay: type stripe, edge dashes (L/R of travel), surface dots, one-way arrows, feature badges (tooltips via cv.title) ----
const EDGE_COL={fence:'#a0662a',guardrail:'#e4e9f1',barrier:'#8d939e',lamps:'#ffe14a'}, TYPE_COL={city:'#22d3ee',highway:'#e040fb'}, SURF_COL={worn:'#e0d2b0',potholes:'#ff6b6b',gravel:'#d9a35c'};
const FEAT_UI={crosswalk:['X','#ffffff','Crosswalk: zebra stripes across the road + two pedestrian signs (city: kerb ramp)'],bump:['B','#ffd400','Speed bump'],rumble:['R','#b9b9b9','Rumble strips'],roadworks:['W','#ff8a1c','Roadworks: cones, barrier, sign']};
let badgeHits=[];
function drawRoadMeta(rd,sm,wpx){
  const n=rd.points.length,z=view.z,L=sm.x.length; if(n<2)return;
  const X=j=>view.ox+sm.x[j]*z, Y=j=>view.oy+sm.z[j]*z, M=j=>rd.points[Math.min(sm.seg[j],n-2)];
  const runs=(colOf,off)=>{const paths=new Map(),last=new Map();
    for(let j=0;j<L-1;j++){const c=colOf(M(j));if(!c)continue;let p=paths.get(c);if(!p)paths.set(c,p=new Path2D());
      let ax=X(j),ay=Y(j),bx=X(j+1),by=Y(j+1);
      if(off){const dx=bx-ax,dy=by-ay,l=Math.hypot(dx,dy)||1,ox=-dy/l*off,oy=dx/l*off;ax+=ox;ay+=oy;bx+=ox;by+=oy;}
      if(last.get(c)!==j-1)p.moveTo(ax,ay);p.lineTo(bx,by);last.set(c,j);}
    return paths;};
  const stroke=(paths,w,dash,cap)=>{ctx.setLineDash(dash);ctx.lineCap=cap;ctx.lineWidth=w;for(const [c,p] of paths){ctx.strokeStyle=c;ctx.stroke(p);}};
  stroke(runs(m=>TYPE_COL[getA(m,'type')],0),3.5,[],'butt');
  stroke(runs(m=>SURF_COL[getA(m,'surface')],0),3.5,[0.1,5],'round');
  const off=wpx/2+3;
  stroke(runs(m=>EDGE_COL[getA(m,'edgeL')],-off),2.5,[5,3],'butt');
  stroke(runs(m=>EDGE_COL[getA(m,'edgeR')],off),2.5,[5,3],'butt');
  ctx.setLineDash([]);ctx.lineCap='round';
  let acc=0;                                          // one-way arrows every ~40 px along the point order
  for(let j=0;j<L-1;j++){
    const dx=X(j+1)-X(j),dy=Y(j+1)-Y(j),l=Math.hypot(dx,dy); acc+=l;
    if(acc<40||!getA(M(j),'oneway')||!l)continue; acc=0;
    const x=X(j),y=Y(j),ux=dx/l,uy=dy/l;
    ctx.beginPath();ctx.moveTo(x+ux*6,y+uy*6);ctx.lineTo(x-ux*4-uy*4.5,y-uy*4+ux*4.5);ctx.lineTo(x-ux*4+uy*4.5,y-uy*4-ux*4.5);ctx.closePath();
    ctx.fillStyle='#fff';ctx.fill();ctx.strokeStyle='#000';ctx.lineWidth=1;ctx.stroke();badgeHits.push({x,y,r:6,text:'One-way: direction = point order (first to last)'});
  }
  ctx.font='bold 9px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  rd.points.forEach(p=>{
    getA(p,'features').forEach((f,k)=>{const [ch,col,tip]=FEAT_UI[f],x=view.ox+p.x*N*z+10+k*14,y=view.oy+p.z*N*z-10;
      ctx.beginPath();ctx.arc(x,y,6.5,0,6.3);ctx.fillStyle=col;ctx.fill();ctx.strokeStyle='#000';ctx.lineWidth=1.2;ctx.stroke();ctx.fillStyle='#000';ctx.fillText(ch,x,y+0.5);badgeHits.push({x,y,r:6.5,text:tip});});
  });
}
function badgeTip(sx,sy){let t='';for(const b of badgeHits)if(Math.hypot(sx-b.x,sy-b.y)<=b.r+2){t=b.text;break;}if(cv.title!==t)cv.title=t;}
function isBrushTool(t){return t!=='road'&&t!=='pan'&&t!=='marker';}
function drawCursor(){
  if(!hover||!isBrushTool(tool)||spaceDown)return;
  const r=brush.radius*view.z;
  ctx.setLineDash([]);ctx.lineWidth=1.5;ctx.strokeStyle='rgba(255,255,255,.9)';
  ctx.beginPath();ctx.arc(hover.sx,hover.sy,r,0,6.3);ctx.stroke();
  ctx.setLineDash([4,4]);ctx.strokeStyle='rgba(255,255,255,.6)';
  ctx.beginPath();ctx.arc(hover.sx,hover.sy,Math.max(1,r*brush.hardness),0,6.3);ctx.stroke();ctx.setLineDash([]);
}

// =====================================================================================
// SECTION 5: sampling helpers
// =====================================================================================
function heightAt(mx,my){            // continuous pixel coords -> normalized height (bilinear, pixel centres)
  const fx=mx-0.5,fy=my-0.5; let x0=Math.floor(fx),y0=Math.floor(fy);const tx=fx-x0,ty=fy-y0;
  const x1=clamp(x0+1,0,N-1),y1=clamp(y0+1,0,N-1);x0=clamp(x0,0,N-1);y0=clamp(y0,0,N-1);
  const a=H[y0*N+x0]+(H[y0*N+x1]-H[y0*N+x0])*tx, b=H[y1*N+x0]+(H[y1*N+x1]-H[y1*N+x0])*tx;
  return a+(b-a)*ty;
}

// =====================================================================================
// SECTION 6: brush tools
// =====================================================================================
function falloff(t){
  const h=brush.hardness; if(t<=h)return 1; if(h>=0.999)return 1;
  const u=(t-h)/(1-h);
  if(brush.shape===1)return 1-u;
  if(brush.shape===2)return Math.pow(1-u,0.3);
  return 1-u*u*(3-2*u);
}
function forBrush(cx,cy,fn){
  const r=brush.radius;
  const x0=Math.max(0,Math.floor(cx-r)),x1=Math.min(N-1,Math.ceil(cx+r)),y0=Math.max(0,Math.floor(cy-r)),y1=Math.min(N-1,Math.ceil(cy+r));
  if(x1<x0||y1<y0)return;
  touch(x0,y0,x1,y1);
  const r2=r*r;
  for(let y=y0;y<=y1;y++){const dy=y+0.5-cy;
    for(let x=x0;x<=x1;x++){const dx=x+0.5-cx,d2=dx*dx+dy*dy;if(d2>=r2)continue;
      fn(y*N+x,falloff(Math.sqrt(d2)/r),x,y);}}
  edited(x0,y0,x1+1,y1+1);
}
const rm = new Int16Array(8);
function paintPixel(i,c,a){            // add coverage of class c, remove proportionally from others, keep sum 255
  const wc=WC[c][i]; if(wc===255)return;
  const rest=255-wc; let d=Math.round(rest*a);
  if(d<1){if(a<0.02)return;d=1;} if(d>rest)d=rest;
  let tot=0;
  for(let k=0;k<8;k++){if(k===c){rm[k]=0;continue;}const v=WC[k][i];let r=v?Math.round(d*v/rest):0;if(r>v)r=v;rm[k]=r;tot+=r;}
  let diff=d-tot;
  while(diff>0){let pr=false;for(let k=0;k<8&&diff>0;k++){if(k!==c&&WC[k][i]-rm[k]>0){rm[k]++;diff--;pr=true;}}if(!pr)break;}
  while(diff<0){for(let k=0;k<8&&diff<0;k++){if(rm[k]>0){rm[k]--;diff++;}}}
  for(let k=0;k<8;k++)if(rm[k])WC[k][i]-=rm[k];
  WC[c][i]=wc+d;
}
const LAYERS = {raise:'h',lower:'h',smooth:'h',flatten:'h',mountain:'h',hills:'h',water:'hw',erasewater:'w',paint:'c'};
const AIR = new Set(['raise','lower','smooth','flatten','mountain','hills','paint']);
let strokeSign=1, flatT=0, waterLv=0, strokeLvl=0, strokeU=0;
const HOLD = new Set(['raise','lower','mountain','hills']);
// Per-stroke "union" deposit: A[i] = largest amount applied so far this stroke. A stamp only adds the difference,
// so hard brushes give clean plateaus/cliffs (no terracing from overlapping stamps) and holding the mouse raises the level.
function unionAdd(i,target,sg){
  const d=target-strokeA[i]; if(sg*d<=0)return;
  strokeA[i]=target; const v=H[i]+d; H[i]=v<0?0:v>1?1:v;
}

function stamp(cx,cy,p){
  const k=brush.strength*p;
  switch(tool){
    case 'raise': case 'lower': {
      const sg=(tool==='raise'?1:-1)*strokeSign, L=strokeLvl*sg;
      forBrush(cx,cy,(i,f)=>unionAdd(i,L*f,sg));break;}
    case 'flatten': {
      const a=Math.min(1,k*1.5);
      forBrush(cx,cy,(i,f)=>{H[i]+=(flatT-H[i])*f*a;});break;}
    case 'mountain': {
      const sc=1/opts.mtScale, sh=opts.mtSharp;
      forBrush(cx,cy,(i,f,x,y)=>unionAdd(i,strokeLvl*f*ridged(x*sc,y*sc,5,sh),1));break;}
    case 'hills': {
      const sc=1/opts.hlScale;
      forBrush(cx,cy,(i,f,x,y)=>unionAdd(i,strokeLvl*f*(fbm(x*sc+31.7,y*sc+17.3,4)*0.5+0.5),1));break;}
    case 'smooth': {
      const r=brush.radius,x0=Math.max(0,Math.floor(cx-r)-1),x1=Math.min(N-1,Math.ceil(cx+r)+1),y0=Math.max(0,Math.floor(cy-r)-1),y1=Math.min(N-1,Math.ceil(cy+r)+1);
      const w=x1-x0+1,h=y1-y0+1,tmp=new Float32Array(w*h);
      for(let y=0;y<h;y++)tmp.set(H.subarray((y0+y)*N+x0,(y0+y)*N+x0+w),y*w);
      const a=Math.min(1,k);
      forBrush(cx,cy,(i,f,x,y)=>{
        const lx=x-x0,ly=y-y0;let s=0;
        for(let j=-1;j<=1;j++){const yy=clamp(ly+j,0,h-1)*w;for(let q=-1;q<=1;q++)s+=tmp[yy+clamp(lx+q,0,w-1)];}
        H[i]+=(s/9-H[i])*f*a;});break;}
    case 'water': {
      const dn=opts.waterDepth/S.maxH;
      forBrush(cx,cy,(i,f)=>{
        const bed=scratchH[i]-dn*f; if(bed<H[i])H[i]=bed;
        if(f>0.001&&H[i]<waterLv)WL[i]=waterLv;});break;}
    case 'erasewater': forBrush(cx,cy,(i,f)=>{if(f>0.01)WL[i]=-1;});break;
    case 'paint': {
      const c=opts.cls,a=k*0.5;
      forBrush(cx,cy,(i,f)=>paintPixel(i,c,f*a));break;}
  }
}

// ---- stroke driver (spacing interpolation) ----
let active=false, lx=0,ly=0,lp=1,acc=0, moved=false;
function startStroke(e,mx,my){
  strokeSign=e.shiftKey?-1:1;
  beginStroke(LAYERS[tool]);
  const px=clamp(Math.floor(mx),0,N-1),py=clamp(Math.floor(my),0,N-1);
  if(tool==='flatten')flatT=opts.flatTyped?opts.flatMeters/S.maxH:opts.flatPicked!==null?opts.flatPicked:H[py*N+px];
  if(tool==='water')waterLv=H[py*N+px]-0.002;
  strokeU=brush.strength*(tool==='mountain'?opts.mtAmp*0.03:tool==='hills'?opts.hlAmp*0.025:0.02);
  strokeLvl=strokeU*(tool==='raise'||tool==='lower'?4:8);
  active=true; acc=0; lp=pressureOf(e); lx=mx;ly=my;
  stamp(mx,my,lp); moved=true;
}
function pressureOf(e){return e.pointerType==='pen'?(e.pressure||0.5):1;}
function strokeTo(x,y,p){
  const dx=x-lx,dy=y-ly,d=Math.hypot(dx,dy),sp=Math.max(1,brush.radius*0.2);
  if(d>0){
    acc+=d;
    while(acc>=sp){acc-=sp;const t=1-acc/d;stamp(lx+dx*t,ly+dy*t,lp+(p-lp)*t);}
  }
  lx=x;ly=y;lp=p;moved=true;
}
function finishStroke(){if(!active)return;active=false;endStroke();}

// =====================================================================================
// SECTION 7: roads (spline, editing, bake)
// =====================================================================================
let selRoad=-1, selPt=-1, drawing=false, dragging=null;
// ---- road node metadata (see roadMeta.js): a field is stored on the point ONLY when it differs from its default ----
const SEG_KEYS=['type','oneway','edgeL','edgeR','surface','signs'], NODE_KEYS=[...SEG_KEYS,'features'];
function getA(p,k){return k==='features'?(p.features||[]):(p[k]===undefined?NODE_DEFAULTS[k]:p[k]);}
function setA(p,k,v){
  if(k==='features'){const f=FEATURES.filter(x=>v.includes(x));if(f.length)p.features=f;else delete p.features;return;}
  if(v===NODE_DEFAULTS[k])delete p[k];else p[k]=v;
}
// multi-selection of points on the selected road: selPts (Set of indices), selPt = primary, selAnch = anchor for shift-range
let selPts=new Set(), selOwner=-2, selOwnerRoad=-2, selAnch=-1;
function syncSel(){            // selection indices (sorted); resets to {selPt} when selPt was changed elsewhere (insert, delete, undo, list click)
  if(selRoad<0||selPt<0){selPts=new Set();return [];}
  if(selOwner!==selPt||selOwnerRoad!==selRoad){selPts=new Set([selPt]);selOwner=selPt;selOwnerRoad=selRoad;selAnch=selPt;}
  const n=roads[selRoad]?roads[selRoad].points.length:0;
  return [...selPts].filter(i=>i<n).sort((a,b)=>a-b);
}
function editSel(fn){          // apply fn(point,index) to every selected point as ONE undo step
  const idx=syncSel(); if(!idx.length)return;
  const b=snap(),rd=roads[selRoad]; idx.forEach(i=>fn(rd.points[i],i)); commitRoads(b); needDraw=true;
}
function applySegAttrs(from){  // copy the primary point's segment attributes onto points from..end of the road (features are per node, not copied)
  const rd=roads[selRoad],src=rd&&rd.points[selPt]; if(!src)return;
  const b=snap(),vals=SEG_KEYS.map(k=>getA(src,k));
  for(let i=from;i<rd.points.length;i++)SEG_KEYS.forEach((k,ki)=>setA(rd.points[i],k,vals[ki]));
  commitRoads(b);needDraw=true;
}
function autoTypeFromCityPaint(){  // selected road: type city where the segment midpoint lies on pixels with city weight > 50%; others unchanged; one undo step
  const rd=roads[selRoad]; if(!rd||rd.points.length<2){toast('Select a road first');return;}
  const sm=sampleRoad(rd,1e9), b=snap(); let n=0;        // huge step = exactly the points t=0 and t=0.5 of every segment
  for(let j=0;j<sm.x.length;j++){
    if(sm.t[j]!==0.5)continue; const px=clamp(Math.floor(sm.x[j]),0,N-1),py=clamp(Math.floor(sm.z[j]),0,N-1);
    if(WC[7][py*N+px]>127&&getA(rd.points[sm.seg[j]],'type')!=='city'){setA(rd.points[sm.seg[j]],'type','city');n++;}
  }
  commitRoads(b); toast(n?n+' segment(s) set to city':'No segment midpoint on city paint (or already city)');
}
function inheritSeg(rd,from,to){const a=rd.points[from],c=rd.points[to];if(a&&c)for(const k of SEG_KEYS)if(a[k]!==undefined&&c[k]===undefined)c[k]=a[k];}
function roadSummary(r){
  const pts=r.points.length>1?r.points.slice(0,-1):r.points, uniq=(f)=>[...new Set(pts.flatMap(f))];
  const parts=[], ty=uniq(p=>getA(p,'type')!=='country'?[getA(p,'type')]:[]); if(ty.length)parts.push(ty.join('/'));
  if(pts.some(p=>getA(p,'oneway')))parts.push('oneway');
  const ed=uniq(p=>[getA(p,'edgeL'),getA(p,'edgeR')].filter(e=>e!=='none')); if(ed.length)parts.push('edge '+ed.join('/'));
  const sf=uniq(p=>getA(p,'surface')!=='smooth'?[getA(p,'surface')]:[]); if(sf.length)parts.push(sf.join('/'));
  const nf=r.points.reduce((a,p)=>a+getA(p,'features').length,0); if(nf)parts.push(nf+' feat');
  if(pts.some(p=>getA(p,'signs')==='off'))parts.push('signs off');
  if(r.points.some(p=>p.bridge))parts.push('bridge');
  return parts.join(' · ');
}
function sampleRoad(rd,step){            // uniform Catmull-Rom; positions in map px
  const P=rd.points,n=P.length,out={x:[],z:[],seg:[],t:[]};
  if(n===0)return out;
  if(n===1){out.x.push(P[0].x*N);out.z.push(P[0].z*N);out.seg.push(0);out.t.push(0);return out;}
  for(let i=0;i<n-1;i++){
    const p0=P[Math.max(i-1,0)],p1=P[i],p2=P[i+1],p3=P[Math.min(i+2,n-1)];
    const len=Math.hypot(p2.x-p1.x,p2.z-p1.z)*N, m=Math.max(2,Math.ceil(len/step));
    for(let k=0;k<m;k++){const t=k/m,t2=t*t,t3=t2*t;
      const cr=(a,b,c,d)=>0.5*(2*b+(-a+c)*t+(2*a-5*b+4*c-d)*t2+(-a+3*b-3*c+d)*t3);
      out.x.push(cr(p0.x,p1.x,p2.x,p3.x)*N);out.z.push(cr(p0.z,p1.z,p2.z,p3.z)*N);out.seg.push(i);out.t.push(t);}
  }
  out.x.push(P[n-1].x*N);out.z.push(P[n-1].z*N);out.seg.push(n-2);out.t.push(1);
  return out;
}
const snap = () => JSON.stringify(roads);
function commitRoads(before){
  const after=snap(); if(after===before)return;
  pushHistory({tiles:[],roads:{b:before,a:after}}); refreshRoadUI(); metaChanged();
}
function findPoint(mx,my){
  const tol=9/view.z; let best=null,bd=tol;
  roads.forEach((rd,ri)=>rd.points.forEach((p,pi)=>{const d=Math.hypot(p.x*N-mx,p.z*N-my)-(ri===selRoad?1:0);if(d<bd){bd=d;best={ri,pi};}}));
  return best;
}
function findSegment(mx,my){
  const tol=7/view.z; let best=null,bd=tol;
  roads.forEach((rd,ri)=>{if(rd.points.length<2)return;const sm=sampleRoad(rd,Math.max(1,3/view.z));
    for(let j=0;j<sm.x.length-1;j++){
      const ax=sm.x[j],az=sm.z[j],bx=sm.x[j+1]-ax,bz=sm.z[j+1]-az,l2=bx*bx+bz*bz;
      const t=l2?clamp(((mx-ax)*bx+(my-az)*bz)/l2,0,1):0, d=Math.hypot(ax+bx*t-mx,az+bz*t-my);
      if(d<bd){bd=d;best={ri,seg:sm.seg[j]};}}});
  return best;
}
function roadDown(e,mx,my){
  const before=snap(), hit=findPoint(mx,my);
  if(hit){
    if(hit.ri!==selRoad)drawing=false;
    const same=hit.ri===selRoad&&selPt>=0; if(same)syncSel(); selRoad=hit.ri;
    if(e.shiftKey&&same){selPts=new Set();for(let i=Math.min(selAnch,hit.pi);i<=Math.max(selAnch,hit.pi);i++)selPts.add(i);selPt=hit.pi;}   // range from the anchor
    else if((e.ctrlKey||e.metaKey)&&same){selPts.has(hit.pi)?selPts.delete(hit.pi):selPts.add(hit.pi);selPt=selPts.has(hit.pi)?hit.pi:(selPts.size?[...selPts][0]:-1);selAnch=hit.pi;} // toggle
    else{selPt=hit.pi;selPts=new Set([hit.pi]);selAnch=hit.pi;dragging={before,moved:false};}
    selOwner=selPt;selOwnerRoad=selRoad;
    refreshRoadUI();needDraw=true;return;}
  if(e.detail>=2&&drawing){finishRoad();return;}
  const seg=drawing?null:findSegment(mx,my);
  if(seg){selRoad=seg.ri;selPt=seg.seg+1;const np={x:clamp(mx/N,0,1),z:clamp(my/N,0,1),bridge:false};inheritSeg({points:[roads[seg.ri].points[seg.seg],np]},0,1);roads[seg.ri].points.splice(seg.seg+1,0,np);
    dragging={before,moved:true};refreshRoadUI();needDraw=true;return;}
  if(!drawing||selRoad<0){roads.push({id:nextRoadId++,width:8,points:[]});selRoad=roads.length-1;drawing=true;}
  const rd=roads[selRoad]; rd.points.push({x:clamp(mx/N,0,1),z:clamp(my/N,0,1),bridge:false}); selPt=rd.points.length-1; if(rd.points.length>=3)inheritSeg(rd,rd.points.length-3,rd.points.length-2);
  commitRoads(before); needDraw=true;
}
function finishRoad(){
  if(drawing&&selRoad>=0&&roads[selRoad].points.length<2){const b=snap();roads.splice(selRoad,1);selRoad=-1;selPt=-1;commitRoads(b);}
  drawing=false;selPt=-1;refreshRoadUI();needDraw=true;
}
function deletePoint(){
  if(selRoad<0||selPt<0)return; const b=snap(),rd=roads[selRoad];
  rd.points.splice(selPt,1); selPt=-1;
  if(!rd.points.length){roads.splice(selRoad,1);selRoad=-1;drawing=false;}
  commitRoads(b);needDraw=true;
}
function bakeRoads(){
  const cell=S.world/N; let any=false;
  endStroke(); beginStroke('hc');
  for(const rd of roads){
    if(rd.points.length<2)continue;
    const sm=sampleRoad(rd,0.5), runs=[]; let cur=null;
    for(let j=0;j<sm.x.length;j++){
      const sgi=Math.min(sm.seg[j],rd.points.length-2), bridge=!!rd.points[sgi].bridge;
      if(bridge){cur=null;continue;}
      if(!cur){cur=[];runs.push(cur);} cur.push(j);
    }
    const halfW=Math.max(0.75,rd.width/2/cell), shoulder=Math.max(0.5,opts.shoulder/cell), R=halfW+shoulder;
    for(const run of runs){
      if(run.length<2)continue;
      const n=run.length, xs=run.map(j=>sm.x[j]), zs=run.map(j=>sm.z[j]);
      const prof=new Float64Array(n), pre=new Float64Array(n+1);
      for(let k=0;k<n;k++){prof[k]=heightAt(xs[k],zs[k]);pre[k+1]=pre[k]+prof[k];}
      const wn=Math.max(1,Math.round(opts.smoothM/cell/0.5)), sp=new Float32Array(n);
      for(let k=0;k<n;k++){const hw=Math.min(wn,k,n-1-k);sp[k]=(pre[k+hw+1]-pre[k-hw])/(2*hw+1);}
      let bx0=Infinity,by0=Infinity,bx1=-Infinity,by1=-Infinity;
      for(let k=0;k<n;k++){bx0=Math.min(bx0,xs[k]);bx1=Math.max(bx1,xs[k]);by0=Math.min(by0,zs[k]);by1=Math.max(by1,zs[k]);}
      bx0=Math.max(0,Math.floor(bx0-R-1));by0=Math.max(0,Math.floor(by0-R-1));bx1=Math.min(N-1,Math.ceil(bx1+R+1));by1=Math.min(N-1,Math.ceil(by1+R+1));
      const w=bx1-bx0+1,h=by1-by0+1; if(w<=0||h<=0)continue;
      touch(bx0,by0,bx1,by1);
      const best=new Float32Array(w*h).fill(1e9), bh=new Float32Array(w*h);
      for(let k=0;k<n;k++){
        const x0=Math.max(bx0,Math.floor(xs[k]-R)),x1=Math.min(bx1,Math.ceil(xs[k]+R)),y0=Math.max(by0,Math.floor(zs[k]-R)),y1=Math.min(by1,Math.ceil(zs[k]+R));
        for(let y=y0;y<=y1;y++){const dy=y+0.5-zs[k];for(let x=x0;x<=x1;x++){const dx=x+0.5-xs[k],d=dx*dx+dy*dy,q=(y-by0)*w+(x-bx0);
          if(d<best[q]){best[q]=d;bh[q]=sp[k];}}}
      }
      for(let y=by0;y<=by1;y++)for(let x=bx0;x<=bx1;x++){
        const q=(y-by0)*w+(x-bx0); if(best[q]>=1e9)continue;
        const d=Math.sqrt(best[q]); if(d>=R)continue;
        const i=y*N+x;
        let g=d<=halfW?1:1-(t=>t*t*(3-2*t))((d-halfW)/shoulder);
        H[i]+=(bh[q]-H[i])*g;
        const a=clamp((halfW+0.75-d)/1.5,0,1); if(a>0)paintPixel(i,6,a);
      }
      edited(bx0,by0,bx1+1,by1+1); any=true;
    }
  }
  endStroke();
  toast(any?'Roads baked into terrain (undoable)':'No non-bridge road segments to bake');
}

// =====================================================================================
// SECTION 7b: markers (pins with metadata; exported as markers.json, looked up by name/tag in the game)
// =====================================================================================
// Stored normalized (x,z in 0..1 like roads); the height is NEVER stored: y = terrain height + yOffset, derived at export/render time.
// yaw in degrees, 0 = +X (east), +90 = +Z (south / down the 2D map): forward = (cos yaw, sin yaw) in (x,z).
const MARKER_COLORS=['#ff3b30','#ff9500','#ffd400','#7ed321','#00b894','#00cec9','#30a0ff','#5856d6','#af52de','#ff2d92','#ffffff','#8e8e93'];
const QUICK_TAGS=['spawn','checkpoint','ramp','loop','vehicle_spawn','pickup','trigger','prop'];
const PIN_R=9, ARROW_PX=34;                 // constant on-screen size (px)
let markers=[], nextMarkerId=1, selMarker=-1, markersVer=0, mDrag=null, mFilter='';
const snapM=()=>JSON.stringify(markers);
function markersChanged(){markersVer++;needDraw=true;refreshMarkerUI();metaChanged();}
function commitMarkers(before){const after=snapM();if(after===before)return;pushHistory({tiles:[],markers:{b:before,a:after}});markersChanged();}
const slug=t=>String(t).toLowerCase().trim().replace(/[^a-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'');
function dupNames(){const c={};for(const m of markers)if(m.name)c[m.name]=(c[m.name]||0)+1;return c;}
function addMarker(mx,my){
  const b=snapM();
  markers.push({id:nextMarkerId++,name:'',tags:[],color:MARKER_COLORS[markers.length%MARKER_COLORS.length],x:clamp(mx/N,0,1),z:clamp(my/N,0,1),yOffset:0,yaw:0,radius:0,props:{}});
  selMarker=markers.length-1;commitMarkers(b);
}
function deleteMarker(){if(selMarker<0)return;const b=snapM();markers.splice(selMarker,1);selMarker=-1;commitMarkers(b);}
const markerScreen=m=>[view.ox+m.x*N*view.z,view.oy+m.z*N*view.z];
function hitMarker(sx,sy){
  for(let i=markers.length-1;i>=0;i--){const [x,y]=markerScreen(markers[i]);
    if(Math.hypot(sx-x,sy-(y-2*PIN_R))<=PIN_R+3||Math.hypot(sx-x,sy-y)<=7)return i;}
  return -1;
}
function yawHandle(m){const [x,y]=markerScreen(m),a=m.yaw*Math.PI/180;return [x+Math.cos(a)*ARROW_PX,y+Math.sin(a)*ARROW_PX];}
function markerDown(e,sx,sy,mx,my){
  if(selMarker>=0){const [hx,hy]=yawHandle(markers[selMarker]);if(Math.hypot(sx-hx,sy-hy)<=9){mDrag={mode:'yaw',before:snapM()};return;}}
  const i=hitMarker(sx,sy);
  if(i>=0){selMarker=i;const m=markers[i];mDrag={mode:'move',before:snapM(),ox:m.x*N-mx,oy:m.z*N-my,moved:false};markersVer++;needDraw=true;refreshMarkerUI();return;}
  if(mx<0||my<0||mx>=N||my>=N){selMarker=-1;markersVer++;needDraw=true;refreshMarkerUI();return;}
  addMarker(mx,my);
}
function markerMove(e,mx,my){
  const m=markers[selMarker];if(!m||!mDrag)return;
  if(mDrag.mode==='move'){m.x=clamp((mx+mDrag.ox)/N,0,1);m.z=clamp((my+mDrag.oy)/N,0,1);mDrag.moved=true;}
  else{let a=Math.atan2(my-m.z*N,mx-m.x*N)*180/Math.PI;if(e.shiftKey)a=Math.round(a/15)*15;a=Math.round(a*10)/10;m.yaw=a<0?a+360:a;mDrag.moved=true;}
  markersVer++;needDraw=true;refreshMarkerUI(true);metaChanged();
}
function markerUp(){const d=mDrag;mDrag=null;if(d&&d.moved)commitMarkers(d.before);}

// ---- 2D overlay canvas (#mv): redrawn only when view / markers / selection change; never touches the map render ----
const mv=$('mv'),mx2=mv.getContext('2d');
let markerSig=[];
function markersDirty(){
  const sig=[view.ox,view.oy,view.z,markersVer,selMarker,view.markers,mv.width,mv.height,S.world,N];
  for(let i=0;i<sig.length;i++)if(sig[i]!==markerSig[i]){markerSig=sig;return true;}
  return false;
}
function pinPath(c,x,y){                     // teardrop: tip at (x,y), round head of radius PIN_R above it
  const r=PIN_R,cy=y-2*r;
  c.beginPath();c.moveTo(x,y);c.lineTo(x-0.866*r,cy+0.5*r);c.arc(x,cy,r,150*Math.PI/180,390*Math.PI/180,false);c.closePath();
}
function drawMarkers(){
  const c=mx2;c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,mv.width,mv.height);
  if(!view.markers)return;
  const cell=S.world/N,dups=dupNames();
  c.font='11px system-ui,sans-serif';c.textAlign='center';c.textBaseline='bottom';
  for(let i=0;i<markers.length;i++){
    const m=markers[i],[x,y]=markerScreen(m);
    if(x<-60||y<-60||x>mv.width+60||y>mv.height+60)continue;
    const sel=i===selMarker,a=m.yaw*Math.PI/180;
    if(m.radius>0){const rp=m.radius/cell*view.z;c.beginPath();c.arc(x,y,rp,0,6.3);c.fillStyle=m.color+'33';c.fill();c.setLineDash([6,4]);c.lineWidth=1.5;c.strokeStyle=m.color;c.stroke();c.setLineDash([]);}
    const L=sel?ARROW_PX:ARROW_PX*0.7,ex=x+Math.cos(a)*L,ey=y+Math.sin(a)*L;
    c.lineWidth=3;c.strokeStyle='rgba(0,0,0,.7)';c.beginPath();c.moveTo(x,y);c.lineTo(ex,ey);c.stroke();
    c.lineWidth=1.5;c.strokeStyle=m.color;c.beginPath();c.moveTo(x,y);c.lineTo(ex,ey);c.stroke();
    c.fillStyle=m.color;c.beginPath();c.moveTo(ex+Math.cos(a)*6,ey+Math.sin(a)*6);c.lineTo(ex-Math.cos(a)*3+Math.sin(a)*4,ey-Math.sin(a)*3-Math.cos(a)*4);c.lineTo(ex-Math.cos(a)*3-Math.sin(a)*4,ey-Math.sin(a)*3+Math.cos(a)*4);c.closePath();c.fill();
    pinPath(c,x,y);c.fillStyle=m.color;c.fill();c.lineWidth=sel?2.5:1.5;c.strokeStyle=sel?'#fff':'rgba(0,0,0,.8)';c.stroke();
    c.beginPath();c.arc(x,y-2*PIN_R,3,0,6.3);c.fillStyle='rgba(255,255,255,.9)';c.fill();
    if(sel){c.beginPath();c.arc(ex,ey,5,0,6.3);c.fillStyle='#fff';c.fill();c.lineWidth=1.5;c.strokeStyle=m.color;c.stroke();}
    if((view.z>=0.35||sel)&&(m.name||dups[m.name])){
      const t=m.name||'';c.lineWidth=3;c.strokeStyle='rgba(0,0,0,.75)';c.strokeText(t,x,y-2*PIN_R-PIN_R-3);c.fillStyle=dups[m.name]>1?'#ff8a80':'#fff';c.fillText(t,x,y-2*PIN_R-PIN_R-3);
    }
  }
}
function centerOnMarker(m){view.ox=cv.width/2-m.x*N*view.z;view.oy=cv.height/2-m.z*N*view.z;needDraw=true;}

// ---- marker list + inspector (DOM built once in buildMarkerUI, values refreshed by refreshMarkerUI) ----
const mui={};
function buildMarkerUI(parent){
  const d=parent;
  mui.vis=checkbox(d,'Show markers',view.markers,v=>{view.markers=v;markersVer++;needDraw=true;if(pv)pv.setMarkersVisible(v);});
  mui.filter=h('input',{type:'text',placeholder:'filter by name or tag'});mui.filter.style.width='100%';
  mui.filter.oninput=()=>{mFilter=mui.filter.value.toLowerCase().trim();refreshMarkerUI();};
  d.append(mui.filter,mui.list=h('div',{id:'mklist'}));
  d.append(h('div',{className:'small',textContent:'Marker tool (K): click empty = place, click pin = select, drag = move, drag the arrow tip = rotate (Shift snaps 15 deg), Delete = remove.'}));
  mui.box=h('div',{id:'mkbox'});d.append(mui.box);
  const row=(label,...kids)=>{const r=h('div',{className:'row'},h('label',{textContent:label}),...kids);mui.box.append(r);return r;};
  const edit=fn=>()=>{const m=markers[selMarker];if(!m)return;const b=snapM();fn(m);commitMarkers(b);};
  mui.name=h('input',{type:'text',placeholder:'optional unique name'});mui.name.style.flex='1';
  mui.name.onchange=edit(m=>{m.name=mui.name.value.trim();if(m.name&&dupNames()[m.name]>1)toast('Warning: another marker is already named "'+m.name+'" (not renamed)');});
  row('Name',mui.name);
  mui.dup=h('div',{className:'small',style:'color:#ff8a80'});mui.box.append(mui.dup);
  mui.chips=h('div',{className:'chips'});mui.box.append(mui.chips);
  mui.tagIn=h('input',{type:'text',placeholder:'add tag, Enter or comma'});mui.tagIn.style.flex='1';
  const addTags=()=>{const v=mui.tagIn.value;mui.tagIn.value='';const ts=v.split(',').map(slug).filter(Boolean);if(!ts.length)return;edit(m=>{for(const t of ts)if(!m.tags.includes(t))m.tags.push(t);})();};
  mui.tagIn.onkeydown=e=>{if(e.key==='Enter'||e.key===','){e.preventDefault();addTags();}};mui.tagIn.onchange=addTags;
  row('Tags',mui.tagIn);
  mui.quick=h('div',{className:'chips'});
  for(const t of QUICK_TAGS)mui.quick.append(h('button',{className:'chip',textContent:t,onclick:edit(m=>{const i=m.tags.indexOf(t);i<0?m.tags.push(t):m.tags.splice(i,1);})}));
  mui.box.append(mui.quick);
  mui.colors=h('div',{className:'mkcolors'});
  for(const c of MARKER_COLORS){const s=h('div',{title:c});s.style.background=c;s.onclick=edit(m=>{m.color=c;});mui.colors.append(s);}
  mui.colorPick=h('input',{type:'color'});mui.colorPick.onchange=edit(m=>{m.color=mui.colorPick.value;});
  mui.colors.append(mui.colorPick);mui.box.append(mui.colors);
  const num=(k,label,min,max,step)=>{const i=h('input',{type:'number',min,max,step});i.onchange=edit(m=>{const v=+i.value;m[k]=Number.isFinite(v)?clamp(v,min,max):0;if(k==='yaw')m.yaw=((m.yaw%360)+360)%360;});mui[k]=i;row(label,i);};
  num('yaw','Yaw (deg)',-360,360,1);num('radius','Radius (m)',0,5000,1);num('yOffset','Y offset (m)',-1000,1000,0.1);
  mui.props=h('textarea',{rows:3,placeholder:'key=value (one per line)'});mui.props.style.cssText='width:100%;background:var(--panel2);color:var(--fg);border:1px solid var(--line);border-radius:3px;font:11px Consolas,monospace';
  mui.props.onchange=edit(m=>{const p={};for(const ln of mui.props.value.split('\n')){const k=ln.indexOf('=');if(k<1)continue;const key=ln.slice(0,k).trim(),v=ln.slice(k+1).trim();if(key)p[key]=v;}m.props=p;});
  mui.box.append(h('div',{className:'small',textContent:'Props (key=value per line)'}),mui.props);
  mui.box.append(h('div',{className:'row'},h('button',{textContent:'Centre view',onclick:()=>{if(markers[selMarker])centerOnMarker(markers[selMarker]);}}),h('button',{textContent:'Delete marker',onclick:deleteMarker})));
}
function refreshMarkerUI(light){
  if(!mui.list)return;
  const m=markers[selMarker],dups=dupNames();
  mui.box.style.display=m?'':'none';
  if(m){
    const act=document.activeElement;
    if(act!==mui.name)mui.name.value=m.name;
    mui.dup.textContent=m.name&&dups[m.name]>1?'Duplicate name: '+dups[m.name]+' markers use "'+m.name+'"':'';
    if(!light){
      mui.chips.textContent='';
      for(const t of m.tags){const c=h('span',{className:'chip on',textContent:t+' x',title:'remove tag'});c.onclick=()=>{const b=snapM();m.tags.splice(m.tags.indexOf(t),1);commitMarkers(b);};mui.chips.append(c);}
      [...mui.quick.children].forEach(b=>b.classList.toggle('on',m.tags.includes(b.textContent)));
      [...mui.colors.children].forEach(s=>{if(s.tagName==='DIV')s.classList.toggle('on',s.title===m.color);});
      mui.colorPick.value=m.color;
    }
    for(const k of ['yaw','radius','yOffset'])if(act!==mui[k])mui[k].value=m[k];
    if(act!==mui.props)mui.props.value=Object.entries(m.props).map(([k,v])=>k+'='+v).join('\n');
  }
  mui.list.textContent='';
  markers.forEach((mk,i)=>{
    if(mFilter&&!((mk.name||'').toLowerCase().includes(mFilter)||mk.tags.some(t=>t.includes(mFilter))))return;
    const dot=h('span',{className:'dot'});dot.style.background=mk.color;
    const row=h('div',{className:i===selMarker?'on':''},dot,h('b',{textContent:(dups[mk.name]>1?'! ':'')+(mk.name||'#'+mk.id)}),h('span',{className:'small',textContent:' '+mk.tags.join(' ')}));
    row.onclick=()=>{selMarker=i;markersVer++;centerOnMarker(mk);refreshMarkerUI();};
    mui.list.append(row);
  });
}

// =====================================================================================
// SECTION 8: auto-paint
// =====================================================================================
function autoPaint(){
  endStroke(); beginStroke('c');
  const sc=S.maxH/(S.world/N)*0.5, thr=Math.tan(opts.slope*Math.PI/180); let cnt=0;
  for(let ty=0;ty<N/TS;ty++)for(let tx=0;tx<N/TS;tx++){
    let touched=false;
    for(let y=ty*TS;y<ty*TS+TS;y++)for(let x=tx*TS;x<tx*TS+TS;x++){
      const i=y*N+x; if(WC[0][i]!==255)continue;
      const h=H[i]; let c=-1;
      if(h<S.sea+opts.sand)c=3;
      else{
        const dx=(H[i+(x<N-1?1:0)]-H[i-(x>0?1:0)])*sc, dz=(H[y<N-1?i+N:i]-H[y>0?i-N:i])*sc;
        if(Math.hypot(dx,dz)>thr)c=4; else if(h>opts.snow)c=5;
      }
      if(c<0)continue;
      if(!touched){touch(x,y,x,y);touched=true;}
      WC[0][i]=0;WC[c][i]=255;cnt++;
    }
  }
  endStroke(); edited(0,0,N,N); toast('Auto-paint changed '+cnt+' pixels');
}

// =====================================================================================
// SECTION 9: PNG encoder (pure; tested separately in node)
// =====================================================================================
// ==PNG-BEGIN==
const CRC_T=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(u8){let c=0xFFFFFFFF;for(let i=0;i<u8.length;i++)c=CRC_T[(c^u8[i])&255]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function pngChunk(type,data){
  const o=new Uint8Array(12+data.length),dv=new DataView(o.buffer);
  dv.setUint32(0,data.length);for(let i=0;i<4;i++)o[4+i]=type.charCodeAt(i);o.set(data,8);
  dv.setUint32(8+data.length,crc32(o.subarray(4,8+data.length)));return o;
}
async function zlibDeflate(u8){                 // 'deflate' = zlib-wrapped (RFC1950) stream
  const cs=new CompressionStream('deflate'),w=cs.writable.getWriter();
  w.write(u8).catch(()=>{});w.close().catch(()=>{});
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
// raw = unfiltered scanlines (big-endian for 16-bit). colorType 0 gray, 2 RGB, 6 RGBA. Uses PNG filter 1 (Sub).
async function encodePNG(w,h,bitDepth,colorType,raw){
  const ch={0:1,2:3,6:4}[colorType],bpp=ch*bitDepth/8,rowB=w*bpp;
  if(raw.length!==rowB*h)throw new Error('encodePNG: bad raw length');
  const f=new Uint8Array((rowB+1)*h);
  for(let y=0;y<h;y++){const s=y*rowB,d=y*(rowB+1);f[d]=1;
    for(let i=0;i<rowB;i++)f[d+1+i]=(raw[s+i]-(i>=bpp?raw[s+i-bpp]:0))&255;}
  const idat=await zlibDeflate(f);
  const ihdr=new Uint8Array(13),dv=new DataView(ihdr.buffer);
  dv.setUint32(0,w);dv.setUint32(4,h);ihdr[8]=bitDepth;ihdr[9]=colorType;
  const parts=[new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),pngChunk('IDAT',idat),pngChunk('IEND',new Uint8Array(0))];
  const out=new Uint8Array(parts.reduce((a,p)=>a+p.length,0));let o=0;for(const p of parts){out.set(p,o);o+=p.length;}
  return out;
}
function gray16Raw(v,n){const o=new Uint8Array(n*n*2);for(let i=0;i<v.length;i++){o[2*i]=v[i]>>8;o[2*i+1]=v[i]&255;}return o;}
// ==PNG-END==

// =====================================================================================
// SECTION 10: export
// =====================================================================================
// Export conversion (shared by buildExport and the 3D preview, so the preview sees exactly the exported values; only PNG encode/decode is skipped).
function newExportBuffers(biome){const n=N*N;return {h16:new Uint16Array(n),w16:new Uint16Array(n),s0:new Uint8Array(n*4),s1:new Uint8Array(n*4),bc:biome?new Uint8Array(n*3):null};}
function fillExportRegion(b,x0,y0,x1,y1){          // pixel rect, x1/y1 exclusive
  for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
    const i=y*N+x;
    b.h16[i]=Math.round(clamp(H[i],0,1)*65535);
    const l=WL[i];b.w16[i]=(l>=0&&l>H[i])?1+Math.round(clamp(l,0,1)*65534):0;
    let bi=0,bv=-1;
    for(let c=0;c<8;c++){const v=WC[c][i];(c<4?b.s0:b.s1)[i*4+(c&3)]=v;if(v>bv){bv=v;bi=c;}}
    if(b.bc){b.bc[i*3]=CR[bi];b.bc[i*3+1]=CG[bi];b.bc[i*3+2]=CB[bi];}
  }
}
const META_NOTE=' Optional per-point metadata, written only when not default: type (country|city|highway), oneway, edgeL/edgeR (none|fence|guardrail|barrier|lamps; left/right looking forward along the point order), surface (smooth|worn|potholes|gravel), signs (auto|off) apply from this point to the next; features[] (crosswalk|bump|rumble|roadworks) apply at the point.';
const ROADS_NOTE='nx,nz normalized 0..1 edge-to-edge; x,z world metres (x=nx*worldSize, z=nz*worldSize); y terrain height metres. bridge=true: segment to the NEXT point is a bridge. Curve: uniform Catmull-Rom through points.';
function roadsJson(){
  let meta=false;
  const out={formatVersion:1,note:ROADS_NOTE,
    roads:roads.map(r=>({id:r.id,widthMeters:r.width,points:r.points.map(p=>{
      const o={nx:p.x,nz:p.z,x:p.x*S.world,y:heightAt(p.x*N,p.z*N)*S.maxH,z:p.z*S.world,bridge:!!p.bridge};
      for(const k of NODE_KEYS){const v=getA(p,k);if(k==='features'?v.length:v!==NODE_DEFAULTS[k]){o[k]=k==='features'?FEATURES.filter(f=>v.includes(f)):v;meta=true;}}
      return o;})}))};
  if(meta)out.note=ROADS_NOTE+META_NOTE;   // old maps: note and file stay byte-identical
  return out;
}
const MARKERS_NOTE='Pins placed in the editor. x,z,y world metres (same convention as roads.json; y = terrain height at export + yOffset); nx,nz normalized 0..1; yaw degrees, 0 = +X (east), +90 = +Z (south): forward = (cos yaw, sin yaw) in (x,z); radius metres (0 = point marker). tags are lowercase slugs [a-z0-9_-]; name is optional but unique when set. The loader recomputes y from its own ground.';
function markersJson(){
  return {version:1,note:MARKERS_NOTE,markers:markers.map(m=>({id:m.id,name:m.name,tags:m.tags.slice(),color:m.color,x:m.x*S.world,y:heightAt(m.x*N,m.z*N)*S.maxH+m.yOffset,z:m.z*S.world,
    yaw:m.yaw,radius:m.radius,props:{...m.props},yOffset:m.yOffset,nx:m.x,nz:m.z}))};
}
const FILE_NAMES={height16:'heightmap16.png',heightRaw16:'heightmap.r16',splat0:'splat0.png',splat1:'splat1.png',biomeColor:'biome_color.png',water:'water.png',roads:'roads.json',markers:'markers.json'};
function mapJson(){
  const mm={};if(S.driveSide!==MAP_DEFAULTS.driveSide)mm.driveSide=S.driveSide;if(S.signStyle!==MAP_DEFAULTS.signStyle)mm.signStyle=S.signStyle;   // only when not default
  return {formatVersion:1,N,worldSizeMeters:S.world,maxHeightMeters:S.maxH,cellSizeMeters:S.world/N,seaLevel:S.sea,seaLevelMeters:S.sea*S.maxH,...mm,
    classes:CLASSES,
    files:FILE_NAMES,
    encodings:{
      height:'uint16 0..65535 -> normalized v/65535 -> metres v/65535*maxHeightMeters. PNG is big-endian (PNG spec), .r16 is little-endian.',
      splat0:'RGBA8 = weights of classes 0,1,2,3; splat1: classes 4,5,6,7. Straight alpha (not premultiplied). Sum of 8 weights = 255 per pixel.',
      water:'uint16 PNG. 0 = no lake/river water; v>=1 -> surface normalized (v-1)/65534, metres (v-1)/65534*maxHeightMeters. Ocean is NOT included: ocean = terrain height < seaLevel.'},
    coordinates:{origin:'top-left corner of image = world (0,0)',xAxis:'+X = increasing pixel column (right)',zAxis:'+Z = increasing pixel row (down the image)',yAxis:'+Y up; metres = normalized height*maxHeightMeters',
      pixelToWorld:'pixel (i,j) centre -> x=(i+0.5)*cellSizeMeters, z=(j+0.5)*cellSizeMeters; normalized u=x/worldSizeMeters'}};
}
async function buildExport(){
  endStroke();
  const files=[], b=newExportBuffers(true);
  fillExportRegion(b,0,0,N,N);
  files.push({name:'heightmap16.png',data:await encodePNG(N,N,16,0,gray16Raw(b.h16,N))});
  files.push({name:'heightmap.r16',data:new Uint8Array(new Uint16Array(b.h16).buffer)});   // little-endian hosts only (all desktop browsers)
  files.push({name:'splat0.png',data:await encodePNG(N,N,8,6,b.s0)});
  files.push({name:'splat1.png',data:await encodePNG(N,N,8,6,b.s1)});
  files.push({name:'biome_color.png',data:await encodePNG(N,N,8,2,b.bc)});
  files.push({name:'water.png',data:await encodePNG(N,N,16,0,gray16Raw(b.w16,N))});
  files.push({name:'roads.json',data:JSON.stringify(roadsJson(),null,1)});
  files.push({name:'markers.json',data:JSON.stringify(markersJson(),null,1)});
  files.push({name:'map.json',data:JSON.stringify(mapJson(),null,1)});
  files.push({name:'map.tmap',data:serialize()});
  return files;
}
async function doExport(){
  let dir=null;
  if(window.showDirectoryPicker){
    try{dir=await showDirectoryPicker({mode:'readwrite'});}
    catch(e){if(e&&e.name==='AbortError')return;console.warn('directory picker failed, falling back to downloads',e);}
  }
  endStroke(); toast('Exporting...');
  try{
    const files=await buildExport();
    for(const f of files){
      if(dir){const fh=await dir.getFileHandle(f.name,{create:true}),w=await fh.createWritable();await w.write(f.data);await w.close();}
      else{download(f.name,f.data);await new Promise(r=>setTimeout(r,350));}
    }
    toast('Exported '+files.length+' files'+(dir?' to '+dir.name:' (downloads)'));
  }catch(e){console.error(e);toast('Export failed: '+e.message);}
}
function download(name,data){
  const a=document.createElement('a'),u=URL.createObjectURL(new Blob([data]));a.href=u;a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),5000);
}

// =====================================================================================
// SECTION 11: project save / load / autosave
// =====================================================================================
function serialize(){
  const layers=[],parts=[];let off=0;
  const add=(name,type,arr)=>{layers.push({name,type,offset:off,byteLength:arr.byteLength});parts.push(arr);off+=arr.byteLength;};
  add('height','f32',H);add('water','f32',WL);WC.forEach((a,c)=>add('weight'+c,'u8',a));
  const header={format:'tmap',version:1,N,settings:{worldSizeMeters:S.world,maxHeightMeters:S.maxH,seaLevel:S.sea,...(S.driveSide!==MAP_DEFAULTS.driveSide?{driveSide:S.driveSide}:{}),...(S.signStyle!==MAP_DEFAULTS.signStyle?{signStyle:S.signStyle}:{})},roads,nextRoadId,markers,nextMarkerId,layers};
  let hb=new TextEncoder().encode(JSON.stringify(header));
  const hl=(hb.length+3)&~3, out=new Uint8Array(8+hl+off);
  out.set([84,77,65,80],0);new DataView(out.buffer).setUint32(4,hl,true);out.fill(32,8,8+hl);out.set(hb,8);
  for(let i=0;i<layers.length;i++)out.set(new Uint8Array(parts[i].buffer,parts[i].byteOffset,parts[i].byteLength),8+hl+layers[i].offset);
  return out;
}
function loadProject(buf){
  const u8=new Uint8Array(buf);
  if(String.fromCharCode(...u8.subarray(0,4))!=='TMAP')throw new Error('Not a .tmap file');
  const hl=new DataView(buf).getUint32(4,true), hd=JSON.parse(new TextDecoder().decode(u8.subarray(8,8+hl)));
  if(![512,1024,2048].includes(hd.N))throw new Error('Unsupported size '+hd.N);
  allocate(hd.N);
  S.world=hd.settings.worldSizeMeters;S.maxH=hd.settings.maxHeightMeters;S.sea=hd.settings.seaLevel;
  S.driveSide=DRIVE_SIDES.includes(hd.settings.driveSide)?hd.settings.driveSide:MAP_DEFAULTS.driveSide;S.signStyle=SIGN_STYLES.includes(hd.settings.signStyle)?hd.settings.signStyle:MAP_DEFAULTS.signStyle;
  const base=8+hl, L={};hd.layers.forEach(l=>L[l.name]=l);
  const f32=l=>new Float32Array(buf.slice(base+l.offset,base+l.offset+l.byteLength));
  H=f32(L.height);WL=f32(L.water);
  for(let c=0;c<8;c++){const l=L['weight'+c];WC[c]=new Uint8Array(buf.slice(base+l.offset,base+l.offset+l.byteLength));}
  roads=hd.roads||[];nextRoadId=hd.nextRoadId||(roads.reduce((a,r)=>Math.max(a,r.id),0)+1);
  markers=hd.markers||[];nextMarkerId=hd.nextMarkerId||(markers.reduce((a,m)=>Math.max(a,m.id),0)+1);
  afterMapReplaced();
}
function afterMapReplaced(){
  syncMapUI();fitView();fullRender();refreshRoadUI();refreshMarkerUI();modified=false;
  if(pv)pv.invalidateAll();
}
function newMap(n,world,maxH,sea,base){
  allocate(n);S.world=world;S.maxH=maxH;S.sea=sea;S.driveSide=MAP_DEFAULTS.driveSide;S.signStyle=MAP_DEFAULTS.signStyle;H.fill(base);afterMapReplaced();
}
async function saveProject(){
  endStroke();const data=serialize();
  if(window.showSaveFilePicker){
    try{const fh=await showSaveFilePicker({suggestedName:'map.tmap',types:[{description:'Terrain map',accept:{'application/octet-stream':['.tmap']}}]});
      const w=await fh.createWritable();await w.write(data);await w.close();toast('Saved');return;}
    catch(e){if(e&&e.name==='AbortError')return;}
  }
  download('map.tmap',data);toast('Saved (download)');
}
// IndexedDB autosave
function idb(){return new Promise((res,rej)=>{const r=indexedDB.open('terrain-editor',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
async function idbPut(k,v){const db=await idb();return new Promise((res,rej)=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);});}
async function idbGet(k){const db=await idb();return new Promise((res,rej)=>{const r=db.transaction('kv').objectStore('kv').get(k);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});}
let autosaveBusy=false;
async function autosaveTick(){
  if(!modified||active||stroke||autosaveBusy)return;
  autosaveBusy=true;
  try{const d=serialize();await idbPut('autosave',{ts:Date.now(),buf:d.buffer});modified=false;lastSaveTs=Date.now();$('saveInfo').textContent='autosaved '+new Date(lastSaveTs).toLocaleTimeString();}
  catch(e){console.warn('autosave failed',e);}
  autosaveBusy=false;
}
setInterval(autosaveTick,10000);

// =====================================================================================
// SECTION 12: UI construction
// =====================================================================================
function h(tag,props,...kids){const e=document.createElement(tag);Object.assign(e,props||{});kids.flat().forEach(k=>e.append(k));return e;}
const ctl={};
function section(parent,title,forTools){
  const d=h('div'); if(forTools)d.dataset.for=forTools;
  d.append(h('h4',{textContent:title}));parent.append(d);return d;
}
function slider(parent,key,label,min,max,step,val,cb,fmt){
  const inp=h('input',{type:'range',min,max,step,value:val}),v=h('span',{className:'v'});
  const show=x=>v.textContent=fmt?fmt(+x):(+x);
  inp.oninput=()=>{show(inp.value);cb(+inp.value);}; show(val);
  parent.append(h('div',{className:'row'},h('label',{textContent:label}),inp,v));
  ctl[key]={set(x){inp.value=x;show(inp.value);}};return inp;
}
function checkbox(parent,label,val,cb){
  const c=h('input',{type:'checkbox',checked:val});c.onchange=()=>cb(c.checked);
  parent.append(h('div',{className:'row'},h('label',{textContent:label}),c));return c;
}
const TOOLS=[['raise','Raise','R'],['lower','Lower','L'],['smooth','Smooth','S'],['flatten','Flatten','F'],['mountain','Mountain','M'],['hills','Hills','H'],
  ['water','Water','W'],['erasewater','Erase water','E'],['paint','Paint','P'],['road','Road','T'],['marker','Marker','K'],['pan','Pan','V']];
function setTool(t){
  if(tool==='road'&&t!=='road'){drawing=false;}
  finishStroke();tool=t;
  document.querySelectorAll('#left button').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  document.querySelectorAll('#right [data-for]').forEach(s=>s.style.display=s.dataset.for.split(' ').includes(t)?'':'none');
  cv.style.cursor=t==='pan'?'grab':(t==='road'||t==='marker')?'default':'none'; needDraw=true; pvBrush();
}
function buildUI(){
  const left=$('left');
  TOOLS.forEach(([id,name,key])=>{const b=h('button',{onclick:()=>setTool(id)},name,h('kbd',{textContent:key}));b.dataset.t=id;left.append(b);});

  const R=$('right');
  const sb=section(R,'Brush');
  slider(sb,'radius','Radius (px)',2,500,1,brush.radius,v=>{brush.radius=v;pvBrush();});
  slider(sb,'strength','Strength',0.02,1,0.01,brush.strength,v=>brush.strength=v,v=>v.toFixed(2));
  slider(sb,'hardness','Hardness',0,1,0.01,brush.hardness,v=>brush.hardness=v,v=>v.toFixed(2));
  const sh=h('select');['smooth','linear','sharp'].forEach((n,i)=>sh.append(h('option',{value:i,textContent:n})));
  sh.onchange=()=>brush.shape=+sh.value;
  sb.append(h('div',{className:'row'},h('label',{textContent:'Falloff shape'}),sh));
  sb.append(h('div',{className:'small',textContent:'Hardness 1 = cliffs/plateaus, 0 = soft hills.'}));

  const fl=section(R,'Flatten','flatten');
  checkbox(fl,'Typed target',opts.flatTyped,v=>opts.flatTyped=v);
  const ft=h('input',{type:'number',value:opts.flatMeters,min:0,step:1});ft.oninput=()=>opts.flatMeters=+ft.value||0;
  fl.append(h('div',{className:'row'},h('label',{textContent:'Target (m)'}),ft));
  fl.append(h('div',{className:'small',textContent:'Otherwise: Alt+click picked height, else height at stroke start.'}));
  fl.append(h('div',{className:'row'},h('span',{id:'flatInfo',className:'small',textContent:'Picked: none'}),h('button',{textContent:'Clear pick',onclick:()=>{opts.flatPicked=null;$('flatInfo').textContent='Picked: none';}})));
  const mt=section(R,'Mountain','mountain');
  slider(mt,'mtScale','Scale (px)',20,500,5,opts.mtScale,v=>opts.mtScale=v);
  slider(mt,'mtSharp','Ridge sharp',0.5,5,0.1,opts.mtSharp,v=>opts.mtSharp=v,v=>v.toFixed(1));
  slider(mt,'mtAmp','Amplitude',0.1,4,0.1,opts.mtAmp,v=>opts.mtAmp=v,v=>v.toFixed(1));
  const hl=section(R,'Hills','hills');
  slider(hl,'hlScale','Scale (px)',30,800,5,opts.hlScale,v=>opts.hlScale=v);
  slider(hl,'hlAmp','Amplitude',0.1,4,0.1,opts.hlAmp,v=>opts.hlAmp=v,v=>v.toFixed(1));
  const wt=section(R,'Water','water');
  slider(wt,'wDepth','Bed depth (m)',0.5,60,0.5,opts.waterDepth,v=>opts.waterDepth=v,v=>v.toFixed(1));
  wt.append(h('div',{className:'small',textContent:'Level = terrain height at stroke start. Ocean: Sea level slider below.'}));

  const pt=section(R,'Surface','paint');
  const sw=h('div',{className:'sw'});
  CLASSES.forEach(c=>{const d=h('div',{textContent:c.name});d.style.background=c.color;if(c.id===opts.cls)d.classList.add('on');
    d.onclick=()=>{opts.cls=c.id;[...sw.children].forEach((x,i)=>x.classList.toggle('on',i===c.id));};sw.append(d);});
  pt.append(sw);
  pt.append(h('div',{className:'small',textContent:'Strength = density. Hardness = blend softness.'}));
  const ap=section(R,'Auto-paint (only pure grass)','paint');
  slider(ap,'apSlope','Rock slope (deg)',5,80,1,opts.slope,v=>opts.slope=v);
  slider(ap,'apSnow','Snow height',0,1,0.01,opts.snow,v=>opts.snow=v,v=>v.toFixed(2));
  slider(ap,'apSand','Sand band',0,0.15,0.005,opts.sand,v=>opts.sand=v,v=>v.toFixed(3));
  ap.append(h('button',{textContent:'Auto-paint now',onclick:autoPaint}));

  const rd=section(R,'Roads','road');
  rd.append(h('div',{id:'roadlist'}));
  const rb=h('div',{className:'row'});
  rb.append(h('button',{textContent:'New',onclick:()=>{finishRoad();selRoad=-1;selPt=-1;refreshRoadUI();needDraw=true;toast('Click the map to start a new road');}}),
    h('button',{textContent:'Continue',onclick:()=>{if(selRoad>=0){drawing=true;toast('Click to append points; Enter to finish');}}}),
    h('button',{textContent:'Finish',onclick:finishRoad}),
    h('button',{textContent:'Del road',onclick:()=>{if(selRoad<0)return;const b=snap();roads.splice(selRoad,1);selRoad=-1;selPt=-1;drawing=false;commitRoads(b);needDraw=true;}}));
  rd.append(rb);
  const wi=h('input',{type:'number',id:'rdWidth',min:1,max:100,step:1,value:8});
  wi.onchange=()=>{if(selRoad<0)return;const b=snap();roads[selRoad].width=clamp(+wi.value||8,1,100);commitRoads(b);needDraw=true;};
  rd.append(h('div',{className:'row'},h('label',{textContent:'Width (m)'}),wi));
  const bi=h('input',{type:'checkbox',id:'ptBridge'});
  bi.onchange=()=>editSel(p=>{p.bridge=bi.checked;});
  rd.append(h('div',{className:'row'},h('label',{textContent:'Pt bridge'}),bi,h('span',{className:'small',textContent:'segment to next pt'})));
  buildNodeUI(rd);
  slider(rd,'shoulder','Shoulder (m)',0,60,1,opts.shoulder,v=>opts.shoulder=v);
  slider(rd,'smoothM','Profile smooth (m)',0,200,5,opts.smoothM,v=>opts.smoothM=v);
  rd.append(h('button',{textContent:'Bake roads into terrain',onclick:bakeRoads}));

  const mk=section(R,'Markers');
  buildMarkerUI(mk);
  const p3=section(R,'3D preview');
  slider(p3,'pvExag','Vertical exaggeration',0.5,6,0.1,1,v=>{if(pv)pv.setExaggeration(v);},v=>v.toFixed(1)+'x');
  p3.append(h('div',{className:'small',textContent:'1.0x = true scale (same as the game).'}));
  checkbox(p3,'Water',true,v=>{if(pv)pv.setToggle('water',v);});
  checkbox(p3,'Roads',true,v=>{if(pv)pv.setToggle('roads',v);});
  checkbox(p3,'Road edges (fence, rails, lamps...)',true,v=>{if(pv)pv.setToggle('edges',v);});
  checkbox(p3,'Warning signs',true,v=>{if(pv)pv.setToggle('signs',v);});
  checkbox(p3,'Wireframe',false,v=>{if(pv)pv.setToggle('wire',v);});
  p3.append(h('div',{className:'small',textContent:'Paint in the 2D view; the 3D view is orbit-only (drag = orbit, right-drag = pan, wheel = zoom).'}));
  const vw=section(R,'View');
  const ms=h('select');[['both','Height + biome'],['height','Shaded height'],['biome','Biome colours']].forEach(([v,t])=>ms.append(h('option',{value:v,textContent:t})));
  ms.onchange=()=>{view.mode=ms.value;fullRender();};
  vw.append(h('div',{className:'row'},h('label',{textContent:'Mode'}),ms));
  checkbox(vw,'Water',view.water,v=>{view.water=v;fullRender();});
  checkbox(vw,'Roads',view.roads,v=>{view.roads=v;needDraw=true;});
  ctl.gridCb=checkbox(vw,'Grid',view.grid,v=>{view.grid=v;needDraw=true;});
  slider(vw,'biomeOp','Biome opacity',0,1,0.01,view.biomeOp,v=>{view.biomeOp=v;fullRender();},v=>v.toFixed(2));
  slider(vw,'waterOp','Water opacity',0,1,0.01,view.waterOp,v=>{view.waterOp=v;fullRender();},v=>v.toFixed(2));
  slider(vw,'sea','Sea level',0,1,0.005,S.sea,v=>{S.sea=v;fullRender();metaChanged();},v=>v.toFixed(3));

  const mp=section(R,'Map');
  const ws=h('input',{type:'number',id:'mWorld',min:100,step:100}),mh=h('input',{type:'number',id:'mMax',min:10,step:10});
  ws.onchange=()=>{S.world=Math.max(100,+ws.value||2000);fullRender();setModified();metaChanged();};
  mh.onchange=()=>{S.maxH=Math.max(10,+mh.value||200);fullRender();setModified();metaChanged();};
  mp.append(h('div',{className:'row'},h('label',{textContent:'World size (m)'}),ws),h('div',{className:'row'},h('label',{textContent:'Max height (m)'}),mh),
    h('div',{id:'mInfo',className:'small'}));
  const sel=(id,list,key,label)=>{const s=h('select',{id});list.forEach(v=>s.append(h('option',{value:v,textContent:v})));s.onchange=()=>{S[key]=s.value;setModified();metaChanged();};mp.append(h('div',{className:'row'},h('label',{textContent:label}),s));};
  sel('mDrive',DRIVE_SIDES,'driveSide','Drive side');sel('mSigns',SIGN_STYLES,'signStyle','Sign style');
  mp.append(h('div',{className:'small',textContent:'Drive side: warning signs stand on the driver\'s edge. Sign style: us = yellow diamonds, eu = red-bordered triangles.'}));
  setTool('raise');
}
function syncMapUI(){
  $('mWorld').value=S.world;$('mMax').value=S.maxH;ctl.sea.set(S.sea);
  $('mInfo').textContent=N+' x '+N+' px, '+(S.world/N).toFixed(2)+' m/px';
  $('mDrive').value=S.driveSide;$('mSigns').value=S.signStyle;
}
function refreshRoadUI(){
  const l=$('roadlist'); if(!l)return; l.textContent='';
  roads.forEach((r,i)=>{const sm=roadSummary(r),d=h('div',{textContent:'Road #'+r.id+'  ('+r.points.length+' pts, '+r.width+' m)'+(sm?'  '+sm:''),title:sm||'plain country road'});
    if(i===selRoad)d.className='on';d.onclick=()=>{drawing=false;selRoad=i;selPt=-1;refreshRoadUI();needDraw=true;};l.append(d);});
  const r=roads[selRoad]; $('rdWidth').value=r?r.width:8;
  const p=r&&r.points[selPt]; $('ptBridge').checked=!!(p&&p.bridge); $('ptBridge').disabled=!p;
  refreshNodeUI();
}
// ---- "Road node" inspector: edits every selected point (shift-click = range from the anchor, ctrl-click = toggle) ----
const nui={};
function buildNodeUI(parent){
  const box=h('div',{id:'nodebox'});parent.append(box);nui.box=box;
  box.append(h('div',{className:'small',style:'margin-top:8px;font-weight:600',textContent:'ROAD NODE'}),nui.info=h('div',{className:'small'}));
  const selectRow=(k,label,list)=>{
    const s=h('select');s.append(h('option',{value:'',textContent:'(mixed)',hidden:true}));list.forEach(v=>s.append(h('option',{value:v,textContent:v})));
    s.onchange=()=>{if(s.value!=='')editSel(p=>setA(p,k,s.value));};nui[k]=s;box.append(h('div',{className:'row'},h('label',{textContent:label}),s));};
  selectRow('type','Type',ROAD_TYPES);
  const ow=h('input',{type:'checkbox'});ow.onchange=()=>editSel(p=>setA(p,'oneway',ow.checked));nui.oneway=ow;
  box.append(h('div',{className:'row'},h('label',{textContent:'One-way'}),ow,h('span',{className:'small',textContent:'direction = point order'})));
  selectRow('edgeL','Left edge',EDGE_TYPES);selectRow('edgeR','Right edge',EDGE_TYPES);selectRow('surface','Surface',SURFACES);selectRow('signs','Warn signs',SIGN_MODES);
  nui.feat={};box.append(h('div',{className:'small',textContent:'Features at this node'}));
  const fr=h('div',{className:'chips'});box.append(fr);
  for(const f of FEATURES){const c=h('input',{type:'checkbox'});c.onchange=()=>editSel(p=>{const s=new Set(getA(p,'features'));c.checked?s.add(f):s.delete(f);setA(p,'features',[...s]);});
    nui.feat[f]=c;fr.append(h('label',{className:'small',title:FEAT_UI[f][2],style:'display:flex;gap:3px;align-items:center;margin-right:8px'},c,f==='bump'?'speed bump':f));}
  box.append(h('div',{className:'row'},h('button',{textContent:'Apply to whole road',title:'copy the primary point\'s type, one-way, edges, surface and signs to every point',onclick:()=>applySegAttrs(0)}),
    h('button',{textContent:'From here to end',onclick:()=>applySegAttrs(selPt)})));
  box.append(h('div',{className:'small',textContent:'Left/right = looking forward along the point order. Type/one-way/edges/surface/signs apply from this point to the NEXT one (the last point\'s are ignored); features apply at the point. Shift-click = select range, Ctrl-click = toggle.'}),
    h('div',{className:'row'},h('button',{textContent:'Auto-set type from city paint',title:'Selected road: segments whose midpoint is on city-class paint (>50%) become type city; the others stay unchanged. One undo step.',onclick:autoTypeFromCityPaint})),
    h('div',{className:'small',textContent:'City = kerbs + footpaths + signals at junctions, highway = lanes + median barrier (see the 3D preview). Edge objects on city segments stand outside the footpath.'}));
}
function refreshNodeUI(){
  if(!nui.box)return;
  const idx=syncSel(),rd=roads[selRoad];
  nui.box.style.display=idx.length?'':'none'; if(!idx.length)return;
  const pts=idx.map(i=>rd.points[i]);
  nui.info.textContent=idx.length===1?'Point '+(idx[0]+1)+' of '+rd.points.length+(idx[0]===rd.points.length-1?' (last: segment attributes unused)':''):idx.length+' points selected';
  for(const k of SEG_KEYS){const vs=new Set(pts.map(p=>getA(p,k)));
    if(k==='oneway'){nui.oneway.indeterminate=vs.size>1;nui.oneway.checked=vs.size===1&&[...vs][0]===true;}
    else nui[k].value=vs.size===1?[...vs][0]:'';}
  for(const f of FEATURES){const n=pts.filter(p=>getA(p,'features').includes(f)).length;nui.feat[f].indeterminate=n>0&&n<pts.length;nui.feat[f].checked=n===pts.length;}
}

// =====================================================================================
// SECTION 13: input handling
// =====================================================================================
let spaceDown=false, pan=null;
function evPos(e){const r=cv.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
cv.addEventListener('contextmenu',e=>e.preventDefault());
cv.addEventListener('pointerdown',e=>{
  cv.setPointerCapture(e.pointerId);
  const [sx,sy]=evPos(e),[mx,my]=toMapPt(sx,sy);
  if(e.button===1||(e.button===0&&(spaceDown||tool==='pan'))){pan={sx:e.clientX,sy:e.clientY,ox:view.ox,oy:view.oy};cv.style.cursor='grabbing';e.preventDefault();return;}
  if(e.button!==0)return;
  if(tool==='road'){roadDown(e,mx,my);return;}
  if(tool==='marker'){markerDown(e,sx,sy,mx,my);return;}
  if(e.altKey&&tool==='flatten'){opts.flatPicked=heightAt(mx,my);$('flatInfo').textContent='Picked: '+(opts.flatPicked*S.maxH).toFixed(1)+' m';return;}
  startStroke(e,mx,my);
});
cv.addEventListener('pointermove',e=>{
  const [sx,sy]=evPos(e),[mx,my]=toMapPt(sx,sy); hover={sx,sy,mx,my};needDraw=true;badgeTip(sx,sy);
  if(pan){view.ox=pan.ox+e.clientX-pan.sx;view.oy=pan.oy+e.clientY-pan.sy;}
  else if(mDrag){markerMove(e,mx,my);}
  else if(dragging&&selRoad>=0&&selPt>=0){const p=roads[selRoad].points[selPt];p.x=clamp(mx/N,0,1);p.z=clamp(my/N,0,1);dragging.moved=true;metaChanged();}
  else if(active){
    const evs=e.getCoalescedEvents?e.getCoalescedEvents():[e];
    for(const c of (evs.length?evs:[e])){const [cx,cy]=evPos(c),[a,b]=toMapPt(cx,cy);strokeTo(a,b,pressureOf(c));}
  }
  pvBrush();updateStatus();
});
function endPointer(e){
  if(pan){pan=null;cv.style.cursor=tool==='pan'?'grab':(tool==='road'||tool==='marker')?'default':'none';}
  if(dragging){const d=dragging;dragging=null;if(d.moved)commitRoads(d.before);}
  markerUp();
  finishStroke();
}
cv.addEventListener('pointerup',endPointer);
cv.addEventListener('pointercancel',endPointer);
cv.addEventListener('pointerleave',()=>{hover=null;needDraw=true;pvBrush();});
cv.addEventListener('wheel',e=>{
  e.preventDefault();const [sx,sy]=evPos(e),nz=clamp(view.z*Math.exp(-e.deltaY*0.0015),0.05,40);
  view.ox=sx-(sx-view.ox)*nz/view.z;view.oy=sy-(sy-view.oy)*nz/view.z;view.z=nz;needDraw=true;
},{passive:false});
function updateStatus(){
  const gi=gridInfo?'  |  '+gridInfo:'';
  if(!hover){$('status').textContent='zoom '+Math.round(view.z*100)+'%'+gi;return;}
  const [mx,my]=toMapPt(hover.sx,hover.sy);
  if(mx<0||my<0||mx>=N||my>=N){$('status').textContent='outside map | zoom '+Math.round(view.z*100)+'%'+gi;return;}
  const px=Math.floor(mx),py=Math.floor(my),i=py*N+px;
  let dom=0;for(let c=1;c<8;c++)if(WC[c][i]>WC[dom][i])dom=c;
  $('status').textContent=`px (${px}, ${py})  |  world x ${(mx/N*S.world).toFixed(1)} m, z ${(my/N*S.world).toFixed(1)} m  |  height ${(heightAt(mx,my)*S.maxH).toFixed(1)} m`
    +`${WL[i]>H[i]?'  |  lake '+(WL[i]*S.maxH).toFixed(1)+' m':''}${H[i]<S.sea?'  |  ocean':''}  |  ${CLASSES[dom].name}  |  zoom ${Math.round(view.z*100)}%  |  tool: ${tool}${gi}`;
}
window.addEventListener('keydown',e=>{
  const t=e.target,typing=t.tagName==='SELECT'||t.tagName==='TEXTAREA'||(t.tagName==='INPUT'&&(t.type==='number'||t.type==='text'));
  if(e.key==='F1'||(!typing&&e.key==='?')){e.preventDefault();$('helpDlg').hidden=!$('helpDlg').hidden;return;}
  if(e.key==='Escape'){$('helpDlg').hidden=true;$('newDlg').hidden=true;}
  if(typing)return;
  if(e.ctrlKey||e.metaKey){
    const k=e.key.toLowerCase();
    if(k==='z'){e.preventDefault();e.shiftKey?redo():undo();}
    else if(k==='y'){e.preventDefault();redo();}
    else if(k==='s'){e.preventDefault();saveProject();}
    return;
  }
  if(e.key===' '){e.preventDefault();spaceDown=true;cv.style.cursor='grab';needDraw=true;return;}
  if(e.key==='['){ctl.radius.set(brush.radius=clamp(Math.round(brush.radius*0.85-1),2,500));pvBrush();return;}
  if(e.key===']'){ctl.radius.set(brush.radius=clamp(Math.round(brush.radius*1.15+1),2,500));pvBrush();return;}
  if(e.key==='{'){ctl.hardness.set(brush.hardness=clamp(brush.hardness-0.05,0,1));return;}
  if(e.key==='}'){ctl.hardness.set(brush.hardness=clamp(brush.hardness+0.05,0,1));return;}
  if(tool==='marker'){
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteMarker();return;}
    if(e.key==='Enter'&&hover){const [mx,my]=toMapPt(hover.sx,hover.sy);if(mx>=0&&my>=0&&mx<N&&my<N)addMarker(mx,my);return;}
    if(e.key==='Escape'){selMarker=-1;markersVer++;refreshMarkerUI();return;}
  }
  if(e.key==='Tab'){e.preventDefault();setMode(MODES[(MODES.indexOf(mode)+1)%3]);return;}
  if(tool==='road'){
    if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deletePoint();return;}
    if(e.key==='Enter'){finishRoad();return;}
  }
  const k=e.key.toLowerCase();
  const tt=TOOLS.find(x=>x[2].toLowerCase()===k);
  if(tt&&!e.altKey){setTool(tt[0]);return;}
  if(k==='g'){view.grid=!view.grid;ctl.gridCb.checked=view.grid;needDraw=true;}
});
window.addEventListener('keyup',e=>{if(e.key===' '){spaceDown=false;setTool(tool);}});
document.addEventListener('click',e=>{if(e.target.tagName==='BUTTON')e.target.blur();});

// top bar
$('bNew').onclick=()=>{$('newDlg').hidden=false;};
$('nCancel').onclick=()=>{$('newDlg').hidden=true;};
$('nOk').onclick=()=>{
  if(modified&&!confirm('Discard unsaved changes?'))return;
  $('newDlg').hidden=true;
  newMap(+$('nN').value,Math.max(100,+$('nW').value||2000),Math.max(10,+$('nH').value||200),clamp(+$('nS').value,0,1),clamp(+$('nB').value,0,1));
};
$('bOpen').onclick=()=>$('fileIn').click();
$('fileIn').onchange=async e=>{
  const f=e.target.files[0];e.target.value='';if(!f)return;
  try{loadProject(await f.arrayBuffer());toast('Opened '+f.name);}catch(err){alert('Open failed: '+err.message);}
};
$('bSave').onclick=saveProject;
$('bExport').onclick=doExport;
$('bUndo').onclick=undo;$('bRedo').onclick=redo;
$('bHelp').onclick=()=>$('helpDlg').hidden=false;
$('helpClose').onclick=()=>$('helpDlg').hidden=true;

// =====================================================================================
// SECTION 14: main loop + startup
// =====================================================================================
let airN=0;
function frame(){
  if(active&&!moved&&AIR.has(tool)&&(++airN%4===0)){if(HOLD.has(tool))strokeLvl+=strokeU;stamp(lx,ly,lp);}
  moved=false;
  flushRender();
  if(needDraw){needDraw=false;draw();}
  if(gridDirty())drawGrid();
  if(markersDirty())drawMarkers();
  requestAnimationFrame(frame);
}
new ResizeObserver(()=>{const w=$('wrap');if(!w.clientWidth||!w.clientHeight)return;const first=cv.width<=300&&cv.height<=150;cv.width=gv.width=mv.width=w.clientWidth;cv.height=gv.height=mv.height=w.clientHeight;if(first)fitView();needDraw=true;}).observe($('wrap'));
// ---- Paint / Split / Preview ----
const MODES=['paint','split','preview'];
let mode='paint';
function setMode(m){
  mode=m;$('main').className='mode-'+m;
  document.querySelectorAll('#modeBtns button').forEach(b=>b.classList.toggle('on',b.dataset.m===m));
  if(pv)pv.setVisible(m!=='paint');
  if(m!=='preview')requestAnimationFrame(()=>{const w=$('wrap');cv.width=gv.width=mv.width=w.clientWidth;cv.height=gv.height=mv.height=w.clientHeight;fitView();});
  pvBrush();
}
document.querySelectorAll('#modeBtns button').forEach(b=>b.onclick=()=>setMode(b.dataset.m));
function pvBrush(){
  if(!pv)return;
  if(hover&&isBrushTool(tool)&&!spaceDown){const [mx,my]=toMapPt(hover.sx,hover.sy),cell=S.world/N;
    pv.setBrush(mx<0||my<0||mx>=N||my>=N?null:{x:mx*cell,z:my*cell,r:brush.radius*cell});}
  else pv.setBrush(null);
}
buildUI();
newMap(1024,2000,200,0.1,0.2);
fitView();
pv=createPreview($('pv'),{
  info:mapJson,newBuffers:()=>newExportBuffers(false),fill:(b,r)=>fillExportRegion(b,r.x0,r.y0,r.x1,r.y1),roads:roadsJson,markers:markersJson,onRoadsRebuilt:()=>{needDraw=true;},
});
pv.setMarkersVisible(view.markers);
setMode('paint');
requestAnimationFrame(frame);
(async()=>{
  try{
    const a=await idbGet('autosave');
    if(a&&a.buf&&confirm('Restore autosaved map from '+new Date(a.ts).toLocaleString()+'?')){loadProject(a.buf);toast('Restored autosave');}
  }catch(e){console.warn('autosave restore failed',e);}
})();

// debugging / test hook (not used by the UI)
window.__ed={
  get N(){return N;},get H(){return H;},get WL(){return WL;},get WC(){return WC;},S,view,brush,opts,get markers(){return markers;},get roads(){return roads;},pv:()=>pv,
  setTool,undo,redo,bakeRoads,autoPaint,buildExport,serialize,loadProject,newMap,setMode,mapJson,roadsJson,markersJson,newExportBuffers,fillExportRegion,
  get undoLen(){return undoStack.length;},get redoLen(){return redoStack.length;},toast,selectMarker:i=>{selMarker=i;markersVer++;refreshMarkerUI();},fitView,
  tick:()=>({needDraw,dirty:!!dirty}),
  getA,setA,selectPoints:(ri,list)=>{selRoad=ri;selPt=list[list.length-1];selPts=new Set(list);selAnch=list[0];selOwner=selPt;selOwnerRoad=ri;refreshRoadUI();needDraw=true;},applySegAttrs,editSel,get selected(){return syncSel();},roadSummary,commitRoads,snap,refreshRoadUI,metaChanged,
};
