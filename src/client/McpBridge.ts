import { Intent } from "../core/Schemas";
import { ErrorUpdate, GameUpdateViewData } from "../core/game/GameUpdates";
import { LocalServer } from "./LocalServer";

/**
 * Message types sent from Game Bridge to MCP Server
 */
interface BridgeToMcpMessage {
  type: "game_update" | "session_info" | "query_response";
  payload: unknown;
}

/**
 * Message types received from MCP Server
 */
interface McpIntentMessage {
  type: "intent";
  intent: Intent;
}

interface McpQueryMessage {
  type: "query";
  id: string;
  payload: unknown;
}

type McpToBridgeMessage = McpIntentMessage | McpQueryMessage;

/**
 * McpBridge connects the browser game client to the MCP server.
 *
 * It operates as an observer of the WorkerClient's GameUpdateViewData stream,
 * forwarding updates to the MCP server without intercepting or blocking
 * messages destined for the UI renderer.
 *
 * It also receives intents from the MCP server (originating from an LLM)
 * and submits them to the game via the LocalServer.
 */
export class McpBridge {
  private socket: WebSocket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(
    private localServer: LocalServer,
    private clientID: string,
  ) {}

  /**
   * Connect to the MCP server and set up message handling.
   */
  public connect(): void {
    console.log("McpBridge: Connecting to MCP server...");

    try {
      this.socket = new WebSocket("ws://localhost:8765");

      this.socket.onopen = () => {
        console.log("McpBridge: Connected to MCP server");
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Send initial session info
        this.sendSessionInfo();
      };

      this.socket.onmessage = (event: MessageEvent) => {
        this.handleMcpMessage(event.data);
      };

      this.socket.onclose = (event: CloseEvent) => {
        console.log(
          `McpBridge: Disconnected from MCP server (code: ${event.code})`,
        );
        this.isConnected = false;
        this.attemptReconnect();
      };

      this.socket.onerror = (error) => {
        console.error("McpBridge: WebSocket error:", error);
      };
    } catch (error) {
      console.error("McpBridge: Failed to connect:", error);
      this.attemptReconnect();
    }
  }

  /**
   * Wrap the original game update callback to observe updates.
   * This method returns a new callback that:
   * 1. Forwards the update to the MCP server
   * 2. Calls the original callback (preserving UI functionality)
   */
  public wrapGameUpdateCallback(
    originalCallback: (update: GameUpdateViewData | ErrorUpdate) => void,
  ): (update: GameUpdateViewData | ErrorUpdate) => void {
    return (update: GameUpdateViewData | ErrorUpdate) => {
      // First, forward to MCP server (non-blocking)
      this.forwardGameUpdate(update);

      // Then, call the original callback to preserve UI functionality
      originalCallback(update);
    };
  }

  /**
   * Forward a GameUpdateViewData to the MCP server.
   */
  private forwardGameUpdate(update: GameUpdateViewData | ErrorUpdate): void {
    if (!this.isConnected || !this.socket) {
      return;
    }

    // Don't forward error updates to MCP - those are client-side issues
    if ("errMsg" in update) {
      return;
    }

    try {
      // Serialize the update, handling BigUint64Array specially
      const serializedUpdate = this.serializeGameUpdate(update);

      const message: BridgeToMcpMessage = {
        type: "game_update",
        payload: serializedUpdate,
      };

      this.socket.send(
        JSON.stringify(message, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
    } catch (error) {
      console.error("McpBridge: Failed to forward game update:", error);
    }
  }

  /**
   * Serialize GameUpdateViewData for transmission.
   * Handles BigUint64Array conversion since JSON doesn't support typed arrays.
   */
  private serializeGameUpdate(
    update: GameUpdateViewData,
  ): Record<string, unknown> {
    return {
      tick: update.tick,
      updates: update.updates,
      // Convert BigUint64Array to array of strings (bigints as strings)
      packedTileUpdates: Array.from(update.packedTileUpdates).map((v) =>
        v.toString(),
      ),
      playerNameViewData: update.playerNameViewData,
      tickExecutionDuration: update.tickExecutionDuration,
    };
  }

  /**
   * Send initial session information to the MCP server.
   */
  private sendSessionInfo(): void {
    if (!this.socket || !this.isConnected) {
      return;
    }

    const message: BridgeToMcpMessage = {
      type: "session_info",
      payload: {
        clientID: this.clientID,
        timestamp: Date.now(),
      },
    };

    this.socket.send(
      JSON.stringify(message, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  }

  /**
   * Handle incoming messages from the MCP server.
   */
  private handleMcpMessage(data: string): void {
    try {
      const message = JSON.parse(data) as McpToBridgeMessage;

      const { type } = message;
      switch (type) {
        case "intent":
          this.handleIntentMessage(message);
          break;

        case "query":
          // TODO: Handle query messages in Phase 2
          console.log("McpBridge: Received query (not yet implemented)");
          break;

        default:
          console.warn("McpBridge: Unknown message type:", type);
      }
    } catch (error) {
      console.error("McpBridge: Failed to parse MCP message:", error);
    }
  }

  /**
   * Handle an intent message from the MCP server.
   * Submits the intent to the game via LocalServer.
   */
  private handleIntentMessage(message: McpIntentMessage): void {
    const intent = message.intent;

    // Ensure the intent has the correct clientID
    const intentWithClientID = {
      ...intent,
      clientID: this.clientID,
    };

    console.log("McpBridge: Submitting intent from LLM:", intent.type);

    // Submit to LocalServer (single-player mode)
    this.localServer.onMessage({
      type: "intent",
      intent: intentWithClientID,
    });
  }

  /**
   * Attempt to reconnect to the MCP server with exponential backoff.
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("McpBridge: Max reconnection attempts reached, giving up");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(
      `McpBridge: Attempting reconnection in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    setTimeout(() => {
      if (!this.isConnected) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Disconnect from the MCP server.
   */
  public disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isConnected = false;
  }

  /**
   * Check if the bridge is currently connected to the MCP server.
   */
  public get connected(): boolean {
    return this.isConnected;
  }
}
