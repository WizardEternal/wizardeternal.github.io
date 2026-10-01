(function(){'use strict';var W=window,doc=document;var D=W.Doodles=W.Doodles||{};var HEAD_H=`<circle class="s" cy="-19" r="21"/>
<path class="s" d="M20.4-20q5 2 1.8 6.4"/>
<path class="f" stroke="none" d="M15-34C7-44-10-44-17-34C-22-27-22-14-17-5C-14-14-12-20-8-24C0-28 9-28 15-34Z"/>
<path fill="url(#dk-hatch)" stroke-width="2" d="M15-34C7-44-10-44-17-34C-22-27-22-14-17-5C-14-14-12-20-8-24C0-28 9-28 15-34Z"/>
<path d="M-6-40q2-8 10-6" stroke-width="2"/>
<path class="e" d="M-4-17.5q-4.5-1-4 3.5q.5 3.5 4.5 2" stroke-width="1.6"/>
<ellipse class="ef fs-open dk-eye" cx="15.5" cy="-21.5" rx="2" ry="2.4"/>
<path class="e fs-shut fs-lid" d="M12.6-22q2.9 2.8 5.8 0" stroke-width="1.6"/>
<g class="fs-wow"><path class="e" d="M11.5-28.5q4-2.6 8-.6" stroke-width="1.4"/>
<circle class="e" cx="15.5" cy="-21.5" r="3.1" stroke-width="1.3"/><circle class="ef" cx="16.2" cy="-21.5" r="1.3"/></g>
<ellipse class="blush" cx="10" cy="-11" rx="4" ry="2.4"/>
<path class="e fs-open" d="M14-6q3 1.5 5-1" stroke-width="1.6"/>
<path class="e fs-shut" d="M14.5-5.8q2 .9 3.8 0" stroke-width="1.5"/>
<ellipse class="e fs-wow" cx="16.8" cy="-6" rx="1.7" ry="2.2" stroke-width="1.5"/>
<ellipse class="e am fs-yawn" cx="16.4" cy="-6.2" rx="2.3" ry="3.4" stroke-width="1.5"/>`;var HEAD_B=`<circle class="s" cy="-22" r="22"/>
<path class="f" stroke="none" d="M-21-22C-23-10-19-4-17-3L-15-22ZM21-22C23-10 19-4 17-3L15-22Z"/>
<path fill="url(#dk-hatch)" stroke-width="1.8" d="M-21-22C-23-10-19-4-17-3L-15-22ZM21-22C23-10 19-4 17-3L15-22Z"/>
<path class="f" d="M-23-27C-23-48 23-48 23-27Z"/>
<rect class="f" x="-25" y="-31" width="50" height="9" rx="4.5"/>
<path d="M-18-30v7M-12-30v7M-6-30v7M0-30v7M6-30v7M12-30v7M18-30v7" stroke-width="1.3"/>
<circle class="f" cy="-49" r="6.5"/>
<path d="M-3-51l2 2M1-52l1 3M-2-46l3-1" stroke-width="1.2"/>
<ellipse class="ef fs-open dk-eye" cx="-8" cy="-16" rx="2.2" ry="2.6"/>
<ellipse class="ef fs-open dk-eye" cx="8" cy="-16" rx="2.2" ry="2.6"/>
<path class="e fs-shut fs-lid" d="M-11-16.5q3 2.8 6 0M5-16.5q3 2.8 6 0" stroke-width="1.6"/>
<g class="fs-wow"><path class="e" d="M-12-23.5q4-2.4 8 0M4-23.5q4-2.4 8 0" stroke-width="1.4"/>
<circle class="e" cx="-8" cy="-16" r="3.3" stroke-width="1.3"/><circle class="e" cx="8" cy="-16" r="3.3" stroke-width="1.3"/>
<circle class="ef" cx="-8" cy="-16" r="1.4"/><circle class="ef" cx="8" cy="-16" r="1.4"/></g>
<g class="fs-down"><ellipse class="ef" cx="-8" cy="-12.6" rx="2.1" ry="1.9"/><ellipse class="ef" cx="8" cy="-12.6" rx="2.1" ry="1.9"/><path class="e" d="M-11.2-14q3.2-3.2 6.4 0M4.8-14q3.2-3.2 6.4 0" stroke-width="1.5"/>
<path class="e" d="M-2.5-7q2.5 1.4 5 0" stroke-width="1.6"/></g>
<ellipse class="blush" cx="-14" cy="-8" rx="4" ry="2.4"/><ellipse class="blush" cx="14" cy="-8" rx="4" ry="2.4"/>
<path class="e am fs-open" d="M-5.5-9Q0 1 5.5-9Z" stroke-width="1.8"/>
<path class="e fs-shut" d="M-3-7.5q3 1.6 6 0" stroke-width="1.6"/>
<ellipse class="e am fs-wow" cy="-6" rx="3" ry="3.8" stroke-width="1.6"/>
<ellipse class="e am fs-yawn" cy="-5.6" rx="3.6" ry="4.8" stroke-width="1.6"/>
<path class="dk-marks" d="M30-42l7-5M32-32l8-1M26-51l3-7" stroke-width="1.8"/>`;var PARTS={defs:`<filter id="dk-boil" x="-4%" y="-4%" width="108%" height="108%">
<feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="2">
<animate attributeName="seed" values="2;9;17;24" dur="0.9s" calcMode="discrete" repeatCount="indefinite"/></feTurbulence>
<feDisplacementMap in="SourceGraphic" scale="2.6" xChannelSelector="R" yChannelSelector="G"/></filter>
<pattern id="dk-hatch" width="3.4" height="3.4" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
<path class="i" d="M0 1.7h3.4" stroke-width="1.5"/></pattern>`,hatch:`<g class="dk-kid dk-hatch" data-face="open" data-arm="hold" data-legs="-7.5 6.5 -18">
<path class="i dk-leg" stroke-width="8.6" d="M-7.5-18v14M6.5-18v14"/>
<path class="fs dk-leg" stroke-width="4.2" d="M-7.5-18v14M6.5-18v14"/>
<path class="if dk-foot" transform="translate(-8.5 0)" d="M-6.5 0q0-5 7-5q6 0 6 5z"/>
<path class="if dk-foot" transform="translate(8 0)" d="M-7 0q0-5 7-5q7 0 7 5z"/>
<g transform="translate(0 -16)"><g class="dk-upper">
<g transform="translate(8 -21)"><g class="dk-arm">
<g class="arm-hold"><path class="i dk-armd" stroke-width="9" d="M0 0Q18 2 30.5-19.5"/>
<path class="fs dk-armd" stroke-width="4.6" d="M0 0Q18 2 30.5-19.5"/><circle class="s dk-hand" cx="33" cy="-22" r="4.6"/></g>
<g class="arm-rest"><path class="i" stroke-width="9" d="M0 0Q9 8 9 16"/></g>
</g></g>
<path class="f" d="M-11-28Q2-34 15-27L19-3Q19 2 13 2L-13 2Q-19 2-18-3Z"/>
<path d="M-8-16q8 3 14 0" stroke-width="1.5"/>
<g transform="translate(8 -21)"><g class="dk-arm"><g class="arm-rest"><path class="fs" stroke-width="4.6" d="M0 0Q9 8 9 16"/>
<circle class="s" cx="9.5" cy="18.5" r="4.6"/></g></g></g>
<g transform="translate(4 -26)"><g class="dk-head">
${HEAD_H}
</g></g>
</g></g></g>`,bobble:`<g class="dk-kid dk-bobble" data-face="open" data-arm="point" data-legs="-7.5 7.5 -20">
<path class="i dk-leg" stroke-width="8.6" d="M-7.5-20v16M7.5-20v16"/>
<path class="fs dk-leg" stroke-width="4.2" d="M-7.5-20v16M7.5-20v16"/>
<path class="if dk-foot" transform="translate(-8.5 0)" d="M-6.5 0q0-5 7-5q6 0 6 5z"/>
<path class="if dk-foot" transform="translate(9 0)" d="M-7 0q0-5 7-5q7 0 7 5z"/>
<g transform="translate(0 -18)"><g class="dk-upper">
<path class="i" stroke-width="9" d="M11-20Q21-12 19-4"/>
<g transform="translate(-10 -22)"><g class="dk-arm">
<g class="arm-point"><g class="dk-point-wig"><path class="i" stroke-width="9" d="M0 1L-21-41"/></g></g>
<g class="arm-wave"><g class="sw"><path class="i" stroke-width="9" d="M0 1L-26-33"/></g></g>
<g class="arm-rest"><path class="i" stroke-width="9" d="M-1 2Q-11 10-9 18"/></g>
</g></g>
<path class="f" d="M-13-28Q0-35 14-28L19-3Q19 2 13 2L-13 2Q-19 2-19-3Z"/>
<path d="M0-26v27" stroke-width="1.6"/>
<circle class="if" cx="-5" cy="-16" r="1.4" stroke="none"/><circle class="if" cx="-5" cy="-7" r="1.4" stroke="none"/>
<path class="fs" stroke-width="4.6" d="M11-20Q21-12 19-4"/><circle class="s" cx="19" cy="-2" r="4.6"/>
<g transform="translate(-10 -22)"><g class="dk-arm">
<g class="arm-point"><g class="dk-point-wig"><path class="fs" stroke-width="4.6" d="M0 1L-21-41"/>
<path class="s" stroke-width="1.8" transform="translate(-21 -42) rotate(-26.6)" d="M-5.5 2Q-6-4-3-4.5L-3-12Q-3-14.5-.8-14.5Q1.4-14.5 1.4-12L1.4-4.5Q5.5-4.5 5.5 1Q5.5 7 0 7Q-5.5 7-5.5 2ZM1.4-1.5q2.4.2 3.4 2"/></g></g>
<g class="arm-wave"><g class="sw"><path class="fs" stroke-width="4.6" d="M0 1L-26-33"/>
<path class="s" stroke-width="1.6" transform="translate(-27 -35) rotate(-38)" d="M-5 4Q-6.5-2-5.5-5L-6.5-10.5Q-6.8-12.5-5-12.8Q-3.5-13-3.1-11L-2.4-7L-2.2-13Q-2.1-15-.3-15Q1.4-15 1.4-13L1.4-7L2.8-12Q3.4-13.8 5-13.3Q6.5-12.7 6-11L4.4-4.5Q6.6-7 8.2-5.8Q9.3-4.8 8-3L4.6 2.5Q2.5 6-1 6Q-4.4 6-5 4Z"/></g></g>
<g class="arm-rest"><path class="fs" stroke-width="4.6" d="M-1 2Q-11 10-9 18"/><circle class="s" cx="-9" cy="20.5" r="4.6"/></g>
</g></g>
<g transform="translate(1 -30)"><g class="dk-head">
${HEAD_B}
</g></g>
</g></g></g>`,'hatch-sit':`<g class="dk-kid dk-hatch dk-sit" data-face="open" data-arm="type">
<path class="i" stroke-width="8.6" d="M-21-20.5H-6.5Q-2.5-20.5-2.5-16.5V-4"/><path class="fs" stroke-width="4.2" d="M-21-20.5H-6.5Q-2.5-20.5-2.5-16.5V-4"/>
<path class="if" transform="translate(-2 0)" d="M-6.5 0q0-5 7-5q6 0 6 5z"/>
<path class="i" stroke-width="8.6" d="M-19-19H-2Q2-19 2-15V-4"/><path class="fs" stroke-width="4.2" d="M-19-19H-2Q2-19 2-15V-4"/>
<path class="if" transform="translate(3 0)" d="M-7 0q0-5 7-5q7 0 7 5z"/>
<g transform="translate(-27 -24)"><g class="dk-upper">
<g transform="translate(8 -21)"><g class="dk-arm">
<g class="arm-type"><g class="dk-tap dk-tap2"><path class="i" stroke-width="9" d="M0 0Q14 9 30.5 2.5"/><path class="fs" stroke-width="4.6" d="M0 0Q14 9 30.5 2.5"/>
<circle class="s" cx="33" cy="2" r="4.6"/></g></g>
<g class="arm-type"><g class="dk-tap"><path class="i" stroke-width="9" d="M0 0Q16 11 34 6"/></g></g>
<g class="arm-fold"><path class="i" stroke-width="9" d="M0 0Q10-2 19-11"/></g>
</g></g>
<path class="f" d="M-11-28Q2-34 15-27L19-3Q19 2 13 2L-13 2Q-19 2-18-3Z"/>
<path d="M-8-16q8 3 14 0" stroke-width="1.5"/>
<g transform="translate(8 -21)"><g class="dk-arm">
<g class="arm-type"><g class="dk-tap"><path class="fs" stroke-width="4.6" d="M0 0Q16 11 34 6"/><circle class="s" cx="36.5" cy="5.6" r="4.6"/></g></g>
<g class="arm-fold"><path class="fs" stroke-width="4.6" d="M0 0Q10-2 19-11"/><circle class="s" cx="21" cy="-12.5" r="4.6"/></g>
</g></g>
<g transform="translate(4 -26)"><g class="dk-head">
${HEAD_H}
</g></g>
</g></g></g>`,'hatch-tummy':`<g class="dk-kid dk-hatch dk-tummy" data-face="open" data-arm="write" data-kick="on">
<path class="i" stroke-width="8.6" d="M-1-11L-21-4.5"/>
<g transform="translate(-21 -4.5)"><g class="dk-kick k2"><path class="i" stroke-width="8.6" d="M0 0L3-17"/></g></g>
<path class="fs" stroke-width="4.2" d="M-1-11L-21-4.5"/>
<g transform="translate(-21 -4.5)"><g class="dk-kick k2"><path class="fs" stroke-width="4.2" d="M0 0L3-17"/>
<path class="if" transform="translate(3.6 -20.5) rotate(188)" d="M-7 0q0-5 7-5q7 0 7 5z"/></g></g>
<path class="i" stroke-width="8.6" d="M0-7L-27-4.5"/>
<g transform="translate(-27 -4.5)"><g class="dk-kick"><path class="i" stroke-width="8.6" d="M0 0L-2-17"/></g></g>
<path class="fs" stroke-width="4.2" d="M0-7L-27-4.5"/>
<g transform="translate(-27 -4.5)"><g class="dk-kick"><path class="fs" stroke-width="4.2" d="M0 0L-2-17"/>
<path class="if" transform="translate(-2.2 -20.5) rotate(176)" d="M-6.5 0q0-5 7-5q6 0 6 5z"/></g></g>
<path class="i" stroke-width="9" d="M26-24L33-4.5L42-18"/><path class="fs" stroke-width="4.6" d="M26-24L33-4.5L42-18"/>
<circle class="s" cx="42.5" cy="-20.5" r="4.6"/>
<path class="i arm-write" stroke-width="9" d="M22-16L38-4.5L53-10"/>
<g class="dk-upper">
<path class="f" d="M-5-3Q-9-19 3-21L27-30Q37-33 38-22L36-11Q35-6 29-5L2 0Q-4 1-5-3Z"/>
<path d="M8-6q3-6 1-11" stroke-width="1.5"/>
<g transform="translate(27 -25)"><g transform="rotate(12)"><g class="dk-head">
${HEAD_H}
</g></g></g>
</g>
<g class="arm-write"><path class="fs" stroke-width="4.6" d="M22-16L38-4.5L53-10"/>
<g class="dk-pen"><path class="i" stroke-width="4.4" d="M51-18.5L61-3.5"/><path class="a" stroke-width="1.8" d="M51-18.5L59.5-5.5"/>
<circle class="s" cx="55" cy="-11.5" r="4.6"/></g></g>
</g>`,'bobble-sit':`<g class="dk-kid dk-bobble dk-sit" data-face="open" data-arm="rest" data-swing="off">
<g transform="translate(-7.5 -3)"><g class="dk-swing"><path class="i" stroke-width="8.6" d="M0 0v14"/><path class="fs" stroke-width="4.2" d="M0 0v14"/>
<path class="if" transform="translate(-1 18)" d="M-6.5 0q0-5 7-5q6 0 6 5z"/></g></g>
<g transform="translate(7.5 -3)"><g class="dk-swing s2"><path class="i" stroke-width="8.6" d="M0 0v14"/><path class="fs" stroke-width="4.2" d="M0 0v14"/>
<path class="if" transform="translate(1.5 18)" d="M-7 0q0-5 7-5q7 0 7 5z"/></g></g>
<g transform="translate(0 -2)"><g class="dk-upper">
<path class="i arm-rest" stroke-width="9" d="M-11-20Q-21-12-19-4M11-20Q21-12 19-4"/>
<path class="i arm-book" stroke-width="9" d="M-11-20Q-20-9-13-5M11-20Q20-9 13-5"/>
<path class="f" d="M-13-28Q0-35 14-28L19-3Q19 2 13 2L-13 2Q-19 2-19-3Z"/>
<path d="M0-26v27" stroke-width="1.6"/>
<circle class="if" cx="-5" cy="-16" r="1.4" stroke="none"/><circle class="if" cx="-5" cy="-7" r="1.4" stroke="none"/>
<g class="arm-rest"><path class="fs" stroke-width="4.6" d="M-11-20Q-21-12-19-4M11-20Q21-12 19-4"/>
<circle class="s" cx="-19" cy="-2" r="4.6"/><circle class="s" cx="19" cy="-2" r="4.6"/></g>
<g class="arm-book"><path class="fs" stroke-width="4.6" d="M-11-20Q-20-9-13-5M11-20Q20-9 13-5"/>
<path class="f" d="M0-17Q-8-21-17-18L-17-2Q-8-5 0-1Q8-5 17-2L17-18Q8-21 0-17Z"/>
<path d="M0-17V-1M-13-15q5-1.5 9 0M-13-11q5-1.5 9 0M4-15q5-1.5 9 0M4-11q5-1.5 9 0" stroke-width="1.1"/>
<circle class="s" cx="-16" cy="-5" r="4.4"/><circle class="s" cx="16" cy="-5" r="4.4"/></g>
<g transform="translate(1 -30)"><g class="dk-head">
${HEAD_B}
</g></g>
</g></g></g>`,star:`<path class="tw" d="M0-10.5l3.6 7.6 8.2 1-6 5.6 1.6 8.2-7.4-4-7.4 4 1.6-8.2-6-5.6 8.2-1z"/>`,'star-s':`<path class="tw" d="M0-7.5l2.6 5.4 5.8.8-4.2 4 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4 5.8-.8z"/>`,spark:`<path class="tw" d="M0-5v10M-5 0h10"/>`,'spark-s':`<path class="tw" d="M0-3.8v7.6M-3.8 0h7.6"/>`,dot:`<circle class="tw af" r="1.3"/>`,moon:`<path d="M0-18A22 22 0 1 0 14 18A18 18 0 0 1 0-18Z"/><path d="M-6-2q-1 6 3 10" stroke-width="1.4" opacity=".7"/>`,grass:`<path d="M-4 0l2-7M1 0l-1-8M5 0l3-6" stroke-width="1.6"/>`,sheep:function(slot){return sheepPart(slot);}};D.parts=PARTS;function stamp(svg){if(!svg.querySelector('#dk-boil')){var defs=doc.createElementNS('http://www.w3.org/2000/svg','defs');defs.innerHTML=PARTS.defs;svg.insertBefore(defs,svg.firstChild);}
var slots=svg.querySelectorAll('[data-kid],[data-part]');for(var i=0;i<slots.length;i++){var s=slots[i],name=s.getAttribute('data-kid')||s.getAttribute('data-part');if(!s.firstElementChild&&PARTS[name]){s.innerHTML=typeof PARTS[name]==='function'?PARTS[name](s):PARTS[name];[].forEach.call(s.attributes,function(a){if(/^data-(?!kid$|part$|feet$)/.test(a.name))s.firstElementChild.setAttribute(a.name,a.value);});}
if(s.hasAttribute('data-feet')&&s.firstElementChild)plant(s.firstElementChild,s.getAttribute('data-feet'));}}
function plant(kid,spec){var v=spec.split(/[\s,]+/).map(Number),L=kid.getAttribute('data-legs').split(' ').map(Number);var feet=kid.querySelectorAll('.dk-foot'),legs=kid.querySelectorAll('.dk-leg'),d='';kid.__feet=[];for(var k=0;k<2;k++){feet[k].setAttribute('transform','translate('+v[3*k]+' '+v[3*k+1]+') rotate('+v[3*k+2]+')');kid.__feet.push(v[3*k+1]-4);d+='M'+L[k]+' '+L[2]+'V'+(v[3*k+1]-4);}
for(k=0;k<legs.length;k++)legs[k].setAttribute('d',d);}
D.stamp=stamp;var RAD=Math.PI/180;function rot(deg,v){var c=Math.cos(deg*RAD),s=Math.sin(deg*RAD);return[c*v[0]-s*v[1],s*v[0]+c*v[1]];}
function clamp(x,a,b){return x<a?a:x>b?b:x;}
function lerp(a,b,t){return a+(b-a)*t;}
function f1(x){return Math.round(x*10)/10;}
function now(){return performance.now();}
function ease(dt,tau){return 1-Math.exp(-dt/tau);}
function toClient(svg,x,y){var m=svg.getScreenCTM();return m?[m.a*x+m.c*y+m.e,m.b*x+m.d*y+m.f]:[0,0];}
function over(svg,p,pad){var r=svg.getBoundingClientRect();pad=pad||0;return p.x>r.left-pad&&p.x<r.right+pad&&p.y>r.top-pad&&p.y<r.bottom+pad;}
var reduceMQ=W.matchMedia('(prefers-reduced-motion: reduce)'),hoverMQ=W.matchMedia('(hover: hover)');var inst=D.instances=[],ptr={x:0,y:0,has:false,tap:false};var lastInput=now(),pending=null,ptrRaf=0,booted=false,anchor=null;var IDLE=D.IDLE=8000,JITTER=4;D.util={RAD:RAD,rot:rot,clamp:clamp,lerp:lerp,f1:f1,now:now,ease:ease,toClient:toClient,over:over,ptr:ptr,hoverMQ:hoverMQ,IDLE:IDLE,idleFor:function(){return now()-lastInput;},fakeIdle:function(ms){lastInput=now()-ms;}};function each(fn){inst.forEach(fn);}
function input(kind,e){lastInput=now();each(function(c){if(c.sheep&&c.sheep.intercept(kind,e))return;if(c.onInput)c.onInput();});}
function onPtr(e){if(e.type!=='pointermove')input('down',e);else if(!anchor||Math.abs(e.clientX-anchor[0])+Math.abs(e.clientY-anchor[1])>=JITTER){anchor=[e.clientX,e.clientY];input('move',e);}
if(e.type==='pointerdown'||!pending||pending.type!=='pointerdown')pending=e;if(!ptrRaf)ptrRaf=requestAnimationFrame(function(){var e=pending;ptrRaf=0;pending=null;ptr.x=e.clientX;ptr.y=e.clientY;ptr.has=true;ptr.tap=e.type==='pointerdown'&&e.pointerType!=='mouse';each(function(c){if(c.visible&&c.onPointer&&!(c.sheep&&c.sheep.busy()))c.onPointer(ptr);});});}
function smil(c){var s=c.svg;if(c.reduced){s.pauseAnimations();s.setCurrentTime(0);}
else if(c.visible)s.unpauseAnimations();else s.pauseAnimations();}
function setReduced(c){c.reduced=reduceMQ.matches;smil(c);if(c.onReduced)c.onReduced();if(c.sheep)c.sheep.onReduced();}
function setVisible(c,v){if(c.visible===v)return;c.visible=v;c.svg.classList.toggle('dk-paused',!v);smil(c);if(c.onVisible)c.onVisible(v);if(c.sheep)c.sheep.onVisible(v);}
var io=new IntersectionObserver(function(en){en.forEach(function(x){if(x.target.__doodle)setVisible(x.target.__doodle,x.isIntersecting);});},{rootMargin:'40px'});var SHEEP_D=24,SHEEP_H=26;function sheepPart(slot){var dir=slot.getAttribute('data-fence')==='left'?-1:1,k=parseFloat(slot.getAttribute('data-slope'))||0;var F=SHEEP_D*dir,sk=f1(Math.atan(k)/RAD),bx=dir>0?2:-33,zx=dir>0?10:-14;return`<g class="dk-sheep" data-state="awake">
<g class="dk-fence" transform="translate(${F} ${f1(k * F)}) skewY(${sk})">
<path d="M-5.6-1.2L-5.4-18.4M5.4-1.2L5.6-17.8" stroke-width="3"/>
<path d="M-8.6-13.1L8.8-13.8M-8.6-6.9L8.8-6.3" stroke-width="1.9"/>
<path d="M-11 0l1.3-4.6M-8.8 0l-.3-5.6M9 0l1.6-5M11.2 0l-.2-4" stroke-width="1.2"/>
</g>
<g class="dk-sheep-mv"><g class="dk-sheep-tilt"><g class="dk-sheep-flip" transform="scale(${dir} 1)"><g class="dk-sheep-wig">
<g transform="translate(-4.6 -6.5)"><path class="dk-sl sl-b" d="M0 0V5" stroke-width="3"/></g>
<g transform="translate(8.4 -6.5)"><path class="dk-sl sl-f" d="M0 0V5" stroke-width="3"/></g>
<g transform="translate(-8 -6.5)"><path class="dk-sl sl-b" d="M0 0V5" stroke-width="3"/></g>
<g transform="translate(5 -6.5)"><path class="dk-sl sl-f" d="M0 0V5" stroke-width="3"/></g>
<g class="dk-sheep-low">
<g transform="translate(-11 -15.5)"><g class="dk-sheep-tail"><path class="w" stroke-width="1.6" d="M0.2 0Q0.7 1.9-1.5 2.1Q-3.3 3.1-4.1 1.3Q-5.8 0-4.1-1.3Q-3.3-3.1-1.5-2.1Q0.7-1.9 0.2 0Z"/></g></g>
<path class="w" d="M11.3-12.6Q14.4-9.5 8.2-9.3Q8.5-5.1 2.6-7.4Q-0.9-4.7-3.9-7.6Q-9.9-6-9.1-9.8Q-15.2-10.5-11.5-13.4Q-15.2-15.8-10.2-17.2Q-12.3-21.1-5.7-19.9Q-3.7-23.4 0.7-20.8Q5.6-23.3 6.8-19.5Q12.5-19.7 10.7-16.5Q16.9-14.9 11.3-12.6Z"/>
<path class="e" opacity=".3" stroke-width="1" d="M-5.5-17.2q-1.8.4-1.2 2.2q.5 1 1.5.5M1.8-12.4q-1.8.4-1.2 2.2q.5 1 1.5.5M3.6-18.2q-1.8.4-1.2 2.2q.5 1 1.5.5M-6.4-10.8q-1.6.3-1 1.9"/>
<g transform="translate(9 -15)"><g class="dk-sheep-head"><g transform="translate(-9 15)">
<ellipse class="ef" cx="10.6" cy="-19.6" rx="3.5" ry="1.5" transform="rotate(-32 10.6 -19.6)" style="stroke: var(--doodle-ink)" stroke-width="1.2"/>
<ellipse class="ef" cx="14.8" cy="-16.2" rx="4.3" ry="5.6" transform="rotate(-30 14.8 -16.2)" style="stroke: var(--doodle-ink)" stroke-width="1.5"/>
<path class="w" stroke-width="1.4" d="M15.5-21.5Q15.4-19.6 12.3-20Q9.4-19.5 9.1-21.5Q7.4-23.2 10.3-24Q12.2-25.5 14.3-24Q17.1-23.3 15.5-21.5Z"/>
<circle class="w se-open" cx="16.2" cy="-17" r="1.15" stroke="none"/>
<path class="ws se-shut" d="M14.9-16.8q1.3 1.1 2.6 0" stroke-width="1.1"/>
</g></g></g>
</g>
</g>
<rect class="dk-sheep-hit" x="-17" y="-27" width="34" height="29" fill="transparent" stroke="none"/>
</g></g></g>
<g class="dk-sheep-say a">
<g transform="translate(${bx} -32) scale(1.2)"><g class="dk-baa" stroke-width="1.3"><path d="M0-8V0M9.2-5V0M16.2-5V0"/><circle cx="2.5" cy="-2.5" r="2.5"/><circle cx="6.7" cy="-2.5" r="2.5"/><circle cx="13.7" cy="-2.5" r="2.5"/>
<path d="M20.6-6.4q.2-2.6 2.8-2.6q2.6 0 2.6 2.3q0 1.8-2.6 2.6v1.4M23.4 0v.2" stroke-width="1.4"/></g></g>
<g transform="translate(${2 * F} ${f1(2 * F * k - 36)})"><g class="dk-sn"><path d="M-2-5l3-3V9" stroke-width="2.4"/></g></g>
<g transform="translate(0 -36)"><g class="dk-sn"><path d="M-4-5q2-5 7-2q3 3-1 7l-6 5h8" stroke-width="2.4"/></g></g>
<g transform="translate(${zx} -22)"><g class="dk-sz" stroke-width="1.5"><path d="M0 0h4.4l-4.4 4.4h4.4"/><path d="M5-6h3.4l-3.4 3.4h3.4"/></g></g>
</g>
</g>`;}
var SHEEP_HOLD=20000,SHEEP_END=2950,SHEEP_TAP=46;function makeSheep(svg,slot,c){if(slot.__sheep){slot.__sheep.c=c;return slot.__sheep;}
var root=slot.firstElementChild;if(!root)return null;var q=function(x){return root.querySelector(x);};var dir=slot.getAttribute('data-fence')==='left'?-1:1,k=parseFloat(slot.getAttribute('data-slope'))||0;var F2=2*SHEEP_D*dir,tilt0=Math.atan(k)/RAD;var mv=q('.dk-sheep-mv'),tl=q('.dk-sheep-tilt'),fl=q('.dk-sheep-flip'),nums=root.querySelectorAll('.dk-sn');var s={c:c,phase:'idle'},mode=null,t=0,raf=0,last=0,evi=0,holdT=0;var asleep0=false,aborted=false,drowsy=false,scroll0=0,wheel=0,yawner=null,mumbler=null,count=null;function smooth(x){x=clamp(x,0,1);return x*x*(3-2*x);}
function f2(x){return Math.round(x*100)/100;}
function state(v){if(root.getAttribute('data-state')!==v)root.setAttribute('data-state',v);}
function place(x,lift,tilt,fx,sy){if(Math.abs(fx)<0.06)fx=fx<0?-0.06:0.06;mv.setAttribute('transform','translate('+f1(x)+' '+f1(k*x-lift)+')');tl.setAttribute('transform','rotate('+f1(tilt0+tilt)+')');fl.setAttribute('transform','scale('+f2(fx)+' '+f2(sy)+')');}
function hop(t0,from,to,t){var m=to>from?1:-1,u=(t-t0-110)/580;if(u<0)return[from,0,0,m,1-0.12*smooth((t-t0)/110),false];return[lerp(from,to,u),4*SHEEP_H*u*(1-u),-m*14*(1-2*u),m,lerp(0.88,1.06,smooth((t-t0-110)/70)),u>0.05&&u<0.95];}
function land(x,fx,t){return[x,0,0,fx,1-0.14*Math.sin(Math.PI*clamp(t/130,0,1)),false];}
function turn(x,from,t){var p=clamp(t/200,0,1);return[x,3*Math.sin(Math.PI*p),0,from*Math.cos(Math.PI*p),1,false];}
function hopsPose(t){if(t<690)return hop(0,0,F2,t);if(t<950)return land(F2,dir,t-690);if(t<1250)return turn(F2,dir,t-950);if(t<1940)return hop(1250,F2,0,t);if(t<2250)return land(0,-dir,t-1940);return turn(0,-dir,t-2250);}
function numbers(t){[[760,1360],[2010,2900]].forEach(function(w,i){var lt=t-w[0],on=lt>=0&&t<w[1],e=nums[i];e.style.display=on?'inline':'none';if(!on)return;var sc=lt<90?0.4+0.8*lt/90:lt<170?1.2-0.2*(lt-90)/80:1;e.setAttribute('transform','scale('+f2(sc)+')');e.style.opacity=f2(clamp((w[1]-t)/150,0,1));});}
var NS='http://www.w3.org/2000/svg';function countMarks(){if(count)return count;count=doc.createElementNS(NS,'g');count.setAttribute('class','dk-count a');var dots=function(x){return[0,2.6,5.2].map(function(d){return'<circle class="af" cx="'+f1(x+d)+'" cy="4" r=".8" stroke="none"/>';}).join('');};count.innerHTML='<g><g stroke-width="1.3"><path d="M-1-3l2-2V4.5"/>'+dots(4.4)+'</g></g>'+'<g><g stroke-width="1.3"><path d="M-2.2-2.6q1.1-2.8 3.9-1.1q1.7 1.7-.6 3.9l-3.3 2.8h4.4"/>'+dots(5)+'</g></g>';(svg.querySelector('.dk-draw')||svg).appendChild(count);return count;}
function showCount(i){var g=countMarks(),kids=g.children;for(var j=0;j<kids.length;j++)kids[j].style.display=j===i?'inline':'none';if(i<0||!mumbler)return;var at=s.c.countAt;if(!at){var h=mumbler.querySelector('.dk-head')||mumbler,r=h.getBoundingClientRect(),m=svg.getScreenCTM();if(!m)return;var p=svg.createSVGPoint();p.x=r.left+r.width*0.6;p.y=r.top-8;p=p.matrixTransform(m.inverse());at=[p.x,p.y];}
g.setAttribute('transform','translate('+f1(at[0])+' '+f1(at[1])+') scale(1.5)');}
function pickKids(){var cc=s.c,bob=svg.querySelector('.dk-kid.dk-bobble'),hat=svg.querySelector('.dk-kid.dk-hatch');yawner=cc.yawner||(bob&&bob.getAttribute('data-face')!=='shut'?bob:hat);mumbler=cc.mumbler||(yawner===bob?hat:bob);}
function face(kid,f){if(kid&&drowsy)kid.setAttribute('data-face',f);}
var EVENTS=[[250,function(){face(yawner,'yawn');}],[900,function(){face(mumbler,'shut');if(drowsy)showCount(0);}],[1750,function(){face(yawner,'shut');}],[1850,function(){showCount(-1);}],[2000,function(){if(drowsy)showCount(1);}],[2600,function(){showCount(-1);if(!aborted)sleepNow();}],[2750,function(){if(!aborted)state('sleep');}]];function sleepNow(){var cc=s.c;if(cc.sleep)cc.sleep();s.phase='hold';state('sleep');clearTimeout(holdT);holdT=setTimeout(function(){s.end();},SHEEP_HOLD);}
function abort(){aborted=true;s.phase='idle';showCount(-1);if((drowsy||asleep0)&&s.c.wake)s.c.wake();drowsy=false;}
s.end=function(){if(s.phase!=='hold')return;clearTimeout(holdT);s.phase='idle';state('awake');s.c.idleFrom=now();if(s.c.wake)s.c.wake();if(!s.c.reduced){mode='wake';t=0;go();}};s.busy=function(){return s.phase!=='idle';};s.poke=function(){var cc=s.c;if(mode==='hops')return;root.classList.remove('is-perk');if(s.phase==='hold'||(cc.busy&&cc.busy())){if(!cc.reduced&&!mode){mode='bounce';t=0;go();}return;}
mode=null;asleep0=svg.classList.contains('is-asleep');aborted=false;drowsy=!asleep0;scroll0=W.scrollY;wheel=0;evi=0;pickKids();if(drowsy&&cc.drowse)cc.drowse();s.phase='drowse';if(cc.reduced){sleepNow();return;}
mode='hops';t=0;go();};s.intercept=function(kind,e){var tgt=e&&e.target&&e.target.nodeType?e.target:null;if((kind==='down'||kind==='touch')&&tgt&&root.contains(tgt))return true;if(s.phase==='idle')return false;var wake=kind==='key'||(kind==='down'&&tgt&&svg.contains(tgt))||(kind==='scroll'&&Math.abs(W.scrollY-scroll0)>60)||(kind==='wheel'&&(wheel+=Math.abs(e.deltaY||0)*(e.deltaMode?16:1))>150);if(wake){if(s.phase==='hold')s.end();else abort();}
return true;};function step(){var P;if(mode==='hops'){P=hopsPose(t);while(evi<EVENTS.length&&t>=EVENTS[evi][0])EVENTS[evi++][1]();numbers(t);if(t>=SHEEP_END){mode=null;P=[0,0,0,dir,1,false];if(aborted)s.phase='idle';}}else if(mode==='bounce'||mode==='wake'){var p=clamp(t/320,0,1);P=[0,(mode==='wake'?5:3.5)*Math.sin(Math.PI*p),0,dir,p>0.85?1-0.1*Math.sin(Math.PI*(p-0.85)/0.15):1,false];if(p>=1)mode=null;}else P=[0,0,0,dir,1,false];place(P[0],P[1],P[2],P[3],P[4]);if(root.getAttribute('data-state')!=='sleep')state(P[5]?'fly':'awake');}
function frame(ts){raf=0;t+=last?Math.min(100,ts-last):16;last=ts;step();if(mode&&s.c.visible)raf=requestAnimationFrame(frame);else last=0;}
function go(){if(!raf&&s.c.visible){last=0;raf=requestAnimationFrame(frame);}}
s.onVisible=function(v){if(v){fitHit();if(mode)go();}else{cancelAnimationFrame(raf);raf=0;last=0;}};s.onReduced=function(){if(!s.c.reduced||!mode)return;cancelAnimationFrame(raf);raf=0;if(mode==='hops'){t=SHEEP_END;while(evi<EVENTS.length)EVENTS[evi++][1]();numbers(t);if(aborted)s.phase='idle';}
mode=null;step();};s.seek=function(ms){cancelAnimationFrame(raf);raf=0;evi=EVENTS.length;if(ms<0){mode=null;numbers(-1e4);step();return;}
mode='hops';t=ms;var P=hopsPose(ms);numbers(ms);place(P[0],P[1],P[2],P[3],P[4]);state(P[5]?'fly':'awake');};var hit=q('.dk-sheep-hit'),fitRaf=0;function fitHit(){var m=slot.getScreenCTM(),sc=m?Math.sqrt(m.a*m.a+m.b*m.b):0;if(!hit||!sc)return;var w=Math.ceil(Math.max(34,SHEEP_TAP/sc)),h=Math.ceil(Math.max(29,SHEEP_TAP/sc));hit.setAttribute('x',-w/2);hit.setAttribute('y',f1(-12.5-h/2));hit.setAttribute('width',w);hit.setAttribute('height',h);}
W.addEventListener('resize',function(){if(!fitRaf)fitRaf=requestAnimationFrame(function(){fitRaf=0;fitHit();});},{passive:true});fitHit();mv.addEventListener('click',function(){s.poke();});mv.addEventListener('pointerenter',function(e){if(e.pointerType==='mouse'&&hoverMQ.matches&&s.phase==='idle'&&!mode&&root.getAttribute('data-state')==='awake')root.classList.add('is-perk');});mv.addEventListener('pointerleave',function(){root.classList.remove('is-perk');});place(0,0,0,dir,1);slot.__sheep=s;return s;}
function init(root,final){[].forEach.call((root||doc).querySelectorAll('svg.doodle'),function(svg){var make=D.scenes[svg.getAttribute('data-scene')],c=svg.__doodle;if(c&&!(c.stub&&make))return;stamp(svg);if(!make&&!final)return;if(c){inst.splice(inst.indexOf(c),1);io.unobserve(svg);}
try{c=make?make(svg)||{}:{stub:true};}
catch(err){c={};setTimeout(function(){throw err;});}
c.svg=svg;c.visible=false;svg.__doodle=c;var ss=svg.querySelector('[data-part="sheep"]');if(ss)c.sheep=makeSheep(svg,ss,c);inst.push(c);setReduced(c);io.observe(svg);});}
D.init=function(root){init(root,doc.readyState==='complete');};function boot(final){if(!booted){booted=true;W.addEventListener('pointermove',onPtr,{passive:true});W.addEventListener('pointerdown',onPtr,{passive:true});[['scroll','scroll'],['wheel','wheel'],['keydown','key'],['touchstart','touch']].forEach(function(p){W.addEventListener(p[0],function(e){input(p[1],e);},{passive:true});});reduceMQ.addEventListener('change',function(){each(setReduced);});setInterval(function(){each(function(c){if(c.visible&&c.onIdle)c.onIdle(now()-Math.max(lastInput,c.idleFrom||0));});},1000);}
init(null,final);}
D.scenes=D.scenes||{};if(doc.readyState==='complete')boot(true);else{doc.addEventListener('DOMContentLoaded',function(){boot(false);});W.addEventListener('load',function(){boot(true);});}})();