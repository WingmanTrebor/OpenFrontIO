import { WebSocket, WebSocketServer as WSServer } from "ws";
import { GameStateCache } from "./GameStateCache.js";

export interface GameMessage {
  type: string;
  payload: any;
  [key: string]: any;
}

export class GameWebSocketServer {
  private wss: WSServer;
  private gameSocket: WebSocket | null = null;
  private onMessageCallback?: (message: GameMessage) => void;
  private onConnectionCallback?: () => void;
  private onDisconnectionCallback?: () => void;

  constructor(
    private gameCache: GameStateCache,
    port: number = 8765,
  ) {
    this.wss = new WSServer({ port, host: "localhost" });
    this.setupServer();
  }

  private setupServer(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      // Only allow one game connection at a time
      if (this.gameSocket) {
        console.error("MCP: Rejecting new game connection (already connected)");
        ws.close(1008, "Server already has an active game connection");
        return;
      }

      console.error("MCP: Game client connected");
      this.gameSocket = ws;

      // Set up message handler
      ws.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as GameMessage;

          // Update Game State Cache
          this.gameCache.update(message);

          if (this.onMessageCallback) {
            this.onMessageCallback(message);
          }
        } catch (error) {
          console.error("MCP: Failed to parse game message:", error);
        }
      });

      // Handle disconnection
      ws.on("close", () => {
        console.error("MCP: Game client disconnected");
        if (this.gameSocket === ws) {
          this.gameSocket = null;
          if (this.onDisconnectionCallback) {
            this.onDisconnectionCallback();
          }
        }
      });

      // Handle errors
      ws.on("error", (error) => {
        console.error("MCP: WebSocket error:", error);
      });

      // Notify that connection is established
      if (this.onConnectionCallback) {
        this.onConnectionCallback();
      }
    });

    this.wss.on("error", (error) => {
      console.error("MCP: WebSocket server error:", error);
    });
  }

  /**
   * Send a message to the connected game client
   */
  public broadcast(data: any): void {
    if (!this.gameSocket || this.gameSocket.readyState !== WebSocket.OPEN) {
      console.error("MCP: Cannot broadcast - no active game connection");
      return;
    }

    try {
      const message = JSON.stringify(data);
      this.gameSocket.send(message);
    } catch (error) {
      console.error("MCP: Failed to broadcast message:", error);
    }
  }

  /**
   * Check if a game client is currently connected
   */
  public isConnected(): boolean {
    return (
      this.gameSocket !== null && this.gameSocket.readyState === WebSocket.OPEN
    );
  }

  /**
   * Register callback for incoming game messages
   */
  public onMessage(callback: (message: GameMessage) => void): void {
    this.onMessageCallback = callback;
  }

  /**
   * Register callback for game connection
   */
  public onConnection(callback: () => void): void {
    this.onConnectionCallback = callback;
  }

  /**
   * Register callback for game disconnection
   */
  public onDisconnection(callback: () => void): void {
    this.onDisconnectionCallback = callback;
  }

  /**
   * Close the WebSocket server
   */
  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.gameSocket) {
        this.gameSocket.close();
        this.gameSocket = null;
      }

      this.wss.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get server port
   */
  public getPort(): number {
    const address = this.wss.address();
    if (typeof address === "object" && address !== null) {
      return address.port;
    }
    return 8765;
  }
}
