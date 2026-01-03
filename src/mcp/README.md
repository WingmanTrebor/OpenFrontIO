# OpenFront MCP Server

This directory contains the Model Context Protocol (MCP) server for OpenFront. It allows AI models to interact with the live game state as a read-only resource.

## Architecture

1.  **Game Client (`src/client/McpBridge.ts`)**: When the game starts, a bridge is initialized in the browser. It attempts to connect to the MCP server via WebSockets.
2.  **WebSocket Server (`src/mcp/WebSocketServer.ts`)**: A Node.js server that listens for incoming game data (sessions, map data, and real-time updates).
3.  **GameStateCache (`src/mcp/GameStateCache.ts`)**: An in-memory cache that stores the latest game state, providing a unified view for MCP resource requests.
4.  **MCP Server (`src/mcp/McpServer.ts`)**: Implements the Model Context Protocol using the `@modelcontextprotocol/sdk`. It exposes the cached data via stdio.

## Setup & Running

### 1. Prerequisites

Ensure you have installed the project dependencies:

```bash
# In the project root
npm install
```

### 2. Build the MCP Server

The MCP server must be bundled before running because it shares code with the browser-based game core.

```bash
cd src/mcp
npm run build
```

### 3. Start the Game

Run the main game client. By default, it will attempt to connect to the MCP bridge on `ws://localhost:8765`.

```bash
# In the project root
npm run dev
```

_Note: Make sure to actually enter a game (e.g., Single Player -> Start Game) so the bridge has data to send._

### 4. Run the MCP Server

You can run the MCP server directly using:

```bash
cd src/mcp
npm start
```

The server communicates via `stdin`/`stdout`. All human-readable logs are redirected to `stderr` to avoid interfering with the JSON-RPC protocol.

## Available Resources

The server exposes the following URI schemes:

- **`game://session`**: Current session metadata (Game ID, Map Name, Difficulty, Pause state).
- **`game://state`**: Real-time game data including player scores, unit counts, territory percentages, and game ticks.
- **`game://map/summary`**: Static map information like dimensions and total tile counts.

## Development

- **Bundling**: We use `esbuild` to handle the complexity of importing TypeScript files from the `src/core` directory which are typically intended for the browser.
- **Logging**: Always use `console.error()` for logging in the MCP server. `console.log()` is reserved for MCP JSON-RPC messages and will crash the protocol if used for debugging.
- **Schema**: Resources are validated and typed using Zod schemas defined in `src/mcp/schema.ts`.
