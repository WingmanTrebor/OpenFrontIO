import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { GameStateCache } from "./GameStateCache.js";

/**
 * McpServer exposes game data as Read-Only Resources to LLMs.
 */
export class McpServer {
  private server: Server;

  constructor(private gameCache: GameStateCache) {
    this.server = new Server(
      {
        name: "openfront-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {},
        },
      },
    );

    this.setupResourceHandlers();
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

  /**
   * Start the MCP server using Stdio transport.
   */
  public async connect(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MCP: Server started on stdio transport");
  }
}
