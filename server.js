const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    pingTimeout: 5000,
    pingInterval: 2000,
    connectTimeout: 5000,
    // Add rate limiting for connections
    connectionRateLimit: {
        windowMs: 10000,
        max: 2 // max 2 connections per IP per 10 seconds
    }
});
const path = require('path');

// Serve static files
app.use(express.static(__dirname));

// Track IP addresses and their connections
const ipConnections = new Map();
const MAX_CONNECTIONS_PER_IP = 3;

// Game state
const gameState = {
    players: new Map(),
    playerCount: 0
};

// Game settings
const MELEE_RANGE = 100;
const MELEE_DAMAGE = 50;
const MELEE_ANGLE = Math.PI / 2; // 90 degrees
const RESPAWN_TIME = 3000;
const MAP_WIDTH = 1200;
const MAP_HEIGHT = 800;
const PLAYER_RADIUS = 20;
const BULLET_RADIUS = 3;

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

function cleanupDisconnectedPlayers() {
    const connectedSockets = Array.from(io.sockets.sockets.keys());
    let cleanupCount = 0;

    for (const [playerId, player] of gameState.players.entries()) {
        if (!connectedSockets.includes(playerId)) {
            gameState.players.delete(playerId);
            cleanupCount++;
        }
    }

    if (cleanupCount > 0) {
        gameState.playerCount = gameState.players.size;
        io.emit('playerCountUpdate', gameState.playerCount);
        console.log(`Cleaned up ${cleanupCount} disconnected players`);
    }
}

// Periodic cleanup
setInterval(cleanupDisconnectedPlayers, 5000);

// Force cleanup all connections for an IP
function forceCleanupIP(clientIp) {
    const connections = ipConnections.get(clientIp);
    if (connections) {
        for (const socketId of connections) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                console.log(`Force cleaning up socket ${socketId} for IP ${clientIp}`);
                socket.disconnect(true);
            }
        }
        ipConnections.delete(clientIp);
    }
}

// Connection management
io.use(async (socket, next) => {
    const clientIp = socket.handshake.address;
    
    // Get or initialize connection count for this IP
    let connections = ipConnections.get(clientIp) || new Set();
    
    // Clean up any stale connections first
    for (const socketId of connections) {
        const existingSocket = io.sockets.sockets.get(socketId);
        if (!existingSocket || !existingSocket.connected) {
            console.log(`Cleaning up stale connection ${socketId} for IP ${clientIp}`);
            connections.delete(socketId);
            if (gameState.players.has(socketId)) {
                gameState.players.delete(socketId);
                gameState.playerCount = gameState.players.size;
            }
        }
    }
    
    // If still too many connections after cleanup, force cleanup all
    if (connections.size >= MAX_CONNECTIONS_PER_IP) {
        console.log(`Force cleaning all connections for IP ${clientIp}`);
        forceCleanupIP(clientIp);
        connections = new Set();
    }
    
    // Add this socket to the IP's connections
    connections.add(socket.id);
    ipConnections.set(clientIp, connections);
    
    // Clean up on disconnect
    socket.on('disconnect', () => {
        const connections = ipConnections.get(clientIp);
        if (connections) {
            connections.delete(socket.id);
            if (connections.size === 0) {
                ipConnections.delete(clientIp);
            }
        }
    });
    
    next();
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    const clientIp = socket.handshake.address;
    console.log(`New connection attempt - Socket ID: ${socket.id}, IP: ${clientIp}`);
    
    // Validate connection
    if (!socket.connected) {
        console.log('Invalid connection attempt rejected');
        socket.disconnect(true);
        return;
    }

    // Create new player with unique ID
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
        kills: 0,
        lastActivity: Date.now()
    };

    console.log('Creating new player:', newPlayer);

    // Check if this socket already has a player
    if (gameState.players.has(socket.id)) {
        console.log(`Duplicate connection attempt from socket ${socket.id}`);
        socket.disconnect(true);
        return;
    }

    gameState.players.set(socket.id, newPlayer);
    gameState.playerCount = gameState.players.size;

    console.log(`Player count after new connection: ${gameState.playerCount}`);
    console.log('Current players:', Array.from(gameState.players.keys()));

    // Send current game state to new player first
    const currentState = {
        players: Array.from(gameState.players.entries()).reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
        }, {}),
        playerCount: gameState.playerCount
    };
    
    console.log('Sending initial game state to new player:', currentState);
    socket.emit('gameState', currentState);

    // Then broadcast new player to all clients
    console.log('Broadcasting new player to all clients');
    io.emit('playerUpdate', newPlayer);
    io.emit('playerCountUpdate', gameState.playerCount);

    // Handle player movement
    socket.on('move', (data) => {
        const player = gameState.players.get(socket.id);
        if (player && player.health > 0) {
            // Validate movement
            const dx = data.x - player.x;
            const dy = data.y - player.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // More lenient speed validation
            const maxSpeed = 15; // Increased max speed
            const timeSinceLastUpdate = Date.now() - (player.lastActivity || Date.now());
            const allowedDistance = maxSpeed * (timeSinceLastUpdate / 1000) + 20; // Added buffer
            
            if (distance <= allowedDistance) {
                player.x = data.x;
                player.y = data.y;
                player.lastActivity = data.timestamp || Date.now();
                
                // Broadcast more frequently
                io.emit('playerUpdate', player);
            } else {
                // If movement is invalid, force client to correct position but with interpolation
                socket.emit('serverCorrection', {
                    x: player.x,
                    y: player.y,
                    timestamp: Date.now()
                });
            }
        }
    });

    // Handle shooting/attacking
    socket.on('attack', (data) => {
        const attacker = gameState.players.get(socket.id);
        if (attacker && attacker.health > 0) {
            attacker.lastActivity = Date.now();
            
            // Check for hit players in melee range and angle
            for (const [playerId, player] of gameState.players.entries()) {
                if (player.health <= 0 || playerId === socket.id) continue;

                const dx = player.x - attacker.x;
                const dy = player.y - attacker.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                // Check if player is in range
                if (distance <= MELEE_RANGE) {
                    // Check if player is within attack angle
                    const angleToPlayer = Math.atan2(dy, dx);
                    const angleDiff = Math.abs(angleToPlayer - data.angle);
                    
                    if (angleDiff <= MELEE_ANGLE / 2) {
                        // Hit detected
                        player.health -= MELEE_DAMAGE;
                        io.emit('playerHit', { 
                            x: player.x, 
                            y: player.y,
                            playerId: playerId,
                            health: player.health
                        });

                        // Check if player died
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

    // Handle player respawn
    socket.on('respawn', () => {
        const player = gameState.players.get(socket.id);
        if (player) {
            player.lastActivity = Date.now();
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

    // Handle ping (keep-alive)
    socket.on('ping', () => {
        const player = gameState.players.get(socket.id);
        if (player) {
            player.lastActivity = Date.now();
        }
    });

    // Enhanced disconnect handling
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id} from IP: ${clientIp}`);
        if (gameState.players.has(socket.id)) {
            io.emit('playerLeft', socket.id);
            gameState.players.delete(socket.id);
            gameState.playerCount = gameState.players.size;
            io.emit('playerCountUpdate', gameState.playerCount);
        }
        
        // Clean up IP tracking
        const connections = ipConnections.get(clientIp);
        if (connections) {
            connections.delete(socket.id);
            if (connections.size === 0) {
                ipConnections.delete(clientIp);
            }
        }
    });
});

// More frequent cleanup of inactive players
setInterval(() => {
    const now = Date.now();
    const inactivityTimeout = 15000; // 15 seconds
    let cleanupCount = 0;

    // Clean up stale IP connections first
    for (const [ip, connections] of ipConnections.entries()) {
        let hasValidConnection = false;
        for (const socketId of connections) {
            const socket = io.sockets.sockets.get(socketId);
            if (socket && socket.connected) {
                hasValidConnection = true;
            } else {
                connections.delete(socketId);
                if (gameState.players.has(socketId)) {
                    gameState.players.delete(socketId);
                }
            }
        }
        if (!hasValidConnection) {
            ipConnections.delete(ip);
        }
    }

    // Then clean up inactive players
    for (const [playerId, player] of gameState.players.entries()) {
        const socket = io.sockets.sockets.get(playerId);
        if (!socket || !socket.connected || (now - player.lastActivity > inactivityTimeout)) {
            console.log(`Cleaning up inactive/disconnected player: ${playerId}`);
            io.emit('playerLeft', playerId);
            gameState.players.delete(playerId);
            cleanupCount++;
        }
    }

    if (cleanupCount > 0) {
        gameState.playerCount = gameState.players.size;
        io.emit('playerCountUpdate', gameState.playerCount);
        console.log(`Cleaned up ${cleanupCount} inactive/disconnected players`);
    }
}, 5000);

// Game loop
setInterval(() => {
    const now = Date.now();
    
    // Remove inactive players
    for (const [playerId, player] of gameState.players.entries()) {
        if (now - player.lastActivity > 30000) { // 30 seconds timeout
            console.log(`Removing inactive player: ${playerId}`);
            gameState.players.delete(playerId);
            gameState.playerCount = gameState.players.size;
            io.emit('playerLeft', playerId);
            io.emit('playerCountUpdate', gameState.playerCount);
        }
    }
}, 16);

// Start server
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
}); 