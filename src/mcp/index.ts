#!/usr/bin/env node

import { GameWebSocketServer } from "./WebSocketServer.js";

async function main() {
  console.log("Starting OpenFront MCP Server...");

  // Create WebSocket server for game connection
  const wsServer = new GameWebSocketServer(8765);

  wsServer.onConnection(() => {
    console.log("MCP: Game connected successfully");
  });

  wsServer.onDisconnection(() => {
    console.log("MCP: Game disconnected");
  });

  wsServer.onMessage((message) => {
    console.log("MCP: Received message from game:", message.type);
    // TODO: Handle game messages (will be implemented in Phase 2)
  });

  console.log(`MCP Server listening on ws://localhost:${wsServer.getPort()}`);
  console.log("Waiting for game client to connect...");

  // Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down MCP Server...");
    await wsServer.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log("\nShutting down MCP Server...");
    await wsServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
