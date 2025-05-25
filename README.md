# Battle Arena - Multiplayer Game

A real-time multiplayer battle arena game built with Socket.IO, Express, and HTML5 Canvas.

## Features

- 🎮 Real-time multiplayer gameplay
- ⚔️ Melee combat system
- 🏃 Smooth player movement with WASD
- 💚 Health system and respawning
- 🎯 Visual effects and animations
- 📊 Kill/death statistics

## Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Open your browser to `http://localhost:3000`

## Deployment to Render.com

1. **Connect your GitHub repo** to Render.com
2. **Create a new Web Service** with these settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
3. **Add Environment Variable**:
   - `NODE_ENV` = `production`
4. **Deploy!**

The app will automatically detect if it's running in production and configure the Socket.IO connection accordingly.

## Game Controls

- **WASD** - Move your character
- **Mouse** - Aim your weapon
- **Click** or **Spacebar** - Attack
- **R** - Reload (future feature)

## Tech Stack

- **Backend**: Node.js, Express, Socket.IO
- **Frontend**: HTML5 Canvas, JavaScript
- **Deployment**: Render.com 