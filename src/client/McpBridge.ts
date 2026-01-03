import { EventBus } from "../core/EventBus";
import { Intent } from "../core/Schemas";
import { ErrorUpdate, GameUpdateViewData } from "../core/game/GameUpdates";
import { TerrainMapData } from "../core/game/TerrainMapLoader";
import { McpMapDataMessage, SessionInfo } from "../mcp/schema";
import { SetAttackRatioEvent } from "./InputHandler";
import { LocalServer } from "./LocalServer";

/**
 * Message types sent from Game Bridge to MCP Server
 */
interface BridgeToMcpMessage {
  type: "game_update" | "session_info" | "query_response" | "map_data";
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

interface McpSetAttackRatioMessage {
  type: "set_attack_ratio";
  ratio: number;
}

type McpToBridgeMessage =
  | McpIntentMessage
  | McpQueryMessage
  | McpSetAttackRatioMessage;

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
    private gameMap: TerrainMapData,
    private eventBus: EventBus,
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
        // Send static map data
        this.sendMapData();
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

    const startInfo = this.localServer.getGameStartInfo();
    if (!startInfo) {
      console.warn("McpBridge: GameStartInfo not yet available");
      return;
    }

    const sessionInfo: SessionInfo = {
      gameID: startInfo.gameID,
      clientID: this.clientID,
      playerID: 0, // In singleplayer, main player is usually 0, but will be refined by PlayerUpdate
      tick: 0,
      isPaused: false,
      inSpawnPhase: true,
      config: {
        gameMap: startInfo.config.gameMap,
        gameMapSize: startInfo.config.gameMapSize,
        difficulty: startInfo.config.difficulty,
        gameType: startInfo.config.gameType,
        gameMode: startInfo.config.gameMode,
        turnIntervalMs: Number((startInfo.config as any).turnIntervalMs) || 200,
      },
    };

    const message: BridgeToMcpMessage = {
      type: "session_info",
      payload: sessionInfo,
    };

    this.socket.send(
      JSON.stringify(message, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
  }

  /**
   * Serialize and send the static map data.
   */
  private sendMapData(): void {
    if (!this.socket || !this.isConnected) {
      return;
    }

    const gm = this.gameMap.gameMap;
    const width = gm.width();
    const height = gm.height();
    const terrain = new Array(width * height);

    // Reconstruct terrain format
    // Bits 0-4: magnitude (0-31)
    // Bit 5: ocean
    // Bit 6: shoreline
    // Bit 7: land
    gm.forEachTile((ref) => {
      let val = gm.magnitude(ref) & 0x1f;
      if (gm.isOcean(ref)) val |= 1 << 5;
      if (gm.isShoreline(ref)) val |= 1 << 6;
      if (gm.isLand(ref)) val |= 1 << 7;
      terrain[ref] = val;
    });

    const mapData: McpMapDataMessage = {
      type: "map_data",
      width,
      height,
      terrain,
      numLandTiles: gm.numLandTiles(),
    };

    const message: BridgeToMcpMessage = {
      type: "map_data",
      payload: mapData,
    };

    this.socket.send(JSON.stringify(message));
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

        case "set_attack_ratio":
          this.handleSetAttackRatio(message);
          break;

        default:
          console.warn("McpBridge: Unknown message type:", type);
      }
    } catch (error) {
      console.error("McpBridge: Failed to parse MCP message:", error);
    }
  }

  /**
   * Handle a set_attack_ratio message from the MCP server.
   */
  private handleSetAttackRatio(message: McpSetAttackRatioMessage): void {
    const ratio = Math.max(0, Math.min(1, message.ratio));
    console.log("McpBridge: Setting attack ratio to:", ratio);
    this.eventBus.emit(new SetAttackRatioEvent(ratio));
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
