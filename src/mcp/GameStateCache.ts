import { GameMapImpl } from "../core/game/GameMap.js";
import {
  GameUpdateType,
  GameUpdateViewData,
} from "../core/game/GameUpdates.js";
import {
  GameState,
  MapSummary,
  McpMapDataMessage,
  PlayerInfo,
  SessionInfo,
  TileData,
} from "./schema.js";

type BridgeMessage = {
  type: string;
  payload: any;
};

export class GameStateCache {
  private sessionInfo: SessionInfo | null = null;
  private currentGameState: GameState | null = null;
  private gameMap: GameMapImpl | null = null;
  private lastTick = -1;

  public update(message: BridgeMessage): void {
    const { type, payload } = message;

    switch (type) {
      case "session_info":
        console.error("CACHE: Received session info");
        this.sessionInfo = payload as SessionInfo;
        break;

      case "map_data":
        console.error("CACHE: Received map data");
        this.handleMapData(payload as McpMapDataMessage);
        break;

      case "game_update":
        this.handleGameUpdate(payload as GameUpdateViewData);
        break;

      default:
        console.warn(`CACHE: Unknown message type: ${type}`);
    }
  }

  private handleMapData(data: McpMapDataMessage): void {
    // Rehydrate GameMapImpl
    const terrainBuffer = new Uint8Array(data.terrain);
    this.gameMap = new GameMapImpl(
      data.width,
      data.height,
      terrainBuffer,
      data.numLandTiles,
    );
    console.error(
      `CACHE: Map initialized (${data.width}x${data.height}, ${data.numLandTiles} land tiles)`,
    );
  }

  private handleGameUpdate(update: GameUpdateViewData): void {
    // 1. Update Map State
    if (this.gameMap && update.packedTileUpdates) {
      // In JSON, BigUint64Array becomes string[]
      const packedUpdates = update.packedTileUpdates as unknown as string[];
      for (const updateStr of packedUpdates) {
        try {
          const val = BigInt(updateStr);
          this.gameMap.updateTile(val);
        } catch (e) {
          console.error("Failed to parse tile update:", updateStr, e);
        }
      }
    }

    // 2. Update Game State Snapshot
    // We map the raw GameUpdateViewData to our clean GameState schema
    // Note: In a real implementation, we would merge these updates into a persistent State object
    // For now, we construct a fresh snapshot based on what's available in the view data
    // tailored for the LLM.

    // If we haven't initialized state yet, do so.
    this.currentGameState ??= {
      tick: update.tick,
      myPlayer: {
        id: 0, // Placeholder
        clientID: "",
        name: "",
        gold: 0,
        troops: 0,
        tilesOwned: 0,
        isAlive: true,
        hasSpawned: false,
        allies: [],
        embargoes: [],
        targets: [],
        outgoingAttacks: [],
        incomingAttacks: [],
        outgoingAllianceRequests: [],
        alliances: [],
      },
      players: [],
      units: [],
      recentEvents: [],
    };

    this.currentGameState.tick = update.tick;
    this.lastTick = update.tick;

    // Process specific updates to refine the state
    // This is a simplified mapping. In a full implementation, we'd track entity life-cycles.
    // Here we rely on the fact that the client view sends full snapshots for some things
    // or we assume the LLM just needs the latest "visible" data.

    if (update.updates) {
      // Update Players
      const playerUpdates = update.updates[GameUpdateType.Player];
      if (playerUpdates) {
        this.currentGameState.players = playerUpdates.map((p: any) => {
          const info: PlayerInfo = {
            id: p.id as unknown as number,
            smallID: p.smallID,
            name: p.name,
            displayName: p.displayName,
            isAlive: p.isAlive,
            isDisconnected: p.isDisconnected,
            tilesOwned: p.tilesOwned,
            gold: Number(p.gold),
            troops: p.troops,
            isTraitor: p.isTraitor,
            team: p.team,
          };
          return info;
        });

        // Update MyPlayer
        if (this.sessionInfo?.clientID) {
          const myP = playerUpdates.find(
            (p: any) => p.clientID === this.sessionInfo!.clientID,
          );
          if (myP) {
            this.currentGameState.myPlayer = {
              id: myP.smallID,
              clientID: myP.clientID ?? "",
              name: myP.name,
              gold: Number(myP.gold),
              troops: myP.troops,
              tilesOwned: myP.tilesOwned,
              isAlive: myP.isAlive,
              hasSpawned: myP.hasSpawned,
              allies: myP.allies,
              embargoes: Array.from(myP.embargoes).map((id: any) => Number(id)),
              targets: myP.targets,
              outgoingAttacks: myP.outgoingAttacks.map((a: any) => ({
                id: a.id,
                targetID: a.targetID,
                troops: a.troops,
                retreating: a.retreating,
              })),
              incomingAttacks: myP.incomingAttacks.map((a: any) => ({
                id: a.id,
                targetID: a.targetID,
                troops: a.troops,
                retreating: a.retreating,
              })),
              outgoingAllianceRequests: (
                myP.outgoingAllianceRequests as any[]
              ).map((id: any) => Number(id)),
              alliances: myP.alliances.map((a: any) => ({
                otherPlayerID: Number(a.other),
                expiresAtTick: a.expiresAt,
                hasExtensionRequest: a.hasExtensionRequest,
              })),
            };
          }
        }
      }

      // Update Units
      const unitUpdates = update.updates[GameUpdateType.Unit];
      if (unitUpdates) {
        this.currentGameState.units = unitUpdates
          .filter((u: any) => u.isActive) // Only active units
          .map((u: any) => ({
            id: u.id,
            unitType: u.unitType,
            ownerID: u.ownerID,
            pos: u.pos,
            troops: u.troops,
            isActive: u.isActive,
            health: u.health,
            underConstruction: u.underConstruction,
            level: u.level,
            targetTile: u.targetTile,
            retreating: u.retreating,
          }));
      }
    }
  }

  public getSession(): SessionInfo | null {
    return this.sessionInfo;
  }

  public getCurrentState(): GameState | null {
    return this.currentGameState;
  }

  public getMapSummary(): MapSummary | null {
    if (!this.gameMap) {
      return null;
    }

    const territoryByPlayer: MapSummary["territoryByPlayer"] = {};

    // 1. Iterate all tiles to build bounding boxes and counts
    // This is O(N) where N is map size. For 400x200 map = 80k tiles. Fast enough in Node.
    this.gameMap.forEachTile((ref) => {
      // Must use this.gameMap because TS might think it's null inside callback
      const map = this.gameMap!;
      if (!map.hasOwner(ref)) return;

      const owner = map.ownerID(ref);
      if (!territoryByPlayer[owner]) {
        territoryByPlayer[owner] = {
          tileCount: 0,
          boundingBox: {
            minX: map.width(),
            minY: map.height(),
            maxX: 0,
            maxY: 0,
          },
        };
      }

      const entry = territoryByPlayer[owner];
      const x = map.x(ref);
      const y = map.y(ref);

      entry.tileCount++;
      if (x < entry.boundingBox.minX) entry.boundingBox.minX = x;
      if (x > entry.boundingBox.maxX) entry.boundingBox.maxX = x;
      if (y < entry.boundingBox.minY) entry.boundingBox.minY = y;
      if (y > entry.boundingBox.maxY) entry.boundingBox.maxY = y;
    });

    return {
      width: this.gameMap.width(),
      height: this.gameMap.height(),
      numLandTiles: this.gameMap.numLandTiles(),
      numWaterTiles:
        this.gameMap.width() * this.gameMap.height() -
        this.gameMap.numLandTiles(),
      territoryByPlayer,
      nations: [], // Populated if we passed nation metadata, but `McpMapDataMessage` didn't include it.
      // We can add nations to McpMapDataMessage later if needed.
    };
  }

  public getTileData(x: number, y: number): TileData | null {
    if (!this.gameMap || !this.gameMap.isValidCoord(x, y)) {
      return null;
    }
    const ref = this.gameMap.ref(x, y);
    return {
      ref,
      x,
      y,
      isLand: this.gameMap.isLand(ref),
      isWater: this.gameMap.isWater(ref),
      isShoreline: this.gameMap.isShoreline(ref),
      ownerID: this.gameMap.hasOwner(ref) ? this.gameMap.ownerID(ref) : null,
      hasFallout: this.gameMap.hasFallout(ref),
      isBorder: this.gameMap.isBorder(ref),
      hasDefenseBonus: this.gameMap.hasDefenseBonus(ref),
    };
  }
}
