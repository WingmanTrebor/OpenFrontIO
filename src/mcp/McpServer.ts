import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GameStateCache } from "./GameStateCache.js";
import { IntentHandler } from "./IntentHandler.js";
import { GameWebSocketServer } from "./WebSocketServer.js";
import { ToolLogic } from "./tools/ToolLogic.js";

/**
 * McpServer exposes game data as Read-Only Resources to LLMs.
 */
export class McpServer {
  private server: Server;

  constructor(
    private gameCache: GameStateCache,
    private webSocketServer: GameWebSocketServer,
  ) {
    this.server = new Server(
      {
        name: "openfront-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    this.setupResourceHandlers();
    this.setupToolHandlers();
  }

  private setupResourceHandlers() {
    /**
     * List all available game resources.
     */
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: [
          {
            uri: "game://session",
            name: "Game Session Info",
            mimeType: "application/json",
            description:
              "Identifiers and configuration for the current game session",
          },
          {
            uri: "game://state",
            name: "Game State Snapshot",
            mimeType: "application/json",
            description:
              "Full snapshot of current players, units, and my player state",
          },
          {
            uri: "game://map/summary",
            name: "Map Summary",
            mimeType: "application/json",
            description:
              "Summary of tile ownership and bounding boxes for territories",
          },
        ],
      };
    });

    /**
     * Read a specific resource.
     */
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const { uri } = request.params;

        let data: any = null;

        switch (uri) {
          case "game://session":
            data = this.gameCache.getSession();
            break;
          case "game://state":
            data = this.gameCache.getCurrentState();
            break;
          case "game://map/summary":
            data = this.gameCache.getMapSummary();
            break;
          default:
            throw new Error(`Resource not found: ${uri}`);
        }

        // If cache is empty, return a waiting status
        const responseBody = data ?? { status: "waiting_for_connection" };

        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(responseBody, null, 2),
            },
          ],
        };
      },
    );
  }

  private setupToolHandlers() {
    /**
     * List all available game tools.
     */
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "game.get_player_actions",
            description: "Get available actions for a specific tile",
            inputSchema: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
              },
              required: ["x", "y"],
            },
          },
          {
            name: "game.send_intent",
            description: "Send a player action (intent) to the game",
            inputSchema: {
              type: "object",
              properties: {
                intent: { type: "object" },
              },
              required: ["intent"],
            },
          },
          {
            name: "game.set_attack_ratio",
            description: "Set the global attack ratio for the player",
            inputSchema: {
              type: "object",
              properties: {
                ratio: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["ratio"],
            },
          },
        ],
      };
    });

    /**
     * Handle tool calls.
     */
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case "game.get_player_actions": {
          const schema = z.object({ x: z.number(), y: z.number() });
          const { x, y } = schema.parse(args);

          const state = this.gameCache.getCurrentState();
          const map = this.gameCache.getMapSummary();

          if (!state || !map) {
            return {
              content: [
                {
                  type: "text",
                  text: "Game state or map summary not available",
                },
              ],
              isError: true,
            };
          }

          const tileRef = y * map.width + x;
          const actions = ToolLogic.getPlayerActions(
            state,
            this.gameCache,
            tileRef,
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(actions, null, 2),
              },
            ],
          };
        }

        case "game.send_intent": {
          const schema = z.object({ intent: z.record(z.string(), z.any()) });
          const { intent } = schema.parse(args);

          const validation = IntentHandler.validate(intent);
          if (!validation.valid) {
            return {
              content: [
                {
                  type: "text",
                  text: `Validation error: ${validation.error}`,
                },
              ],
              isError: true,
            };
          }

          const wrappedIntent = { type: "intent", data: intent };
          this.webSocketServer.broadcast(wrappedIntent);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "sent" }, null, 2),
              },
            ],
          };
        }

        case "game.set_attack_ratio": {
          const schema = z.object({ ratio: z.number() });
          const { ratio } = schema.parse(args);

          this.webSocketServer.broadcast({
            type: "set_attack_ratio",
            ratio,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ status: "sent" }, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Tool not found: ${name}`);
      }
    });
  }

  /**
   * Start the MCP server using Stdio transport.
   */
  public async connect(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MCP: Server started on stdio transport");
  }
}
