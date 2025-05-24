const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: false
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});
const path = require('path');

// Serve static files
app.use(express.static(__dirname));

// Add CORS headers for all routes
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Health check endpoint for render.com
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Game state
const gameState = {
    players: new Map(),
    playerCount: 0
};

// Game settings
const MELEE_RANGE = 100;
const MELEE_DAMAGE = 25;
const MELEE_ANGLE = Math.PI / 3;
const RESPAWN_TIME = 3000;
const MAP_WIDTH = 1200;
const MAP_HEIGHT = 800;
const PLAYER_RADIUS = 20;

// Player colors
const PLAYER_COLORS = [
    '#00d4ff', '#7c3aed', '#ef4444', '#22c55e',
    '#f97316', '#eab308', '#ec4899', '#14b8a6'
];

let nextPlayerId = 1;

function getRandomColor() {
    return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

function getRandomSpawnPoint() {
    const margin = 100;
    return {
        x: margin + Math.random() * (MAP_WIDTH - 2 * margin),
        y: margin + Math.random() * (MAP_HEIGHT - 2 * margin)
    };
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('New player connected:', socket.id);

    // Create new player
    const spawn = getRandomSpawnPoint();
    const playerNumber = nextPlayerId++;
    
    const newPlayer = {
        id: socket.id,
        x: spawn.x,
        y: spawn.y,
        health: 100,
        maxHealth: 100,
        color: getRandomColor(),
        name: `Player ${playerNumber}`,
        angle: 0,
        direction: 1, // Add default direction (facing left)
        weaponAngle: 0, // Add default weapon angle
        kills: 0,
        lastActivity: Date.now()
    };

    console.log('Created new player:', newPlayer);

    // Add player to game state
    gameState.players.set(socket.id, newPlayer);
    gameState.playerCount = gameState.players.size;

    console.log('Current players:', Array.from(gameState.players.entries()));

    // Send initial game state
    const currentState = {
        players: Array.from(gameState.players.entries()).reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {}),
        playerCount: gameState.playerCount
    };
    
    console.log('Sending initial state:', currentState);
    socket.emit('gameState', currentState);
    io.emit('playerUpdate', {
        id: newPlayer.id,
        x: newPlayer.x,
        y: newPlayer.y,
        health: newPlayer.health,
        maxHealth: newPlayer.maxHealth,
        color: newPlayer.color,
        name: newPlayer.name,
        direction: newPlayer.direction,
        weaponAngle: newPlayer.weaponAngle || 0
    });
    io.emit('playerCountUpdate', gameState.playerCount);

    // Handle movement
    socket.on('move', (data) => {
        const player = gameState.players.get(socket.id);
        if (player && player.health > 0) {
            // Throttle movement updates - only process if enough time has passed
            const now = Date.now();
            const timeSinceLastUpdate = now - (player.lastMovementUpdate || 0);
            
            if (timeSinceLastUpdate >= 16) { // Increased to ~60 updates per second for smoother movement
                // Update server-side position (for hit detection, etc.)
                player.x = data.x;
                player.y = data.y;
                if (data.direction !== undefined) {
                    player.direction = data.direction;
                }
                if (data.weaponAngle !== undefined) {
                    player.weaponAngle = data.weaponAngle;
                }
                player.lastActivity = now;
                player.lastMovementUpdate = now;
                
                // IMPORTANT: Only broadcast to OTHER players, never back to sender
                // This prevents rubber banding completely
                socket.broadcast.emit('playerUpdate', {
                    id: socket.id,
                    x: player.x,
                    y: player.y,
                    direction: player.direction,
                    weaponAngle: player.weaponAngle,
                    health: player.health,
                    maxHealth: player.maxHealth,
                    color: player.color,
                    name: player.name
                });
            }
        }
    });

    // Handle attack
    socket.on('attack', (data) => {
        const attacker = gameState.players.get(socket.id);
        if (attacker && attacker.health > 0) {
            attacker.lastActivity = Date.now();
            
            for (const [playerId, player] of gameState.players.entries()) {
                if (player.health <= 0 || playerId === socket.id) continue;

                const dx = player.x - attacker.x;
                const dy = player.y - attacker.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                if (distance <= MELEE_RANGE) {
                    const angleToPlayer = Math.atan2(dy, dx);
                    let angleDiff = Math.abs(angleToPlayer - data.angle);
                    
                    // Normalize angle difference to handle wrapping (0-2π)
                    if (angleDiff > Math.PI) {
                        angleDiff = 2 * Math.PI - angleDiff;
                    }
                    
                    console.log('Attack check:', { 
                        attacker: socket.id, 
                        target: playerId, 
                        distance, 
                        angleToPlayer: angleToPlayer * 180 / Math.PI, 
                        attackAngle: data.angle * 180 / Math.PI, 
                        angleDiff: angleDiff * 180 / Math.PI, 
                        maxAngle: (MELEE_ANGLE / 2) * 180 / Math.PI 
                    });
                    
                    if (angleDiff <= MELEE_ANGLE / 2) {
                        player.health -= MELEE_DAMAGE;
                        io.emit('playerHit', { 
                            x: player.x, 
                            y: player.y,
                            playerId: playerId,
                            health: player.health
                        });

                        if (player.health <= 0) {
                            attacker.kills++;
                            io.emit('playerKilled', {
                                killer: attacker,
                                victim: player
                            });
                        }
                    }
                }
            }
        }
    });

    // Handle respawn
    socket.on('respawn', () => {
        const player = gameState.players.get(socket.id);
        if (player) {
            setTimeout(() => {
                if (gameState.players.has(socket.id)) {
                    const spawn = getRandomSpawnPoint();
                    player.x = spawn.x;
                    player.y = spawn.y;
                    player.health = player.maxHealth;
                    io.emit('playerRespawned', player);
                }
            }, RESPAWN_TIME);
        }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        if (gameState.players.has(socket.id)) {
            io.emit('playerLeft', socket.id);
            gameState.players.delete(socket.id);
            gameState.playerCount = gameState.players.size;
            io.emit('playerCountUpdate', gameState.playerCount);
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';

http.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📡 Socket.IO transports: websocket, polling`);
    if (process.env.NODE_ENV !== 'production') {
        console.log(`🎮 Local game available at: http://localhost:${PORT}`);
    }
}); 