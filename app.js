/**
 * Bit Stack V2 - Absolute Clean Implementation
 * Focus: State-Machine Integrity, Deterministic Sync, Robust Recovery.
 */

// --- 1. CORE CONFIG & MATTER.JS ---
const { Engine, Render, Runner, Bodies, Composite, Events, Body, Sleeping } = Matter;

const firebaseConfig = {
    apiKey: "AIzaSyCd4FdR5GV6V6OewX6fmRzI1ajOiFsvqf0",
    authDomain: "bitblok-f3a2f.firebaseapp.com",
    databaseURL: "https://bitblok-f3a2f-default-rtdb.firebaseio.com",
    projectId: "bitblok-f3a2f",
    storageBucket: "bitblok-f3a2f.firebasestorage.app",
    messagingSenderId: "355023222306",
    appId: "1:355023222306:web:1044508fc4201e0ecffc7b"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// --- 2. GLOBAL STATE ---
let currentUser = null;
let currentRoomId = null;
let amIHost = false;
let sessionSuffix = Math.random().toString(36).substr(2, 4);
let haveIUpdatedScore = false;
let lastLobbySpawn = 0;

// Local Game Object - Mirrors Firebase
const game = {
    status: 'LOBBY', // LOBBY, COUNTDOWN, PLAYING, GAMEOVER
    turn: null,
    turnStartTime: 0,
    settled: true,
    stackCount: 0,
    players: {},
    blocks: [] // { body, owner, id }
};

const WIDGET_TYPES = [
    { id: 'music', label: 'Music', color: '#ff2d55', mass: 1, width: 60 },
    { id: 'weather', label: 'Weather', color: '#5ac8fa', mass: 1.2, width: 120 },
    { id: 'calendar', label: 'Calendar', color: '#ff3b30', mass: 0.8, width: 60 },
    { id: 'photos', label: 'Photos', color: '#ffffff', mass: 1, width: 120 }
];

// --- 3. PHYSICS INITIALIZATION ---
let engine, render;
const canvas = document.getElementById('game-canvas');
const container = document.getElementById('game-container');

function initPhysics() {
    engine = Engine.create();
    engine.enableSleeping = true;

    render = Render.create({
        canvas: canvas,
        engine: engine,
        options: {
            width: container.clientWidth,
            height: container.clientHeight,
            wireframes: false,
            background: 'transparent'
        }
    });

    Render.run(render);

    // Deterministic 60FPS Update Loop
    function frame() {
        if (game.status === 'LOBBY' || game.status === 'PLAYING' || game.status === 'GAMEOVER') {
            // Adjust Gravity for zero-gravity lobby
            engine.world.gravity.y = (game.status === 'LOBBY') ? 0 : 1;

            Engine.update(engine, 1000 / 60);
            if (amIHost && game.status === 'PLAYING') checkHostSettlement();

            if (game.status === 'LOBBY') {
                updateLobbyContinuousPhysics();
            } else {
                updateTimerLogic();
                updateCameraFocus();
            }
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    setupGround();
    setupCollisionHandling();
}

function setupGround() {
    const ground = Bodies.rectangle(
        container.clientWidth / 2, container.clientHeight - 100,
        container.clientWidth * 0.6, 15,
        { isStatic: true, label: 'ground', chamfer: { radius: 8 }, render: { fillStyle: '#1d1d1f' } }
    );
    Composite.add(engine.world, [ground]);
}

function setupCollisionHandling() {
    Events.on(engine, 'collisionStart', () => {
        container.classList.add('shake');
        setTimeout(() => container.classList.remove('shake'), 400);
    });

    Events.on(engine, 'afterUpdate', () => {
        if (game.status !== 'PLAYING') return;
        game.blocks.forEach(item => {
            if (item.body.position.y > container.clientHeight + 50) {
                if (item.owner === currentUser.testUid) {
                    triggerGameOver(currentUser.testUid);
                }
            }
        });
    });
}

// --- 4. AUTH & LOBBY ENTRY ---
const createBtn = document.getElementById('create-btn');
const joinBtn = document.getElementById('join-btn');
createBtn.disabled = true;
joinBtn.disabled = true;
createBtn.innerText = "YÜKLENİYOR...";

auth.signOut().then(() => {
    auth.signInAnonymously().then(u => {
        currentUser = u.user;
        currentUser.testUid = currentUser.uid + "_" + sessionSuffix;
        initPhysics();
        spawnLobbyDecorations();

        // Enable buttons
        createBtn.disabled = false;
        joinBtn.disabled = false;
        createBtn.innerText = "Oda Kur";
        console.log("READY:", currentUser.testUid);
    }).catch(err => {
        alert("Bağlantı Hatası: " + err.message);
        createBtn.innerText = "Hata oluştu";
    });
});

document.getElementById('create-btn').onclick = () => {
    const name = (document.getElementById('player-name').value || "Oyuncu").trim();
    const code = Math.floor(10000 + Math.random() * 90000).toString();
    joinRoom(code, name, true);
};

document.getElementById('join-btn').onclick = () => {
    const name = (document.getElementById('player-name').value || "Oyuncu").trim();
    const code = document.getElementById('room-code-input').value;
    if (code.length !== 5) return alert("5 hane girin.");
    db.ref(`rooms/${code}`).once('value', s => {
        if (s.exists()) joinRoom(code, name, false);
        else alert("Oda bulunamadı.");
    });
}

// --- 5. ROOM LOGIC & SYNC ---
function joinRoom(roomId, name, host) {
    if (!currentUser) return alert("Hâlâ bağlanılıyor, lütfen bekleyin...");
    currentRoomId = roomId;
    amIHost = host;

    document.getElementById('lobby-ui').classList.add('hidden');
    document.getElementById('waiting-room').classList.remove('hidden');
    document.getElementById('room-id-display').innerText = `Oda: ${roomId}`;

    const playerRef = db.ref(`rooms/${roomId}/players/${currentUser.testUid}`);
    playerRef.set({ name, isHost: host, status: host ? 'ready' : 'waiting', rematch: false });
    playerRef.onDisconnect().remove();

    if (host) {
        db.ref(`rooms/${roomId}`).update({
            status: 'LOBBY',
            turn: null,
            settled: true,
            stackCount: 0,
            world: null,
            blocks: null
        });
    }

    db.ref(`rooms/${roomId}/players`).on('value', s => {
        game.players = s.val() || {};
        updateWaitingUI(game.players);
    });

    db.ref(`rooms/${roomId}`).on('value', s => {
        const data = s.val();
        if (!data) return;

        if (data.status === 'LOBBY' && game.status !== 'LOBBY') resetToLobby();
        if (data.status === 'COUNTDOWN' && (game.status === 'LOBBY' || game.status === 'GAMEOVER')) startCountdownUI();
        if (data.status === 'PLAYING' && game.status !== 'PLAYING') startPlayingPhase();
        if (data.status === 'GAMEOVER' && game.status !== 'GAMEOVER') handleGameOverSync(data.loser);

        game.status = data.status;
        game.turn = data.turn;
        game.turnStartTime = data.turnStartTime || 0;
        game.settled = data.settled !== undefined ? data.settled : true;
        game.stackCount = data.stackCount || 0;

        if (game.status === 'PLAYING') updateHUD();

        if (data.status === 'GAMEOVER' && amIHost) {
            const pArr = Object.values(game.players);
            if (pArr.length >= 2 && pArr.every(p => p.rematch)) {
                db.ref(`rooms/${roomId}`).update({
                    status: 'COUNTDOWN',
                    blocks: null,
                    world: null,
                    settled: true,
                    stackCount: 0
                });
                Object.keys(game.players).forEach(uid => db.ref(`rooms/${roomId}/players/${uid}/rematch`).set(false));
            }
        }
    });

    db.ref(`rooms/${roomId}/scores`).on('value', s => {
        const scores = s.val() || {};
        const sortedUids = Object.keys(game.players || {}).sort();
        if (sortedUids.length >= 2) {
            document.getElementById('score-p1').innerText = scores[sortedUids[0]] || 0;
            document.getElementById('score-p2').innerText = scores[sortedUids[1]] || 0;
        }
    });

    db.ref(`rooms/${roomId}/world`).on('value', s => {
        const world = s.val();
        if (!world || game.status !== 'PLAYING') return;
        game.blocks.forEach(b => {
            const snap = world[b.id];
            if (snap) {
                Body.setPosition(b.body, { x: snap.x, y: snap.y });
                Body.setAngle(b.body, snap.a);
                Body.setVelocity(b.body, { x: 0, y: 0 });
                Body.setAngularVelocity(b.body, 0);
                Sleeping.set(b.body, true);
            }
        });
    });
}

function leaveRoom() {
    if (!currentRoomId || !currentUser) return;

    // Stop listeners
    db.ref(`rooms/${currentRoomId}/players`).off();
    db.ref(`rooms/${currentRoomId}`).off();
    db.ref(`rooms/${currentRoomId}/scores`).off();
    db.ref(`rooms/${currentRoomId}/world`).off();
    db.ref(`rooms/${currentRoomId}/blocks`).off();

    // Remove self from player list
    db.ref(`rooms/${currentRoomId}/players/${currentUser.testUid}`).remove();

    // Local reset
    currentRoomId = null;
    amIHost = false;
    game.status = 'LOBBY';

    document.getElementById('waiting-room').classList.add('hidden');
    document.getElementById('game-hud').classList.add('hidden');
    document.getElementById('game-over').classList.add('hidden');
    document.getElementById('lobby-ui').classList.remove('hidden');

    resetToLobby();
}

// --- 6. PHASE TRANSITION FUNCTIONS ---
function resetToLobby() {
    clearPhysics();
    spawnLobbyDecorations();
    haveIUpdatedScore = false;
    document.getElementById('game-over').classList.add('hidden');
    document.getElementById('game-hud').classList.add('hidden');
    document.getElementById('restart-btn').innerText = "Tekrar Dene";
    document.getElementById('restart-btn').disabled = false;
}

function startCountdownUI() {
    clearPhysics();
    haveIUpdatedScore = false;
    document.getElementById('waiting-room').classList.add('hidden');
    document.getElementById('game-over').classList.add('hidden');
    document.getElementById('countdown-overlay').classList.remove('hidden');

    // Reset Rematch Button UI for the next time
    const btn = document.getElementById('restart-btn');
    btn.innerText = "Tekrar Dene";
    btn.disabled = false;

    let count = 3;
    document.getElementById('countdown-number').innerText = count;
    const interval = setInterval(() => {
        count--;
        if (count <= 0) {
            clearInterval(interval);
            document.getElementById('countdown-overlay').classList.add('hidden');
            if (amIHost) {
                db.ref(`rooms/${currentRoomId}`).update({
                    status: 'PLAYING',
                    turn: currentUser.testUid,
                    turnStartTime: Date.now(),
                    settled: true,
                    stackCount: 0
                });
            }
        } else {
            document.getElementById('countdown-number').innerText = count;
        }
    }, 1000);
}

function startPlayingPhase() {
    document.getElementById('game-hud').classList.remove('hidden');

    const blocksRef = db.ref(`rooms/${currentRoomId}/blocks`);
    blocksRef.off();
    blocksRef.on('child_added', s => {
        const d = s.val();
        if (d.owner !== currentUser.testUid) {
            spawnBlock(d.x, d.y, false, d.type, d.owner, s.key);
        }
    });

    canvas.onmousemove = (e) => {
        if (game.status !== 'PLAYING') return;
        const preview = document.getElementById('drop-preview');
        if (game.turn === currentUser.testUid && game.settled) {
            preview.classList.remove('hidden');
            preview.style.left = `${e.offsetX}px`;
        } else {
            preview.classList.add('hidden');
        }
    };

    canvas.onclick = (e) => {
        executeDrop(e.offsetX);
    };
}

// --- 7. ADVANCED: TIMER & CAMERA ---
function updateTimerLogic() {
    if (game.status !== 'PLAYING' || !game.turnStartTime) {
        document.getElementById('turn-timer-container').classList.add('hidden');
        return;
    }

    const elapsed = Date.now() - game.turnStartTime;
    const limit = 10000;
    const pct = Math.max(0, 100 - (elapsed / limit) * 100);

    const bar = document.getElementById('turn-timer-fill');
    const container = document.getElementById('turn-timer-container');

    container.classList.remove('hidden');
    bar.style.width = `${pct}%`;
    bar.className = pct < 30 ? 'warning' : 'safe';

    // Auto Drop (only for the active player to avoid double drops)
    if (elapsed >= limit && game.turn === currentUser.testUid && game.settled) {
        const randomX = 50 + Math.random() * (canvas.width - 100);
        executeDrop(randomX);
    }
}

function executeDrop(x) {
    if (game.status !== 'PLAYING' || !game.settled || game.turn !== currentUser.testUid) return;

    db.ref(`rooms/${currentRoomId}/settled`).set(false);
    document.getElementById('drop-preview').classList.add('hidden');

    const type = WIDGET_TYPES[Math.floor(Math.random() * WIDGET_TYPES.length)];
    spawnBlock(x, 140, true, type, currentUser.testUid);

    const uids = Object.keys(game.players).sort();
    const next = uids.find(uid => uid !== currentUser.testUid);
    if (next) {
        db.ref(`rooms/${currentRoomId}`).update({
            turn: next,
            turnStartTime: Date.now()
        });
    }
}

function updateCameraFocus() {
    if (game.blocks.length === 0) return;

    // Find the highest block (lowest Y)
    let minY = container.clientHeight;
    game.blocks.forEach(b => {
        if (b.body.position.y < minY) minY = b.body.position.y;
    });

    // If tower is high (less than 40% height remaining at top)
    const threshold = container.clientHeight * 0.4;
    const targetY = minY < threshold ? minY - 100 : 0;

    // Smoothly interpolate camera bounds if needed
    // For simplicity, we'll use Render.lookAt with a fixed width
    // or just adjust render.bounds
    if (minY < threshold) {
        const zoomWidth = container.clientWidth;
        const zoomHeight = container.clientHeight;

        // Push bounds up
        render.bounds.min.y = minY - 200;
        render.bounds.max.y = minY - 200 + zoomHeight;
    } else {
        render.bounds.min.y = 0;
        render.bounds.max.y = container.clientHeight;
    }
}
function checkHostSettlement() {
    if (game.blocks.length === 0) return;
    const moving = game.blocks.find(b => !b.body.isSleeping);
    const currentlySettled = !moving;

    if (game.settled !== currentlySettled) {
        db.ref(`rooms/${currentRoomId}/settled`).set(currentlySettled);
        if (currentlySettled) broadcastWorldState();
    }
}

function broadcastWorldState() {
    if (!amIHost || !currentRoomId) return;
    const world = {};
    game.blocks.forEach(b => {
        if (b.id) world[b.id] = { x: b.body.position.x, y: b.body.position.y, a: b.body.angle };
    });
    db.ref(`rooms/${currentRoomId}/world`).set(world);
}

// --- 8. HELPERS & HANDLERS ---
function spawnBlock(x, y, isMine, type, ownerId, syncId = null) {
    const block = Bodies.rectangle(x, y, type.width, 60, {
        chamfer: { radius: 14 },
        mass: type.mass,
        friction: 0.5,
        restitution: 0.1,
        render: { fillStyle: type.color, strokeStyle: 'rgba(0,0,0,0.1)', lineWidth: 2 }
    });
    Composite.add(engine.world, [block]);

    const id = syncId || (isMine ? db.ref(`rooms/${currentRoomId}/blocks`).push().key : null);
    game.blocks.push({ body: block, owner: ownerId, id: id });

    if (isMine) {
        db.ref(`rooms/${currentRoomId}/stackCount`).transaction(c => (c || 0) + 1);
        db.ref(`rooms/${currentRoomId}/blocks/${id}`).set({ x, y, owner: ownerId, type });
    }
}

function updateHUD() {
    const isMyTurn = game.turn === currentUser.testUid;
    const el = document.getElementById('turn-indicator');
    const txt = document.getElementById('turn-text');

    if (isMyTurn) {
        txt.innerText = game.settled ? "SIRA SENDE" : "BEKLENİYOR...";
        el.className = game.settled ? 'turn-indicator active' : 'turn-indicator waiting';
    } else {
        txt.innerText = "RAKİPTE...";
        el.className = 'turn-indicator waiting';
    }
    document.getElementById('stack-count').innerText = game.stackCount;
}

function triggerGameOver(loserUid) {
    if (game.status === 'GAMEOVER') return;
    db.ref(`rooms/${currentRoomId}`).update({
        status: 'GAMEOVER',
        loser: loserUid
    });
}

function handleGameOverSync(loserUid) {
    const isLoser = loserUid === currentUser.testUid;
    game.status = 'GAMEOVER'; // Direct set to prevent re-triggering logic
    document.getElementById('game-over').classList.remove('hidden');
    document.getElementById('result-text').innerText = isLoser ? "KAYBETTİN" : "KAZANDIN!";
    document.getElementById('result-text').style.color = isLoser ? "var(--ios-red)" : "var(--ios-green)";
    document.getElementById('reason-text').innerText = isLoser ? "Bloğu düşürdün!" : "Rakibin kuleyi devirdi.";

    if (amIHost && loserUid && !haveIUpdatedScore) {
        haveIUpdatedScore = true;
        const winnerUid = Object.keys(game.players).find(uid => uid !== loserUid);
        if (winnerUid) db.ref(`rooms/${currentRoomId}/scores/${winnerUid}`).transaction(c => (c || 0) + 1);
    }
}

function clearPhysics() {
    if (engine) Composite.clear(engine.world, false);
    setupGround();
    game.blocks = [];
    game.stackCount = 0;
    document.getElementById('stack-count').innerText = "0";
}

function updateWaitingUI(players) {
    const uids = Object.keys(players);
    ['p1', 'p2'].forEach((p, i) => {
        const slot = document.getElementById(`${p}-slot`);
        if (!slot) return;
        const uid = uids[i];
        if (uid) {
            const d = players[uid];
            slot.className = 'player-slot active' + (d.status === 'ready' ? ' ready' : '');
            slot.querySelector('.name').innerText = d.name + (uid === currentUser.testUid ? " (Sen)" : "");
            slot.querySelector('.status-tag').innerText = d.status === 'ready' ? "HAZIR" : "BEKLENİYOR";
        } else {
            slot.className = 'player-slot empty';
        }
    });

    const rb = document.getElementById('ready-btn');
    const sb = document.getElementById('start-btn');
    if (amIHost) {
        rb.classList.add('hidden');
        sb.classList.toggle('hidden', uids.length < 2 || !Object.values(players).every(p => p.status === 'ready'));
    } else {
        sb.classList.add('hidden');
        rb.classList.remove('hidden');
        if (players[currentUser.testUid]) rb.innerText = players[currentUser.testUid].status === 'ready' ? "Vazgeç" : "Hazır";
    }
}

// --- 9. BUTTON HANDLERS ---
document.getElementById('ready-btn').onclick = () => {
    const ref = db.ref(`rooms/${currentRoomId}/players/${currentUser.testUid}/status`);
    ref.once('value', s => ref.set(s.val() === 'ready' ? 'waiting' : 'ready'));
};

document.getElementById('start-btn').onclick = () => db.ref(`rooms/${currentRoomId}/status`).set('COUNTDOWN');

document.getElementById('restart-btn').onclick = () => {
    const btn = document.getElementById('restart-btn');
    btn.innerText = "BEKLENİYOR...";
    btn.disabled = true;
    db.ref(`rooms/${currentRoomId}/players/${currentUser.testUid}/rematch`).set(true);
};

const leaveBtn = document.getElementById('leave-btn');
if (leaveBtn) leaveBtn.onclick = leaveRoom;
document.getElementById('menu-btn').onclick = () => {
    document.body.classList.add('fade-out');
    setTimeout(() => location.reload(), 500);
};

window.onresize = () => {
    if (render && render.canvas) {
        render.canvas.width = container.clientWidth;
        render.canvas.height = container.clientHeight;
    }
};

function updateLobbyContinuousPhysics() {
    const now = Date.now();
    // Spawn floating blocks
    if (now - lastLobbySpawn > 2500 && Composite.allBodies(engine.world).length < 15) {
        lastLobbySpawn = now;
        const type = WIDGET_TYPES[Math.floor(Math.random() * WIDGET_TYPES.length)];
        const side = Math.random() > 0.5 ? -100 : container.clientWidth + 100;
        const x = side === -100 ? -100 : container.clientWidth + 100;
        const y = Math.random() * container.clientHeight;

        const block = Bodies.rectangle(x, y, type.width, 60, {
            chamfer: { radius: 14 },
            frictionAir: 0.01,
            isSensor: true,
            render: { fillStyle: type.color, opacity: 0.4 }
        });

        // Give slow floating velocity
        Body.setVelocity(block, {
            x: side === -100 ? (0.5 + Math.random()) : -(0.5 + Math.random()),
            y: (Math.random() - 0.5) * 0.5
        });
        Body.setAngularVelocity(block, (Math.random() - 0.5) * 0.01);

        Composite.add(engine.world, [block]);
    }

    // Recycle
    const allBodies = Composite.allBodies(engine.world);
    allBodies.forEach(b => {
        if (b.label === 'ground') return;
        if (b.position.y > container.clientHeight + 200 || b.position.y < -200 ||
            b.position.x < -200 || b.position.x > container.clientWidth + 200) {
            Composite.remove(engine.world, b);
        }
    });
}

function spawnLobbyDecorations() {
    if (game.status !== 'LOBBY') return;
    for (let i = 0; i < 8; i++) {
        const type = WIDGET_TYPES[Math.floor(Math.random() * WIDGET_TYPES.length)];
        const x = Math.random() * container.clientWidth;
        const y = Math.random() * container.clientHeight;
        const block = Bodies.rectangle(x, y, type.width, 60, {
            chamfer: { radius: 14 },
            frictionAir: 0.01,
            isSensor: true,
            render: { fillStyle: type.color, opacity: 0.3 }
        });
        Body.setVelocity(block, { x: (Math.random() - 0.5) * 1, y: (Math.random() - 0.5) * 1 });
        Body.setAngularVelocity(block, (Math.random() - 0.5) * 0.01);
        Composite.add(engine.world, [block]);
    }
}
