import { UnitType } from "../core/game/Game.js";

/**
 * Session metadata and identifiers.
 * Matches MCP-SPEC.md Section 4.1
 */
export interface SessionInfo {
  gameID: string;
  clientID: string;
  playerID: number;
  tick: number;
  isPaused: boolean;
  inSpawnPhase: boolean;
  config: {
    gameMap: string;
    gameMapSize: string;
    difficulty: string;
    gameType: string;
    gameMode: string;
    turnIntervalMs: number;
  };
}

/**
 * Static map data sent on connection.
 */
export interface McpMapDataMessage {
  type: "map_data";
  width: number;
  height: number;
  // Encoded like GameMapImpl:
  // low bits: magnitude (0-31)
  // bit 5: ocean
  // bit 6: shoreline
  // bit 7: land
  terrain: number[];
  numLandTiles: number;
}

/**
 * Information about a ground attack.
 */
export interface AttackInfo {
  id: string;
  targetID: number;
  troops: number;
  retreating: boolean;
}

/**
 * Information about an alliance.
 */
export interface AllianceInfo {
  otherPlayerID: number;
  expiresAtTick: number;
  hasExtensionRequest: boolean;
}

/**
 * Summary information for a player.
 */
export interface PlayerInfo {
  id: number;
  smallID: number;
  name: string;
  displayName: string;
  isAlive: boolean;
  isDisconnected: boolean;
  tilesOwned: number;
  gold: number;
  troops: number;
  isTraitor: boolean;
  team?: string;
}

/**
 * Detailed information about a unit or structure.
 */
export interface UnitInfo {
  id: number;
  unitType: UnitType | string;
  ownerID: number;
  pos: number; // TileRef
  troops: number;
  isActive: boolean;
  health?: number;
  underConstruction?: boolean;
  level: number;
  targetTile?: number; // For nukes
  retreating?: boolean; // For transports
}

/**
 * Represents a game event to be displayed.
 */
export interface GameEvent {
  tick: number;
  type: string;
  message: string;
  playerID?: number;
}

/**
 * Current player-visible game state snapshot.
 * Matches MCP-SPEC.md Section 4.2
 */
export interface GameState {
  tick: number;

  myPlayer: {
    id: number;
    clientID: string;
    name: string;
    gold: number;
    troops: number;
    tilesOwned: number;
    isAlive: boolean;
    hasSpawned: boolean;
    allies: number[]; // Allied player IDs
    embargoes: number[]; // Embargoed player IDs
    targets: number[]; // Targeted player IDs
    outgoingAttacks: AttackInfo[];
    incomingAttacks: AttackInfo[];
    outgoingAllianceRequests: number[];
    alliances: AllianceInfo[];
  };

  players: PlayerInfo[]; // All visible players
  units: UnitInfo[]; // All visible units

  recentEvents: GameEvent[]; // Last N display events
}

/**
 * Compressed terrain summary for token efficiency.
 * Matches MCP-SPEC.md Section 4.3
 */
export interface MapSummary {
  width: number;
  height: number;
  numLandTiles: number;
  numWaterTiles: number;

  // Ownership summary by player
  territoryByPlayer: {
    [playerID: number]: {
      tileCount: number;
      boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
    };
  };

  // Nations on map (for spawn reference)
  nations: {
    name: string;
    capitalTile: number;
  }[];
}

/**
 * Detailed tile information for query results.
 * Matches output of game.query_tiles in MCP-SPEC.md Section 5.1
 */
export interface TileData {
  ref: number;
  x: number;
  y: number;
  isLand: boolean;
  isWater: boolean;
  isShoreline: boolean;
  ownerID: number | null;
  hasFallout: boolean;
  isBorder: boolean;
  hasDefenseBonus: boolean;
}
