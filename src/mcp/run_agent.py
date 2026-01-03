#!/usr/bin/env python3
"""
OpenFrontIO MCP Agent - AI Player for OpenFrontIO

USAGE:
  1. Install dependencies: pip install openai
  2. Start a local LLM server (Ollama or KoboldCPP)
  3. Build the MCP server: cd src/mcp && npm run build
  4. Start the game: npm run dev (and begin a singleplayer match)
  5. Run this script: python src/mcp/run_agent.py

CONFIGURATION:
  - LLM_BASE_URL: Set to your local LLM endpoint
    * KoboldCPP: http://localhost:5001/v1 (default)
    * Ollama: http://localhost:11434/v1
  - MODEL_NAME: Your LLM model name (e.g., "llama3")
  - TURN_INTERVAL_SECONDS: Time between AI decisions

HOW IT WORKS:
  1. Starts the Node.js MCP server as a subprocess
  2. Waits for the game to connect via WebSocket
  3. Dynamically fetches available tools from the MCP server (tools/list)
  4. Enters a turn loop where it:
     - Reads game state (game://state resource)
     - Constructs a prompt with current game context
     - Queries the LLM with dynamically-fetched tool definitions
     - Executes any tool calls the LLM requests
  5. Tools are NEVER hardcoded - they're always fetched from the server,
     so updates to ToolLogic.ts or schemas automatically propagate.

NO API KEYS REQUIRED - This script only works with local LLMs.
"""

import subprocess
import json
import sys
import time
import threading
import queue
from typing import Dict, Any, Optional, List
from openai import OpenAI


# Configuration
LLM_BASE_URL = "http://localhost:11434/v1"  # http://localhost:5001/v1 for KoboldCPP, http://localhost:11434/v1 for Ollama
MODEL_NAME = "qwen3:4b"  # Model name for the LLM
TURN_INTERVAL_SECONDS = 5  # Time between AI turns


class MCPClient:
    """Client for communicating with the MCP server via JSON-RPC over stdio."""
    
    def __init__(self, server_process: subprocess.Popen):
        self.process = server_process
        self.request_id = 0
        self.stderr_queue = queue.Queue()
        
        # Start stderr reader thread
        self.stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self.stderr_thread.start()
    
    def _read_stderr(self):
        """Read stderr from the MCP server for logging."""
        for line in self.process.stderr:
            decoded = line.decode('utf-8').strip()
            self.stderr_queue.put(decoded)
            
            # Filter out noisy game update logs to keep console readable
            if any(noise in decoded for noise in [
                "Received game update",
                "Broadcasting game update",
                "Game state updated",
                "Tick:",
                "packedTileUpdates"
            ]):
                continue  # Skip noisy logs
            
            # Only print important messages
            print(f"[MCP Server] {decoded}", file=sys.stderr)
    
    def wait_for_connection(self, timeout: int = 30):
        """Wait for the 'Game connected successfully' message from the MCP server."""
        print("⏳ Waiting for game to connect to MCP server...")
        start_time = time.time()
        
        while time.time() - start_time < timeout:
            try:
                line = self.stderr_queue.get(timeout=0.1)
                if "Game connected successfully" in line:
                    print("✅ Game connected to MCP server!")
                    return True
            except queue.Empty:
                continue
        
        raise TimeoutError("Game failed to connect to MCP server within timeout")
    
    def send_request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Send a JSON-RPC request to the MCP server and return the result."""
        self.request_id += 1
        request = {
            "jsonrpc": "2.0",
            "id": self.request_id,
            "method": method,
            "params": params or {}
        }
        
        # Send request
        request_str = json.dumps(request) + "\n"
        self.process.stdin.write(request_str.encode('utf-8'))
        self.process.stdin.flush()
        
        # Read response
        response_line = self.process.stdout.readline()
        if not response_line:
            raise RuntimeError("MCP server closed stdout")
        
        response = json.loads(response_line.decode('utf-8'))
        
        if "error" in response:
            raise RuntimeError(f"MCP error: {response['error']}")
        
        return response.get("result")
    
    def list_resources(self) -> List[Dict[str, Any]]:
        """List all available resources."""
        result = self.send_request("resources/list")
        return result.get("resources", [])
    
    def read_resource(self, uri: str) -> str:
        """Read a resource by URI."""
        result = self.send_request("resources/read", {"uri": uri})
        contents = result.get("contents", [])
        if contents:
            return contents[0].get("text", "")
        return ""
    
    def list_tools(self) -> List[Dict[str, Any]]:
        """List all available tools."""
        result = self.send_request("tools/list")
        return result.get("tools", [])
    
    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Any:
        """Call a tool with the given arguments."""
        result = self.send_request("tools/call", {
            "name": name,
            "arguments": arguments
        })
        contents = result.get("content", [])
        if contents:
            text = contents[0].get("text", "")
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text
        return None


class GameAgent:
    """AI agent that plays OpenFrontIO using an LLM."""
    
    def __init__(self, mcp_client: MCPClient, llm_client: OpenAI):
        self.mcp = mcp_client
        self.llm = llm_client
        self.tools = []
        self.map_summary = None
        self.turn_count = 0
    
    def initialize(self):
        """Initialize the agent by fetching tools and map summary.
        
        IMPORTANT: Tools are dynamically fetched from the MCP server at runtime.
        This ensures that any changes to tool definitions in TypeScript code
        (ToolLogic.ts, schemas, etc.) are automatically reflected here without
        needing to update this Python script.
        """
        print("🔧 Initializing agent...")
        
        # Dynamically fetch available tools from MCP server
        # This happens at runtime, so tool definitions are never hardcoded
        self.tools = self.mcp.list_tools()
        print(f"📋 Dynamically loaded {len(self.tools)} tools from MCP server:")
        for tool in self.tools:
            print(f"   - {tool['name']}: {tool.get('description', 'No description')}")
        
        # Fetch map summary (only once)
        try:
            self.map_summary = self.mcp.read_resource("game://map/summary")
            print("🗺️  Map summary loaded")
        except Exception as e:
            print(f"⚠️  Could not load map summary: {e}")
    
    def get_game_state(self) -> Dict[str, Any]:
        """Fetch the current game state."""
        state_json = self.mcp.read_resource("game://state")
        return json.loads(state_json)
    
    def construct_prompt(self, game_state: Dict[str, Any]) -> str:
        """Construct a prompt for the LLM with current game state."""
        player_id = game_state.get("playerID", 0)
        tick = game_state.get("tick", 0)
        
        # Find player info
        player_info = None
        for player in game_state.get("players", []):
            if player.get("id") == player_id:
                player_info = player
                break
        
        if not player_info:
            return "You are playing OpenFrontIO. Could not find your player information."
        
        prompt = f"""You are playing OpenFrontIO, a strategy game.

**Game Tick:** {tick}
**Your Player ID:** {player_id}

**Your Status:**
- Alive: {player_info.get('isAlive', False)}
- Troops: {player_info.get('troops', 0)}
- Gold: {player_info.get('gold', 0)}
- Cities: {player_info.get('cities', 0)}
- Land: {player_info.get('land', 0)} tiles

**All Players:**
"""
        for p in game_state.get("players", []):
            you = " (YOU)" if p.get("id") == player_id else ""
            prompt += f"- Player {p.get('id')}{you}: {p.get('land', 0)} land, {p.get('troops', 0)} troops, {'Alive' if p.get('isAlive') else 'Dead'}\n"
        
        prompt += """\n**Instructions:**
Your goal is to expand your territory and eliminate opponents. You have access to three tools:
1. `game.get_player_actions` - Get available actions for a specific tile (x, y)
2. `game.send_intent` - Send an action intent to the game (build, attack, etc.)
3. `game.set_attack_ratio` - Set your attack ratio (0.0 to 1.0, ratio of troops to send in attacks)

Think strategically and make decisions to grow your empire. Use the tools to explore the map and take actions.
"""
        return prompt
    
    def convert_mcp_tools_to_openai_format(self) -> List[Dict[str, Any]]:
        """Convert MCP tool definitions to OpenAI function calling format.
        
        This conversion happens at runtime using the tools fetched from the MCP server.
        The schemas come directly from the TypeScript code, ensuring consistency.
        """
        openai_tools = []
        
        for tool in self.tools:
            # The inputSchema comes from the MCP server's tool definition
            # which is generated from the TypeScript Zod schemas
            openai_tool = {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get("inputSchema", {})
                }
            }
            openai_tools.append(openai_tool)
        
        return openai_tools
    
    def execute_turn(self):
        """Execute one AI turn."""
        self.turn_count += 1
        print(f"\n{'='*60}")
        print(f"🎮 Turn {self.turn_count}")
        print(f"{'='*60}")
        
        try:
            # Get current game state
            game_state = self.get_game_state()
            
            # Construct prompt
            prompt = self.construct_prompt(game_state)
            
            # Query LLM
            print("🤔 Thinking...")
            openai_tools = self.convert_mcp_tools_to_openai_format()
            
            response = self.llm.chat.completions.create(
                model=MODEL_NAME,
                messages=[
                    {"role": "system", "content": "You are an AI agent playing OpenFrontIO. Use the available tools to explore and take actions."},
                    {"role": "user", "content": prompt}
                ],
                tools=openai_tools if openai_tools else None,
                tool_choice="auto" if openai_tools else None,
                temperature=0.7
            )
            
            message = response.choices[0].message
            
            # Check if LLM wants to call tools
            if hasattr(message, 'tool_calls') and message.tool_calls:
                for tool_call in message.tool_calls:
                    function_name = tool_call.function.name
                    arguments = json.loads(tool_call.function.arguments)
                    
                    print(f"🤖 AI calling tool: {function_name}")
                    print(f"   Arguments: {json.dumps(arguments, indent=2)}")
                    
                    # Execute the tool
                    result = self.mcp.call_tool(function_name, arguments)
                    print(f"   Result: {json.dumps(result, indent=2)}")
            else:
                # LLM didn't call any tools, just responded
                print(f"💭 AI: {message.content}")
        
        except Exception as e:
            print(f"❌ Error during turn: {e}")
            import traceback
            traceback.print_exc()


def main():
    """Main entry point for the MCP agent."""
    print("🚀 Starting OpenFrontIO MCP Agent")
    print(f"🔗 LLM Base URL: {LLM_BASE_URL}")
    print(f"🤖 Model: {MODEL_NAME}")
    print()
    
    # Start MCP server
    print("▶️  Starting MCP server...")
    mcp_process = subprocess.Popen(
        ["node", "src/mcp/dist/index.js"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=0
    )
    
    try:
        # Create MCP client
        mcp_client = MCPClient(mcp_process)
        
        # Wait for game connection
        mcp_client.wait_for_connection()
        
        # Create LLM client (no API key needed for local LLMs)
        llm_client = OpenAI(
            base_url=LLM_BASE_URL,
            api_key="not-needed"  # Local LLMs don't require API keys
        )
        
        # Create game agent
        agent = GameAgent(mcp_client, llm_client)
        agent.initialize()
        
        print(f"\n🎯 Starting AI turn loop (every {TURN_INTERVAL_SECONDS} seconds)")
        print("   Press Ctrl+C to stop\n")
        
        # Main turn loop
        while True:
            agent.execute_turn()
            time.sleep(TURN_INTERVAL_SECONDS)
    
    except KeyboardInterrupt:
        print("\n\n⏹️  Stopping agent...")
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        # Clean shutdown
        print("🧹 Cleaning up...")
        mcp_process.terminate()
        try:
            mcp_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mcp_process.kill()
        print("👋 Goodbye!")


if __name__ == "__main__":
    main()
