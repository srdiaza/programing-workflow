# Engram dependency

This workflow uses Engram as its persistent memory and lifecycle backend. The repository does not commit a platform-specific binary. Instead, `scripts/install-engram.sh` installs the pinned release for the host platform, verifies its SHA-256 checksum, and places it in `~/.local/bin` unless `ENGRAM_INSTALL_DIR` is set.

Pinned release: `1.20.0`

The installer registers Engram's stdio MCP server as:

```json
{
  "command": ["engram", "mcp", "--tools=agent"]
}
```

The workflow state tool also starts `engram serve` on the configured local HTTP endpoint when lifecycle state needs to be persisted. The SQLite data directory remains Engram's normal `~/.engram` location and is never committed to this repository.
