#!/usr/bin/env python3
import os
import subprocess
import sys

def main():
    # Render provides the required port in the 'PORT' env var (default 10000)
    render_port = os.environ.get("PORT", "10000")
    print(f"[*] Detected Render environment. Forcing port bindings to {render_port}...")

    # Set environment variables so node.py picks up Render's expected port if it respects ENV parsers
    os.environ["PORT"] = render_port
    os.environ["HOST"] = "0.0.0.0"

    # Launch your existing start pipeline or node process directly
    # This example launches your node process directly, satisfying Render's port listener requirement immediately
    cmd = ["python3", "node.py"]
    
    # If you need to keep your bash pipe (like printf "..." | bash start.sh), 
    # you can invoke it through bash while passing the environment:
    if len(sys.argv) > 1 and sys.argv[1] == "shell":
        cmd = ["bash", "start.sh"]

    process = subprocess.Popen(cmd)
    try:
        process.wait()
    except KeyboardInterrupt:
        process.terminate()

if __name__ == "__main__":
    main()
