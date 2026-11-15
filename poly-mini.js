/* 산업 다면체 지도 — 홈 화면 미니 위젯 (industry-polyhedron)
   data/market-polyhedron.json 을 읽어 산업 수만큼 면을 가진 다면체를 그린다.
   드래그하면 돌아가고, 누르면 market-polyhedron.html(전체 화면)로 들어간다. */
(function(){
'use strict';
var cv=document.getElementById('poly-mini');if(!cv)return;
var HREF='market-polyhedron.html',cx=cv.getContext('2d');
var V={add:function(a,b){return[a[0]+b[0],a[1]+b[1],a[2]+b[2]];},sub:function(a,b){return[a[0]-b[0],a[1]-b[1],a[2]-b[2]];},
  mul:function(a,k){return[a[0]*k,a[1]*k,a[2]*k];},dot:function(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];},
  cross:function(a,b){return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];},
  len:function(a){return Math.hypot(a[0],a[1],a[2]);},norm:function(a){var l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];}};
function buildPoly(n,wt){
  /* 면 크기 가변: wt[i](합 1)에 비례하도록 평면 거리 d[i]를 조절한다. 가까운 평면일수록 구를 깊게 깎아 면이 커진다. */
  var N=[],i,j,it,L=function(a){return Math.hypot(a[0],a[1],a[2]);};
  if(!wt||wt.length!==n){wt=[];for(i=0;i<n;i++)wt.push(1/n);}
  var g=Math.PI*(3-Math.sqrt(5)),ord=wt.map(function(w,k){return k;}).sort(function(a,b){return wt[b]-wt[a];});
  for(i=0;i<n;i++){var y=1-2*(i+.5)/n,r=Math.sqrt(1-y*y),t=g*i;N.push([Math.cos(t)*r,y,Math.sin(t)*r]);}
  // 큰 면끼리 한쪽에 몰리지 않게 격자 자리를 띄엄띄엄 배정
  var P=new Array(n);ord.forEach(function(face,k){P[face]=N[(k*7)%n];});
  var used={},ok=true;for(i=0;i<n;i++){var key=P[i].join(',');if(used[key])ok=false;used[key]=1;}
  N=ok?P:N;
  var q=wt.map(function(w){return Math.sqrt(Math.max(w,1e-6)*n);});
  for(it=0;it<90;it++){var f=N.map(function(){return[0,0,0];});
    for(i=0;i<n;i++)for(j=i+1;j<n;j++){var dv=V.sub(N[i],N[j]),l=Math.max(.05,L(dv)),k=.02*q[i]*q[j]/(l*l*l);f[i]=V.add(f[i],V.mul(dv,k));f[j]=V.sub(f[j],V.mul(dv,k));}
    N=N.map(function(p,x){return V.norm(V.add(p,f[x]));});}
  var d=[];for(i=0;i<n;i++)d.push(1);
  function cut(){return N.map(function(nrm,fi){
    var ref=Math.abs(nrm[1])<.9?[0,1,0]:[1,0,0],u=V.norm(V.cross(ref,nrm)),v=V.cross(nrm,u),B=8,o=V.mul(nrm,d[fi]);
    var poly=[[-B,-B],[B,-B],[B,B],[-B,B]].map(function(c){return V.add(o,V.add(V.mul(u,c[0]),V.mul(v,c[1])));});
    N.forEach(function(m,mj){if(mj===fi||!poly.length)return;var out=[];
      for(var k=0;k<poly.length;k++){var A=poly[k],Bp=poly[(k+1)%poly.length],da=V.dot(m,A)-d[mj],db=V.dot(m,Bp)-d[mj];
        if(da<=0)out.push(A);if((da<0&&db>0)||(da>0&&db<0))out.push(V.add(A,V.mul(V.sub(Bp,A),da/(da-db))));}
      poly=out;});
    return poly;});}
  function area(p){if(p.length<3)return 0;var s=[0,0,0];for(var k=1;k<p.length-1;k++)s=V.add(s,V.cross(V.sub(p[k],p[0]),V.sub(p[k+1],p[0])));return L(s)/2;}
  for(it=0;it<70;it++){var ar=cut().map(area),tot=ar.reduce(function(a,b){return a+b;},0)||1;
    for(i=0;i<n;i++){var rr=wt[i]/Math.max(ar[i]/tot,1e-4);d[i]=Math.max(.7,Math.min(1.32,d[i]*Math.pow(rr,-.1)));}}
  var faces=cut().map(function(poly,fi){
    if(poly.length<3){var o=V.mul(N[fi],d[fi]);return{n:N[fi],pts:[o,o,o],c:o,rin:0};}
    var c=V.mul(poly.reduce(function(a,p){return V.add(a,p);},[0,0,0]),1/poly.length),rin=1e9;
    for(var k=0;k<poly.length;k++){var A=poly[k],e=V.norm(V.sub(poly[(k+1)%poly.length],A)),w=V.sub(c,A);rin=Math.min(rin,L(V.sub(w,V.mul(e,V.dot(w,e)))));}
    return{n:N[fi],pts:poly,c:c,rin:rin};});
  var R=Math.max.apply(null,faces.map(function(fc){return Math.max.apply(null,fc.pts.map(L));}));
  faces.forEach(function(fc){fc.pts=fc.pts.map(function(p){return V.mul(p,1/R);});fc.c=V.mul(fc.c,1/R);fc.rin/=R;});
  return faces;
}
function faceWeights(list){
  /* 면 크기 = 종목 수 비중과 시총 비중(제곱근으로 완화)을 반반. 너무 작은 면은 읽을 수 있게 하한을 둔다. */
  var n=list.length,sc=0,sn=0;list.forEach(function(s){sc+=Math.sqrt(s.cap||0);sn+=s.cnt||0;});
  var w=list.map(function(s){return .5*Math.sqrt(s.cap||0)/(sc||1)+.5*(s.cnt||0)/(sn||1);});
  w=w.map(function(x){return Math.max(x,.4/n);});var t=w.reduce(function(a,b){return a+b;},0);
  return w.map(function(x){return x/t;});
}
function qmul(a,b){return[a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];}
function qaxis(ax,ang){var s=Math.sin(ang/2);return[Math.cos(ang/2),ax[0]*s,ax[1]*s,ax[2]*s];}
function qrot(q,p){var u=[q[1],q[2],q[3]],t=V.mul(V.cross(u,p),2);return V.add(V.add(p,V.mul(t,q[0])),V.cross(u,t));}
function color(v){if(v==null||isNaN(v))return'rgb(40,45,60)';var t=Math.max(-1,Math.min(1,v/3)),e=Math.pow(Math.abs(t),.75),a=[58,66,88],b=t>=0?[229,72,77]:[45,110,235];
  return'rgb('+a.map(function(x,i){return Math.round(x+(b[i]-x)*e);}).join(',')+')';}
function pct(v){return v==null?'–':(v>0?'+':'')+v.toFixed(2)+'%';}
var S=[],F=[],q=qmul(qaxis([1,0,0],-.35),qaxis([0,1,0],.5)),W=0,H=0,dpr=1,drag=false,moved=0,last=null,vel=[.006,0],vis=true;
function rot(dx,dy){q=qmul(qmul(qaxis([0,1,0],dx),qaxis([1,0,0],dy)),q);var l=Math.hypot(q[0],q[1],q[2],q[3]);q=q.map(function(x){return x/l;});}
function size(){var r=cv.getBoundingClientRect();W=r.width;H=r.height;dpr=Math.min(2,window.devicePixelRatio||1);cv.width=W*dpr;cv.height=H*dpr;}
function draw(){
  requestAnimationFrame(draw);if(!vis||!F.length)return;
  if(!drag){if(Math.abs(vel[0])+Math.abs(vel[1])>.0065){vel[0]*=.95;vel[1]*=.95;}else vel=[.006,0];rot(vel[0],vel[1]);}
  cx.setTransform(dpr,0,0,dpr,0,0);cx.clearRect(0,0,W,H);
  var R=Math.min(W,H)*.47,ox=W/2,oy=H/2,cam=3.4,list=[];
  var gl=cx.createRadialGradient(ox,oy,R*.5,ox,oy,R*1.08);gl.addColorStop(0,'rgba(90,150,255,.22)');gl.addColorStop(1,'rgba(90,150,255,0)');
  cx.fillStyle=gl;cx.beginPath();cx.arc(ox,oy,R*1.08,0,7);cx.fill();
  F.forEach(function(f,i){var n=qrot(q,f.n),c=qrot(q,f.c);if(V.dot(n,V.sub([0,0,cam],c))<=0)return;
    var k=cam/(cam-c[2]);list.push({i:i,nz:n[2],c:[ox+c[0]*R*k*.86,oy-c[1]*R*k*.86],rin:f.rin*R*k*.86*Math.max(.25,n[2]),
      pts:f.pts.map(function(p){var r=qrot(q,p),kk=cam/(cam-r[2]);return[ox+r[0]*R*kk*.86,oy-r[1]*R*kk*.86];})});});
  list.sort(function(a,b){return a.nz-b.nz;});
  list.forEach(function(p){var s=S[p.i],light=.5+.5*Math.max(0,p.nz);
    cx.beginPath();p.pts.forEach(function(t,k){k?cx.lineTo(t[0],t[1]):cx.moveTo(t[0],t[1]);});cx.closePath();
    cx.fillStyle=color(s.chg);cx.fill();cx.fillStyle='rgba(4,8,20,'+((1-light)*.72)+')';cx.fill();
    cx.lineWidth=1.1;cx.strokeStyle='rgba(215,228,255,.6)';cx.lineJoin='round';cx.stroke();
    if(p.nz>.42){var fs=Math.round(Math.max(9,Math.min(16,p.rin*.35))),FF="Pretendard,'Malgun Gothic',sans-serif";
      cx.globalAlpha=Math.min(1,(p.nz-.42)/.18);cx.textAlign='center';cx.textBaseline='middle';cx.lineJoin='round';
      var lines=s.name.length>5&&s.name.indexOf('·')>0?s.name.split('·'):[s.name],yy=p.c[1]-(lines.length*fs*1.12+fs*.95)/2+fs*.56,tx=Math.round(p.c[0]);
      var put=function(t,f,z){cx.font=f;cx.lineWidth=Math.max(2,z*.16);cx.strokeStyle='rgba(6,12,30,.5)';cx.strokeText(t,tx,Math.round(yy));cx.fillStyle='#fff';cx.fillText(t,tx,Math.round(yy));};
      lines.forEach(function(t){put(t,'800 '+fs+'px '+FF,fs);yy+=fs*1.12;});
      put(pct(s.chg),'800 '+Math.round(fs*.84)+'px '+FF,fs*.84);cx.globalAlpha=1;}
  });
}
function xy(e){return[e.clientX,e.clientY];}
cv.addEventListener('pointerdown',function(e){drag=true;moved=0;last=xy(e);try{cv.setPointerCapture(e.pointerId);}catch(_){}});
cv.addEventListener('pointermove',function(e){if(!drag)return;var p=xy(e),dx=(p[0]-last[0])*.012,dy=(p[1]-last[1])*.012;moved+=Math.abs(p[0]-last[0])+Math.abs(p[1]-last[1]);rot(dx,dy);vel=[dx,dy];last=p;});
cv.addEventListener('pointerup',function(){drag=false;});cv.addEventListener('pointercancel',function(){drag=false;});
// 감싸고 있는 <a> 링크: 드래그로 돌린 직후에는 이동하지 않는다
var link=cv.closest('a');if(link)link.addEventListener('click',function(e){if(moved>6){e.preventDefault();moved=0;}});
cv.addEventListener('dragstart',function(e){e.preventDefault();});
window.addEventListener('resize',size);
if('IntersectionObserver' in window)new IntersectionObserver(function(en){vis=en[0].isIntersecting;}).observe(cv);
fetch('data/market-polyhedron.json?t='+Date.now()).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(D){
  S=D.sectors.map(function(name){var st=D.stocks.filter(function(x){return x.s===name;}),s=0,w=0;
    var cap=0;st.forEach(function(x){cap+=x.cap;if(x.d1!=null){s+=x.d1*x.cap;w+=x.cap;}});return{name:name,chg:w?s/w:null,cap:cap,cnt:st.length};});
  F=buildPoly(S.length,faceWeights(S));size();
  var m=document.getElementById('poly-mini-meta');if(m)m.textContent=S.length+'개 산업 · '+D.stocks.length+'종목 · '+D.asof+' 종가';
  var box=document.getElementById('hero-poly');if(box)box.classList.add('ready');
  requestAnimationFrame(draw);
}).catch(function(){var box=document.getElementById('hero-poly');if(box)box.style.display='none';});
})();
