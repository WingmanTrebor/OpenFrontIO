#!/usr/bin/env node

import { GameStateCache } from "./GameStateCache.js";
import { McpServer } from "./McpServer.js";
import { GameWebSocketServer } from "./WebSocketServer.js";

async function main() {
  console.error("Starting OpenFront MCP Server...");

  // Initialize shared state cache
  const gameCache = new GameStateCache();

  // Create WebSocket server for game connection
  const wsServer = new GameWebSocketServer(gameCache, 8765);

  // Create MCP Server for LLM connection (Stdio)
  const mcpServer = new McpServer(gameCache, wsServer);
  await mcpServer.connect();

  wsServer.onConnection(() => {
    console.error("MCP: Game connected successfully via WebSocket");
  });

  wsServer.onDisconnection(() => {
    console.error("MCP: Game disconnected");
  });

  wsServer.onMessage((message) => {
    // For verification, we can still log some metadata,
    // but avoid spamming stdout as it's used for MCP communication
    console.error(`MCP: Received message of type: ${message.type}`);
  });

  console.error(`MCP Server listening on ws://localhost:${wsServer.getPort()}`);
  console.error("Waiting for game client to connect...");

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.error("\nShutting down MCP Server...");
    await wsServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("\nShutting down MCP Server...");
    await wsServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
