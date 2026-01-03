# MCP Specification: OpenFront Single-Player LLM Control

## 1. Overview

This specification defines a Model Context Protocol (MCP) server that enables a local LLM (<30B parameters) to play OpenFront in single-player mode. The LLM observes exactly what a human player sees and can take the same actions a player can take.

### 1.1 Goals

- **Visibility parity**: LLM sees the same game state as a human player (map, units, players, resources, events)
- **Action parity**: LLM can perform any action available to a human player (attack, build, diplomacy, etc.)
- **Local-only**: All components run on the same machine; no external network dependencies
- **Extension-only**: No modifications to existing game code; only new additive modules

### 1.2 Constraints

- Single-player mode only
- LLM connects to an already-running game (no game lifecycle management)
- MCP server runs as a separate process from the game
- Optimized for small models with limited context windows

### 1.3 Non-Goals

- Multiplayer support
- Game startup/configuration control
- Access to hidden AI internals or server-only data
- Training or fine-tuning capabilities

---

## 2. Architecture

```
┌─────────────────┐                  ┌──────────────────────┐                  ┌─────────────────────┐
│                 │      stdio       │                      │    WebSocket     │                     │
│   Local LLM     │◄────────────────►│     MCP Server       │◄────────────────►│   OpenFront Game    │
│   (<30B params) │   (JSON-RPC)     │     (Node.js)        │   (localhost)    │   (Browser Client)  │
│                 │                  │   ** LISTENER **     │                  │   ** CONNECTS **    │
└─────────────────┘                  └──────────────────────┘                  └─────────────────────┘
                                            │
                                            │ Maintains:
                                            │ - Game state cache
                                            │ - Update stream
                                            │ - Intent queue
                                            │
```

### 2.1 Components

**MCP Server** (new, `src/mcp/`)
- Standalone Node.js process
- Implements MCP protocol over stdio (to LLM)
- **Hosts WebSocket server** on `ws://localhost:8765` (game connects to it)
- Caches game state for efficient queries
- Validates and forwards intents to game

**Game Bridge** (new, `src/client/McpBridge.ts`)
- Optional module loaded in single-player mode
- **Connects as WebSocket client** to MCP server on startup
- Forwards `GameUpdateViewData` from worker to MCP server
- Accepts intent submissions and injects them via existing EventBus
- Provides query responses for helper methods (playerActions, playerProfile, etc.)

> **Worker Integration:** `McpBridge` must subscribe to the `WorkerClient` message stream by registering an additional callback for `GameUpdateViewData` messages. It must **not** intercept or block messages—the existing callback that feeds the UI/renderer must continue to receive all updates normally. The bridge operates as an observer, copying update data to the MCP server without side effects on the primary data flow.

> **Note**: Browser JavaScript cannot open listening ports due to security sandboxing. The MCP Server (Node.js) must be the WebSocket listener; the browser game client connects to it.

### 2.2 Data Flow

1. **Game → MCP**: Bridge forwards `GameUpdateViewData` each tick via WebSocket
2. **MCP → LLM**: MCP converts updates to notifications or caches for resource queries
3. **LLM → MCP**: LLM calls MCP tools to query state or submit actions
4. **MCP → Game**: MCP sends intents to bridge, which emits them on EventBus

---

## 3. MCP Server Metadata

```json
{
  "name": "openfront-singleplayer",
  "version": "1.0.0",
  "description": "MCP server for LLM control of OpenFront single-player games",
  "capabilities": {
    "resources": true,
    "tools": true,
    "notifications": true
  }
}
```

---

## 4. MCP Resources

Resources provide read-only access to game state snapshots.

### 4.1 `game://session`

Session metadata and identifiers.

**Response Schema:**
```typescript
{
  gameID: string;           // Unique game identifier
  clientID: string;         // Local player's client ID
  playerID: number;         // Local player's numeric ID
  tick: number;             // Current game tick
  isPaused: boolean;        // Pause state
  inSpawnPhase: boolean;    // Whether spawn phase is active
  config: {
    gameMap: string;        // Map name (e.g., "World", "Europe")
    gameMapSize: string;    // "Small" | "Medium" | "Large"
    difficulty: string;     // AI difficulty
    gameType: string;       // Game type
    gameMode: string;       // Game mode
    turnIntervalMs: number; // Milliseconds per turn
  };
}
```

### 4.2 `game://state`

Current player-visible game state snapshot.

**Response Schema:**
```typescript
{
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
    allies: number[];           // Allied player IDs
    embargoes: number[];        // Embargoed player IDs
    targets: number[];          // Targeted player IDs
    outgoingAttacks: AttackInfo[];
    incomingAttacks: AttackInfo[];
    outgoingAllianceRequests: number[];
    alliances: AllianceInfo[];
  };

  players: PlayerInfo[];        // All visible players
  units: UnitInfo[];            // All visible units

  recentEvents: GameEvent[];    // Last N display events
}

// Supporting types
interface AttackInfo {
  id: string;
  targetID: number;
  troops: number;
  retreating: boolean;
}

interface AllianceInfo {
  otherPlayerID: number;
  expiresAtTick: number;
  hasExtensionRequest: boolean;
}

interface PlayerInfo {
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

interface UnitInfo {
  id: number;
  unitType: string;
  ownerID: number;
  pos: number;              // TileRef
  troops: number;
  isActive: boolean;
  health?: number;
  underConstruction?: boolean;
  level: number;
  targetTile?: number;      // For nukes
  retreating?: boolean;     // For transports
}

interface GameEvent {
  tick: number;
  type: string;
  message: string;
  playerID?: number;
}
```

### 4.3 `game://map/summary`

Compressed terrain summary for token efficiency.

**Response Schema:**
```typescript
{
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
```

---

## 5. MCP Tools

Tools enable queries and actions.

### 5.1 Query Tools

#### `game.get_player_actions`

Get available actions at a specific tile or general player actions.

**Input:**
```typescript
{
  x?: number;           // Tile X coordinate (optional)
  y?: number;           // Tile Y coordinate (optional)
}
```

**Output:**
```typescript
{
  canAttack: boolean;
  buildableUnits: {
    type: string;       // UnitType
    cost: number;
    canBuild: boolean;
    canUpgrade: number | false;  // Unit ID if upgradeable
  }[];
  canSendEmojiAllPlayers: boolean;
  canEmbargoAll: boolean;

  // If tile has owner (other than self)
  interaction?: {
    ownerID: number;
    ownerName: string;
    sharedBorder: boolean;
    canSendEmoji: boolean;
    canTarget: boolean;
    canSendAllianceRequest: boolean;
    canBreakAlliance: boolean;
    canDonateGold: boolean;
    canDonateTroops: boolean;
    canEmbargo: boolean;
    allianceExpiresAt?: number;
  };
}
```

#### `game.get_player_profile`

Get detailed profile for a specific player.

**Input:**
```typescript
{
  playerID: number;     // Target player's ID
}
```

**Output:**
```typescript
{
  id: number;
  name: string;
  displayName: string;
  isAlive: boolean;
  gold: number;
  troops: number;
  tilesOwned: number;
  relation: "allied" | "friendly" | "neutral" | "hostile" | "self";
  isTraitor: boolean;
  embargoed: boolean;
  allianceExpiry?: number;
}
```

#### `game.get_border_tiles`

Get player's border tiles (useful for attack planning).

**Input:**
```typescript
{
  playerID: number;     // Target player's ID
}
```

**Output:**
```typescript
{
  borderTiles: number[];  // Array of TileRefs
}
```

#### `game.query_tiles`

Query detailed information for specific tiles.

**Input:**
```typescript
{
  tiles: number[];        // Array of TileRefs to query
  // OR
  bbox?: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
}
```

**Output:**
```typescript
{
  tiles: {
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
  }[];
}
```

#### `game.get_transport_spawn`

Find best tile to spawn a transport ship for naval attack.

**Input:**
```typescript
{
  targetTile: number;   // TileRef of attack destination
}
```

**Output:**
```typescript
{
  spawnTile: number | false;  // TileRef or false if impossible
}
```

#### `game.get_attack_position`

Get average position of troops in an ongoing attack.

**Input:**
```typescript
{
  attackID: string;     // Attack identifier
}
```

**Output:**
```typescript
{
  x: number | null;
  y: number | null;
}
```

### 5.2 Action Tools

> **Schema Validation:** All intent payloads submitted via `game.send_intent` must strictly validate against the Zod schemas defined in `src/core/Schemas.ts`. The MCP server should import and use these schemas (e.g., `AttackIntentSchema`, `BuildUnitIntentSchema`) for validation before forwarding intents to the game. This ensures parity with the game client's validation logic.

#### `game.send_intent`

Submit a player action. Uses the same intent schema as the game UI.

**Input:**
```typescript
{
  intent: Intent;       // One of the intent types below
}
```

**Intent Types:**

```typescript
// Spawn at location (during spawn phase)
{ type: "spawn", tile: number }

// Ground attack
{ type: "attack", targetID: string | null, troops: number | null }

// Cancel ongoing attack
{ type: "cancel_attack", attackID: string }

// Naval/boat attack
{ type: "boat", targetID: string | null, troops: number, dst: number, src: number | null }

// Cancel boat attack
{ type: "cancel_boat", boatID: string }

// Build unit or structure
{ type: "build_unit", unit: UnitType, tile: number, rocketDirectionUp?: boolean }

// Upgrade existing structure
{ type: "upgrade_structure", unitID: number, unit: UnitType }

// Delete own unit
{ type: "delete_unit", unitID: number }

// Move warship patrol point
{ type: "move_warship", unitID: number, tile: number }

// Request alliance
{ type: "allianceRequest", recipient: string }

// Reply to alliance request
{ type: "allianceRequestReply", requestor: string, accept: boolean }

// Extend existing alliance
{ type: "allianceExtension", recipient: string }

// Break alliance (become traitor)
{ type: "breakAlliance", recipient: string }

// Target player (affects AI behavior)
{ type: "targetPlayer", target: string }

// Send emoji
{ type: "emoji", recipient: string | "__all__", emoji: number }

// Quick chat message
{ type: "quick_chat", key: string, recipient: string | "__all__" }

// Donate gold to ally
{ type: "donate_gold", recipient: string, gold: number }

// Donate troops to ally
{ type: "donate_troops", recipient: string, troops: number }

// Start/stop embargo
{ type: "embargo", targetID: string, action: "start" | "stop" }

// Embargo all nations
{ type: "embargo_all", action: "start" | "stop" }

// Toggle pause (if lobby creator)
{ type: "toggle_pause", paused: boolean }
```

**Output:**
```typescript
{
  accepted: boolean;
  error?: string;       // Error message if rejected
}
```

#### `game.set_attack_ratio`

Set the attack troop ratio (0.01 to 1.0). This mirrors the UI slider that controls what percentage of troops to send in attacks.

**Input:**
```typescript
{
  ratio: number;        // 0.01 to 1.0
}
```

**Output:**
```typescript
{
  ok: boolean;
  ratio: number;        // Confirmed ratio
}
```

---

## 6. MCP Notifications

Notifications are server-initiated messages pushed to the LLM.

### 6.1 `game.update`

Emitted each game tick with state changes.

**Payload:**
```typescript
{
  tick: number;

  // Only included if changed
  tileChanges?: {
    ref: number;
    ownerID: number | null;
    hasFallout: boolean;
  }[];

  unitChanges?: UnitInfo[];     // Changed/new units
  unitRemovals?: number[];      // Removed unit IDs

  playerChanges?: PlayerInfo[]; // Changed player states

  events?: GameEvent[];         // New display events

  allianceEvents?: {
    type: "request" | "accepted" | "rejected" | "broken" | "expired" | "extended";
    playerA: number;
    playerB: number;
  }[];

  isPaused?: boolean;
}
```

### 6.2 `game.connected`

Emitted when MCP server successfully connects to game.

**Payload:**
```typescript
{
  gameID: string;
  playerID: number;
  tick: number;
}
```

### 6.3 `game.disconnected`

Emitted when game connection is lost.

**Payload:**
```typescript
{
  reason: string;
}
```

### 6.4 `game.ended`

Emitted when game ends.

**Payload:**
```typescript
{
  winner: {
    type: "player" | "team" | "nation";
    id: number;
    name: string;
  };
  myResult: "won" | "lost" | "draw";
}
```

---

## 7. Token Efficiency Strategies

For small models with limited context windows:

### 7.1 Incremental Updates
- Use `game.update` notifications for deltas instead of polling full state
- Only request `game://state` when needed for comprehensive context

### 7.2 Compressed Map Data
- `game://map/summary` provides high-level overview
- Use `game.query_tiles` for specific areas of interest
- Territory bounding boxes help focus queries

### 7.3 Coordinate Normalization

Raw tile coordinates can be large (e.g., `x: 1450, y: 3200`) which wastes tokens and confuses small models. The MCP uses **TileRef** (a single integer encoding x,y) and provides utilities:

**TileRef Encoding:**
- TileRef = `y * mapWidth + x` (single integer vs two coordinates)
- Reduces token usage by ~50% for coordinate data
- All tools accept/return TileRef instead of separate x,y

**Sector-Based Queries:**
- `game://map/summary` includes territory bounding boxes
- Query tiles by bounding box instead of individual coordinates
- Example: "Query sector around player X's territory" vs listing 500 tiles

**Relative Positions:**
- Attack/unit updates include `pos` (current) and `lastPos` (previous)
- LLM can infer direction without global coordinates
- Border tiles are relative to player territory

### 7.4 Selective Data Fetching
- `game.get_player_actions` returns only actionable info for a tile
- Filter `game://state` response to exclude irrelevant players/units

### 7.5 Recommended LLM Loop

```
1. On connect: Read game://session, game://map/summary
2. On each game.update notification:
   a. Update internal state from delta
   b. If action needed:
      - Call game.get_player_actions for relevant tile(s)
      - Decide action based on available options
      - Call game.send_intent
3. Periodically: Read game://state for full context refresh
```

### 7.6 Payload Size Targets

| Resource/Tool | Target Size | Strategy |
|---------------|-------------|----------|
| `game://session` | <500 tokens | Static metadata only |
| `game://state` | <2000 tokens | Summarized player/unit lists |
| `game.update` | <300 tokens | Delta only, TileRef encoding |
| `game.get_player_actions` | <200 tokens | Single tile context |

---

## 8. UnitType Reference

The valid `UnitType` strings for the `build_unit` intent are defined in the `UnitType` enum in `src/core/game/Game.ts`.

**Implementation Requirement:** The MCP server must import the `UnitType` enum directly from `src/core/game/Game.ts` to ensure parity with the game. Do not hardcode unit type strings—always reference the source enum to automatically stay in sync with game updates.

```typescript
import { UnitType } from "../core/game/Game";

// Example: validate that a unit type string is valid
const isValidUnitType = (type: string): type is UnitType =>
  Object.values(UnitType).includes(type as UnitType);
```

**Unit Categories (for reference):**
- **Structures:** `City`, `DefensePost`, `Port`, `MissileSilo`, `SAMLauncher`, `Factory`
- **Naval:** `Warship`, `TransportShip` (alias: `Transport`), `TradeShip`
- **Nuclear:** `AtomBomb`, `HydrogenBomb`, `MIRV`
- **Internal (not player-buildable):** `Shell`, `SAMMissile`, `MIRVWarhead`, `Train`

---

## 9. Error Handling

### 9.1 Intent Validation Errors

```typescript
{
  accepted: false,
  error: "Cannot attack: no shared border with target"
}
```

Common errors:
- `"Player not spawned"` - Must spawn before other actions
- `"Insufficient gold"` - Not enough gold for action
- `"Insufficient troops"` - Not enough troops for attack
- `"No shared border"` - Cannot attack non-adjacent player
- `"Not allied"` - Cannot donate to non-ally
- `"On cooldown"` - Action rate-limited

### 9.2 Connection Errors

Bridge connection failures emit `game.disconnected` notification with reason.

---

## 10. Security Considerations

1. **Local-only binding**: Bridge WebSocket binds to `localhost` only
2. **No hidden data**: MCP exposes only player-visible game state
3. **Intent validation**: All intents validated against game rules before execution
4. **Single session**: One MCP connection per game instance
5. **Read-only terrain**: Map topology cannot be modified

---

## 11. Implementation Notes

### 11.1 New Files

```
src/mcp/
  ├── index.ts              # MCP server entry point (run separately)
  ├── McpServer.ts          # MCP protocol handler (stdio)
  ├── WebSocketServer.ts    # WebSocket listener for game connection
  ├── GameStateCache.ts     # Caches GameUpdateViewData
  ├── IntentHandler.ts      # Validates and queues intents
  └── tools/                # Tool implementations
      ├── getPlayerActions.ts
      ├── sendIntent.ts
      └── ...

src/client/
  └── McpBridge.ts          # WebSocket client in game browser
```

### 11.2 Single Entry Point Hook (Minimal Modification)

One existing file requires a small addition to initialize the bridge:

**File:** `src/client/ClientGameRunner.ts` (or similar game startup location)

**Change:** Add conditional initialization when MCP is enabled:
```typescript
// Near game startup, after WorkerClient is ready
if (window.OPENFRONT_MCP_ENABLED) {
  const bridge = new McpBridge(workerClient, eventBus, localServer);
  bridge.connect(); // Connects to MCP server's WebSocket
}
```

This is the **only modification** to existing code. The flag can be set via:
- URL parameter: `?mcp=true`
- Or injected by a browser extension / dev tools

### 11.3 Bridge Activation Flow

1. **User starts MCP server first** (separate terminal):
   ```bash
   node src/mcp/index.js
   # WebSocket server listening on ws://localhost:8765
   ```

2. **User starts game with MCP enabled**:
   ```
   http://localhost:5173/?mcp=true
   ```

3. **McpBridge connects as WebSocket client** to MCP server

4. **MCP server waits for LLM** to connect via stdio

### 11.4 Extension-Only Philosophy

Apart from the single entry point hook:
- All game logic remains unchanged
- Bridge only reads from existing streams (GameUpdateViewData)
- Bridge emits intents through existing EventBus patterns
- No new dependencies added to core game code

---

## 12. Example Session

```
LLM                           MCP Server                      Game
 │                                │                            │
 │──── resources/list ───────────►│                            │
 │◄─── [game://session, ...] ─────│                            │
 │                                │                            │
 │──── resources/read ───────────►│                            │
 │     game://session             │                            │
 │◄─── {gameID, playerID, ...} ───│                            │
 │                                │                            │
 │──── tools/call ───────────────►│                            │
 │     game.get_player_actions    │──── query ────────────────►│
 │     {x: 50, y: 30}             │◄─── PlayerActions ─────────│
 │◄─── {canAttack: true, ...} ────│                            │
 │                                │                            │
 │──── tools/call ───────────────►│                            │
 │     game.send_intent           │──── emit intent ──────────►│
 │     {type: "attack", ...}      │◄─── ack ───────────────────│
 │◄─── {accepted: true} ──────────│                            │
 │                                │                            │
 │                                │◄─── GameUpdateViewData ────│
 │◄─── notification ──────────────│                            │
 │     game.update                │                            │
 │     {tick: 101, ...}           │                            │
 │                                │                            │
```

---

## 13. Glossary

| Term | Definition |
|------|------------|
| **TileRef** | Numeric tile identifier (encoded x,y position) |
| **PlayerID** | Numeric player identifier within a game |
| **ClientID** | String identifier for a connected client |
| **Intent** | Player action submitted for next turn execution |
| **Tick** | Game simulation step (multiple ticks per turn) |
| **SmallID** | Compact player identifier used in some APIs |
