import asyncio
import json
import subprocess
import sys
import threading
import time
import signal

def stream_reader(pipe, shutdown_event):
    """
    Reads from the pipe (MCP Server stdout) line by line,
    mimicking how an LLM or tool user would consume the JSON stream.
    """
    print("---------------------------------------------------------------")
    print("MCP Verification Client Started")
    print("Waiting for Game Connection on ws://localhost:8765 ...")
    print("---------------------------------------------------------------")

    while not shutdown_event.is_set():
        line = pipe.readline()
        if not line:
            break
        
        line_str = line.decode('utf-8').strip()
        if not line_str:
            continue
            
        # Try to parse as JSON
        try:
            message = json.loads(line_str)
            
            # Check for game update
            if message.get("type") == "GameUpdate":
                payload = message.get("payload", {})
                tick = payload.get("tick")
                print(f"✅ SUCCESS: Received Game Update! Tick: {tick}")
            elif message.get("type") == "session_info":
                 print(f"ℹ️  Session Info: {message.get('payload')}")
            else:
                # Log other JSON messages (unexpected but useful for debug)
                print(f"📩 Message: {line_str[:100]}...")
                
        except json.JSONDecodeError:
            # Not JSON, standard log output
            print(f"[LOG] {line_str}")

def main():
    # Platform-specific node command
    node_cmd = "node"
    if sys.platform == "win32":
        node_cmd = "node.exe"

    # Path to the compiled MCP server
    server_script = "src/mcp/dist/index.js"

    print(f"Launching MCP Server: {node_cmd} {server_script}")

    # Launch the Node.js MCP Server as a subprocess
    process = subprocess.Popen(
        [node_cmd, server_script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, # We might want to see stderr too
        stdin=subprocess.PIPE
    )

    shutdown_event = threading.Event()

    # Create a thread to read stdout non-blocking to the main thread
    stdout_thread = threading.Thread(target=stream_reader, args=(process.stdout, shutdown_event))
    stdout_thread.daemon = True
    stdout_thread.start()

    # Pass stderr to our stderr
    def stderr_reader():
        for line in process.stderr:
            sys.stderr.write(f"[MCP ERROR] {line.decode('utf-8')}")
    
    stderr_thread = threading.Thread(target=stderr_reader)
    stderr_thread.daemon = True
    stderr_thread.start()

    try:
        # Keep the main thread alive to handle Ctrl+C
        while process.poll() is None:
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nStopping MCP Server...")
        shutdown_event.set()
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        print("MCP Server Stopped.")

if __name__ == "__main__":
    main()
