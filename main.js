/* agar-lite: vanilla JS canvas agar.io-like */
(() => {
  // Config
  const WORLD_SIZE = 8000; // square world
  const FOOD_COUNT = 2200;
  const BOT_COUNT = 25;
  const VIRUS_COUNT = 20; // big spikes that split larger cells
  const MIN_CELL_RADIUS = 10;
  const START_MASS = 35; // radius
  const EJECT_MASS = 12;
  const SPLIT_MIN_RADIUS = 24;
  const MERGE_DELAY_MS = 6000;
  const MAX_CELLS_PER_PLAYER = 16;

  // Helpers
  const rand = (min, max) => Math.random() * (max - min) + min;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const dist2 = (a, b) => {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx*dx + dy*dy;
  };
  const now = () => performance.now();

  function makeColor(h, s=65, l=55){
    return `hsl(${h}deg, ${s}%, ${l}%)`;
  }

  // Spatial hashing for broad-phase
  class SpatialHash {
    constructor(cellSize){
      this.cellSize = cellSize;
      this.map = new Map();
    }
    _key(i,j){ return i+","+j; }
    _ij(x,y){ return [Math.floor(x/this.cellSize), Math.floor(y/this.cellSize)]; }
    clear(){ this.map.clear(); }
    insert(entity){
      const r = entity.r || 0;
      const minI = Math.floor((entity.x - r)/this.cellSize);
      const maxI = Math.floor((entity.x + r)/this.cellSize);
      const minJ = Math.floor((entity.y - r)/this.cellSize);
      const maxJ = Math.floor((entity.y + r)/this.cellSize);
      for(let i=minI;i<=maxI;i++){
        for(let j=minJ;j<=maxJ;j++){
          const k = this._key(i,j);
          if(!this.map.has(k)) this.map.set(k, []);
          this.map.get(k).push(entity);
        }
      }
    }
    query(circle){
      const r = circle.r || 0;
      const minI = Math.floor((circle.x - r)/this.cellSize);
      const maxI = Math.floor((circle.x + r)/this.cellSize);
      const minJ = Math.floor((circle.y - r)/this.cellSize);
      const maxJ = Math.floor((circle.y + r)/this.cellSize);
      const out = [];
      for(let i=minI;i<=maxI;i++){
        for(let j=minJ;j<=maxJ;j++){
          const k = this._key(i,j);
          const arr = this.map.get(k);
          if(arr) out.push(...arr);
        }
      }
      return out;
    }
  }

  // Entities
  class Cell {
    constructor(id, name, x, y, r, color, isBot=false){
      this.id = id; this.name = name;
      this.x = x; this.y = y; this.r = r;
      this.color = color; this.isBot = isBot;
      this.vx = 0; this.vy = 0;
      this.mergeAt = 0; // when it can merge with same owner
    }
    get mass(){ return Math.PI * this.r * this.r; }
  }

  class Player {
    constructor(id, name, color){
      this.id = id; this.name = name; this.color = color;
      this.cells = [];
      this.alive = true;
    }
    totalMass(){ return this.cells.reduce((s,c)=>s+c.mass,0); }
  }

  class Food { constructor(x,y,r,color){ this.x=x; this.y=y; this.r=r; this.color=color; }}
  class Virus { constructor(x,y,r){ this.x=x; this.y=y; this.r=r; this.color="#2bdf7f"; }}

  // Game state
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const menu = document.getElementById('menu');
  const nicknameInput = document.getElementById('nickname');
  const playBtn = document.getElementById('play');
  const hudMass = document.getElementById('hud-mass');
  const hudCells = document.getElementById('hud-cells');
  const hudFps = document.getElementById('hud-fps');
  const leaderboardEl = document.getElementById('leaderboard');

  let W = window.innerWidth, H = window.innerHeight;
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * DPR; canvas.height = H * DPR; canvas.style.width = W+"px"; canvas.style.height = H+"px";
  ctx.scale(DPR, DPR);

  const state = {
    running: false,
    players: [],
    foods: [],
    viruses: [],
    me: null,
    mouse: {x:0,y:0},
    cam: {x:0,y:0, scale:1},
    grid: new SpatialHash(220),
    lastTime: now(),
    fpsSamples: [],
  };

  function resize(){
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W+"px"; canvas.style.height = H+"px";
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  window.addEventListener('resize', resize);

  // World helpers
  function randomPoint(){ return { x: rand(0, WORLD_SIZE), y: rand(0, WORLD_SIZE) }; }

  function spawnPlayer(player){
    const p = randomPoint();
    const base = new Cell(player.id, player.name, p.x, p.y, START_MASS, player.color, player.isBot);
    base.mergeAt = now() + MERGE_DELAY_MS;
    player.cells = [base];
    player.alive = true;
  }

  function splitCell(player, cell){
    if (cell.r < SPLIT_MIN_RADIUS || player.cells.length >= MAX_CELLS_PER_PLAYER) return;
    const angle = Math.atan2(state.mouse.y - (cell.y - state.cam.y), state.mouse.x - (cell.x - state.cam.x));
    const newR = Math.sqrt(cell.r*cell.r/2);
    cell.r = newR;
    const dist = cell.r*2 + 10;
    const nx = clamp(cell.x + Math.cos(angle)*dist, 0, WORLD_SIZE);
    const ny = clamp(cell.y + Math.sin(angle)*dist, 0, WORLD_SIZE);
    const child = new Cell(player.id, player.name, nx, ny, newR, player.color, player.isBot);
    const speed = 12 + 60/Math.sqrt(newR);
    child.vx = Math.cos(angle)*speed;
    child.vy = Math.sin(angle)*speed;
    const t = now();
    child.mergeAt = t + MERGE_DELAY_MS;
    cell.mergeAt = t + MERGE_DELAY_MS;
    player.cells.push(child);
  }

  function ejectMass(player, cell){
    if (cell.r <= MIN_CELL_RADIUS + 4) return;
    const angle = Math.atan2(state.mouse.y - (cell.y - state.cam.y), state.mouse.x - (cell.x - state.cam.x));
    const pelletR = 6;
    const nx = clamp(cell.x + Math.cos(angle)*(cell.r + pelletR + 2), 0, WORLD_SIZE);
    const ny = clamp(cell.y + Math.sin(angle)*(cell.r + pelletR + 2), 0, WORLD_SIZE);
    state.foods.push(new Food(nx, ny, pelletR, makeColor(200, 80, 70)));
    state.foods[state.foods.length-1].vx = Math.cos(angle)*18;
    state.foods[state.foods.length-1].vy = Math.sin(angle)*18;
    cell.r = Math.max(MIN_CELL_RADIUS, Math.sqrt(Math.max(0, cell.r*cell.r - EJECT_MASS)));
  }

  function killPlayer(player){ player.alive = false; player.cells = []; }

  // Initialization
  function initWorld(){
    state.players = [];
    state.foods = [];
    state.viruses = [];

    for(let i=0;i<FOOD_COUNT;i++){
      const p = randomPoint();
      state.foods.push(new Food(p.x, p.y, rand(3,6), makeColor(Math.floor(rand(0,360)), 70, 60)));
    }
    for(let i=0;i<VIRUS_COUNT;i++){
      const p = randomPoint();
      state.viruses.push(new Virus(p.x, p.y, rand(36, 52)));
    }

    // bots
    for(let i=0;i<BOT_COUNT;i++){
      const color = makeColor(Math.floor(rand(0,360)), 70, 55);
      const bot = new Player("bot-"+i, ["alpha","beta","zeta","omicron","tau","ion","neo"][Math.floor(rand(0,7))]+i, color);
      bot.isBot = true;
      state.players.push(bot);
      spawnPlayer(bot);
    }
  }

  // Camera follows player mass center
  function updateCamera(){
    if(!state.me || !state.me.alive || state.me.cells.length === 0) return;
    const cx = state.me.cells.reduce((s,c)=>s+c.x,0)/state.me.cells.length;
    const cy = state.me.cells.reduce((s,c)=>s+c.y,0)/state.me.cells.length;
    // scale inversely to mass
    const targetScale = clamp(1.8 - Math.log10(Math.max(35, Math.sqrt(state.me.totalMass()/Math.PI))) * 0.3, 0.45, 1.6);
    const lerp = 0.1;
    state.cam.x += (cx - state.cam.x - W/2) * lerp;
    state.cam.y += (cy - state.cam.y - H/2) * lerp;
    state.cam.x = clamp(state.cam.x, 0, WORLD_SIZE - W);
    state.cam.y = clamp(state.cam.y, 0, WORLD_SIZE - H);
    state.cam.scale += (targetScale - state.cam.scale) * 0.08;
  }

  // Input
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    state.mouse.x = e.clientX - rect.left;
    state.mouse.y = e.clientY - rect.top;
  });

  window.addEventListener('keydown', (e) => {
    if(e.code === 'Space'){ e.preventDefault(); if(state.me?.alive) state.me.cells.slice().forEach(c=>splitCell(state.me, c)); }
    if(e.key === 'w' || e.key === 'W'){ e.preventDefault(); if(state.me?.alive) state.me.cells.forEach(c=>ejectMass(state.me,c)); }
    if(e.key === 'p' || e.key === 'P'){ state.running = !state.running; if(state.running) loop(); }
    if(e.key === 'r' || e.key === 'R'){ if(state.me) { spawnPlayer(state.me); state.running = true; menu.classList.add('hidden'); loop(); } }
  });

  // Bot AI
  function botThink(bot){
    if(!bot.alive) return;
    for(const c of bot.cells){
      // seek nearest food or smaller prey within range
      let target = null; let bestD2 = Infinity;
      const query = state.grid.query({x:c.x, y:c.y, r:600});
      for(const e of query){
        if(e===c) continue;
        if(e instanceof Food){
          const d2v = dist2(c, e);
          if(d2v < bestD2){ bestD2 = d2v; target = e; }
        }
      }
      // chance to chase smaller opponent cell nearby
      for(const p of state.players){
        if(p===bot || !p.alive) continue;
        for(const oc of p.cells){
          if(oc.r < c.r*0.9){
            const d2v = dist2(c, oc);
            if(d2v < bestD2 && d2v < 500*500){ bestD2 = d2v; target = oc; }
          }
        }
      }
      if(!target){
        // wander
        const t = now()/1000 + bot.id.length; // deterministic seedish
        const angle = (Math.sin(t*0.7)+Math.cos(t*1.3))*0.7;
        c.vx += Math.cos(angle)*0.2; c.vy += Math.sin(angle)*0.2;
      } else {
        const dx = target.x - c.x, dy = target.y - c.y;
        const len = Math.hypot(dx,dy)||1;
        c.vx += (dx/len) * 0.8;
        c.vy += (dy/len) * 0.8;
      }
    }
  }

  // Physics
  function update(dt){
    // gravity-free; drag depends on size
    state.grid.clear();
    state.foods.forEach(f => state.grid.insert(f));
    state.viruses.forEach(v => state.grid.insert(v));
    for(const p of state.players) for(const c of p.cells) state.grid.insert(c);

    // update food (pellets with velocity)
    for(const f of state.foods){
      if(f.vx||f.vy){ f.x += f.vx*dt; f.y += f.vy*dt; f.vx *= 0.94; f.vy *= 0.94; }
      f.x = clamp(f.x, 0, WORLD_SIZE); f.y = clamp(f.y, 0, WORLD_SIZE);
    }

    // bot thinking
    for(const p of state.players){ if(p.isBot) botThink(p); }

    // move cells
    for(const p of state.players){
      for(const c of p.cells){
        // player control: steer toward mouse
        if(!p.isBot && p===state.me){
          const dx = state.mouse.x + state.cam.x - c.x;
          const dy = state.mouse.y + state.cam.y - c.y;
          const d = Math.hypot(dx,dy)||1;
          const maxSpeed = clamp(140 / Math.sqrt(c.r), 12, 80);
          // accelerate toward target
          c.vx += (dx/d) * maxSpeed * 0.12;
          c.vy += (dy/d) * maxSpeed * 0.12;
        }
        // drag inversely proportional to size
        const drag = clamp(0.86 - (c.r/300)*0.15, 0.7, 0.96);
        c.vx *= drag; c.vy *= drag;
        c.x += c.vx * dt; c.y += c.vy * dt;
        c.x = clamp(c.x, 0, WORLD_SIZE); c.y = clamp(c.y, 0, WORLD_SIZE);
      }
    }

    // collisions: eat food
    for(const p of state.players){
      for(const c of p.cells){
        const nearby = state.grid.query({x:c.x, y:c.y, r:c.r+8});
        for(const e of nearby){
          if(e instanceof Food){
            const rsum = c.r + e.r;
            if(dist2(c, e) <= rsum*rsum){
              // absorb
              c.r = Math.sqrt(c.r*c.r + e.r*e.r * 0.8);
              e._dead = true;
            }
          }
        }
      }
    }
    if(state.foods.length < FOOD_COUNT){
      for(let i=0;i<Math.min(30, FOOD_COUNT - state.foods.length); i++){
        const p = randomPoint();
        state.foods.push(new Food(p.x, p.y, rand(3,6), makeColor(Math.floor(rand(0,360)), 70, 60)));
      }
    }
    state.foods = state.foods.filter(f=>!f._dead);

    // cell vs virus
    for(const p of state.players){
      for(const c of p.cells){
        for(const v of state.viruses){
          const rsum = c.r + v.r;
          if(dist2(c, v) <= rsum*rsum && c.r > v.r*1.12){
            // explode into many
            const pieces = Math.min(8, MAX_CELLS_PER_PLAYER - p.cells.length);
            if(pieces>0){
              const eachR = Math.sqrt(c.r*c.r / (pieces+1));
              c.r = eachR;
              for(let k=0;k<pieces;k++){
                const ang = rand(0, Math.PI*2);
                const nx = clamp(c.x + Math.cos(ang)*(eachR*2+8), 0, WORLD_SIZE);
                const ny = clamp(c.y + Math.sin(ang)*(eachR*2+8), 0, WORLD_SIZE);
                const child = new Cell(p.id, p.name, nx, ny, eachR, p.color, p.isBot);
                child.vx = Math.cos(ang)*rand(20,34);
                child.vy = Math.sin(ang)*rand(20,34);
                const t = now(); child.mergeAt = t + MERGE_DELAY_MS;
                p.cells.push(child);
              }
            }
          }
        }
      }
    }

    // cell vs cell: eat smaller if sufficiently larger
    for(const pa of state.players){
      for(const ca of pa.cells){
        const nearby = state.grid.query({x:ca.x, y:ca.y, r:ca.r*1.2});
        for(const other of nearby){
          if(!(other instanceof Cell) || other===ca) continue;
          if(other.id === ca.id){
            // same owner: soft separation + merge after delay
            if(now() > Math.max(other.mergeAt, ca.mergeAt)){
              // attempt merge if overlapping
              const rsum = ca.r + other.r;
              if(dist2(ca, other) < (rsum*rsum)*0.9){
                // merge smaller into larger
                let a = ca, b = other;
                if(b.r > a.r){ const tmp=a; a=b; b=tmp; }
                a.r = Math.sqrt(a.r*a.r + b.r*b.r);
                b._dead = true;
              }
            } else {
              // repel a bit
              const dx = other.x - ca.x, dy = other.y - ca.y; const d = Math.hypot(dx,dy)||1;
              if(d < (ca.r + other.r)){
                const push = (ca.r + other.r - d) * 0.02;
                ca.vx -= (dx/d)*push; ca.vy -= (dy/d)*push;
              }
            }
            continue;
          }
          // different owner: can eat if 10% larger and center within radius
          if(ca.r > other.r * 1.12){
            const rsum = ca.r; // need center inside eater radius
            if(dist2(ca, other) <= rsum*rsum){
              ca.r = Math.sqrt(ca.r*ca.r + other.r*other.r * 0.92);
              other._dead = true;
            }
          }
        }
      }
    }

    // cleanup dead cells and dead players
    for(const p of state.players){ p.cells = p.cells.filter(c=>!c._dead && c.r >= MIN_CELL_RADIUS); }
    for(const p of state.players){ if(p.cells.length===0) p.alive=false; }

    // respawn bots if dead
    for(const p of state.players){ if(p.isBot && !p.alive){ spawnPlayer(p); } }
  }

  // Rendering
  function drawBackground(){
    // grid
    ctx.save();
    ctx.translate(-state.cam.x, -state.cam.y);
    const step = 60;
    ctx.strokeStyle = 'rgba(120,140,255,0.15)';
    ctx.lineWidth = 1;
    for(let x=0;x<=WORLD_SIZE;x+=step){
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,WORLD_SIZE); ctx.stroke();
    }
    for(let y=0;y<=WORLD_SIZE;y+=step){
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(WORLD_SIZE,y); ctx.stroke();
    }
    // border
    ctx.strokeStyle = 'rgba(200,220,255,0.35)'; ctx.lineWidth = 4;
    ctx.strokeRect(0,0,WORLD_SIZE,WORLD_SIZE);
    ctx.restore();
  }

  function drawCircle(x,y,r,fill,stroke){
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2);
    if(fill){ ctx.fillStyle = fill; ctx.fill(); }
    if(stroke){ ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
  }

  function draw(){
    ctx.save();
    ctx.clearRect(0,0,W,H);
    ctx.scale(state.cam.scale, state.cam.scale);

    drawBackground();

    ctx.translate(-state.cam.x, -state.cam.y);

    // foods
    for(const f of state.foods){ drawCircle(f.x, f.y, f.r, f.color); }

    // viruses
    for(const v of state.viruses){
      // spiky circle
      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.fillStyle = v.color; ctx.strokeStyle = '#17b567';
      ctx.beginPath();
      const spikes = 16; const inner = v.r*0.82; const outer = v.r*1.02;
      for(let i=0;i<spikes;i++){
        const a1 = (i/spikes)*Math.PI*2;
        const a2 = ((i+0.5)/spikes)*Math.PI*2;
        if(i===0) ctx.moveTo(Math.cos(a1)*outer, Math.sin(a1)*outer);
        else ctx.lineTo(Math.cos(a1)*outer, Math.sin(a1)*outer);
        ctx.lineTo(Math.cos(a2)*inner, Math.sin(a2)*inner);
      }
      ctx.closePath(); ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }

    // cells
    const allCells = [];
    for(const p of state.players){ for(const c of p.cells) allCells.push({p,c}); }
    allCells.sort((a,b)=>a.c.r-b.c.r);

    for(const {p,c} of allCells){
      // soft shadow
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 16; ctx.shadowOffsetY = 6;
      drawCircle(c.x, c.y, c.r, p.color, 'rgba(255,255,255,0.25)');
      ctx.restore();

      // name
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `${Math.max(12, Math.min(36, c.r*0.6))}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.name, c.x, c.y);
    }

    ctx.restore();
  }

  // Leaderboard/UI
  function updateUI(){
    const entries = state.players.filter(p=>p.alive).map(p=>({
      name: p.name,
      mass: Math.round(Math.sqrt(p.totalMass()/Math.PI))
    })).sort((a,b)=>b.mass-a.mass).slice(0,10);

    leaderboardEl.innerHTML = '';
    entries.forEach((e, i) => {
      const li = document.createElement('li');
      li.textContent = `${i+1}. ${e.name} ? ${e.mass}`;
      leaderboardEl.appendChild(li);
    });

    if(state.me && state.me.alive){
      const myMass = Math.round(state.me.cells.reduce((s,c)=>s + c.r, 0));
      hudMass.textContent = String(myMass);
      hudCells.textContent = String(state.me.cells.length);
    } else {
      hudMass.textContent = '0';
      hudCells.textContent = '0';
    }
  }

  // Main loop
  function loop(){
    if(!state.running) return;
    const t = now();
    const dt = Math.min(0.05, (t - state.lastTime)/1000);
    state.lastTime = t;

    update(dt);
    updateCamera();
    draw();
    updateUI();

    // fps
    const fps = 1/dt; state.fpsSamples.push(fps); if(state.fpsSamples.length>20) state.fpsSamples.shift();
    const avg = state.fpsSamples.reduce((a,b)=>a+b,0)/state.fpsSamples.length; hudFps.textContent = String(Math.round(avg));

    requestAnimationFrame(loop);
  }

  // Play button
  playBtn.addEventListener('click', () => {
    startGame();
  });

  function startGame(){
    menu.classList.add('hidden');
    const name = (nicknameInput.value || 'player').slice(0, 15);
    initWorld();

    const color = makeColor(Math.floor(rand(0,360)), 70, 55);
    const me = new Player('me', name, color);
    state.players.push(me);
    state.me = me; spawnPlayer(me);

    state.running = true; state.lastTime = now();
    loop();
  }

  // Auto-focus nickname for quick start, Enter to play
  nicknameInput.value = 'guest'+Math.floor(Math.random()*1000);
  nicknameInput.addEventListener('keydown', (e) => { if(e.key==='Enter') startGame(); });

  // Start paused at menu
  state.running = false;
})();
