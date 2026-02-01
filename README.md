# CodeQL LSP MCP Server

A Model Context Protocol (MCP) server that wraps the CodeQL Language Server Protocol (LSP) to enable LLM agents to write CodeQL queries with intelligent code completion, hover information, and other language features. This server reuses key concepts from the VS Code CodeQL extension to provide a robust language server interface. This is different from a MCP server that wraps the CodeQL CLI tool. However, you can also add CodeQL CLI commands to the server too. 
- [Installation](#installation)
- [Tools](#available-tools)
- [Contributing](#contributing)
- [Citation](#citation)

## Installation

### 1. Prerequisites

- CodeQL CLI installed and available in PATH or set `CODEQL_PATH` environment variable
- Node.js 18 or later

### 2. Build  

```bash
cd codeql-lsp-mcp 
npm install
npm run build
```

### 3. Add MCP Configuration

Add to your MCP client configuration:

```json
 {
    "mcpServers": {
      "codeql": {
        "command": "node",
        "args": ["/path/to/codeql-lsp-mcp/dist/index.js"], 
      }
    }
  }
```

```toml
[mcp_servers.codeql]
command = "node"
args = ["/home/path-to/codeql-lsp-mcp/dist/index.js"]
```

## Tools

### 1. `codeql_open_file`
Open a CodeQL file in the language server.

```json
{
  "tool": "codeql_open_file",
  "arguments": {
    "file_uri": "file:///workspace/query.ql",
    "content": "import javascript\n\nfrom Function f\nwhere f.getName() = \"eval\"\nselect f"
  }
}
```

### 2. `codeql_complete`
Get code completions at a specific position.

```json
{
  "tool": "codeql_complete",
  "arguments": {
    "file_uri": "file:///workspace/query.ql",
    "line": 2,
    "character": 5,
    "trigger_character": "."
  }
}
```

### 3. `codeql_hover`
Get hover information (documentation) at a position.

```json
{
  "tool": "codeql_hover",
  "arguments": {
    "file_uri": "file:///workspace/query.ql",
    "line": 1,
    "character": 7
  }
}
```

### 4. `codeql_definition`
Go to definition for a symbol.

```json
{
  "tool": "codeql_definition",
  "arguments": {
    "file_uri": "file:///workspace/query.ql",
    "line": 3,
    "character": 10
  }
}
```

### 5. `codeql_diagnostics`
Get diagnostics (errors, warnings) for a file.

```json
{
  "tool": "codeql_diagnostics",
  "arguments": {
    "file_uri": "file:///workspace/query.ql"
  }
}
```

### 6. `codeql_format`
Format a CodeQL file or selection.

```json
{
  "tool": "codeql_format",
  "arguments": {
    "file_uri": "file:///workspace/query.ql",
    "range": {
      "start": { "line": 0, "character": 0 },
      "end": { "line": 10, "character": 0 }
    }
  }
}
```

### 7. `codeql_references`
Find all references to a symbol at a specific position.

```json
{
  "tool": "codeql_references",
  "arguments": {
    "file_uri": "file:///workspace/query.ql",
    "line": 3,
    "character": 10
  }
}
```

### 8. `codeql_update_file`
Update the content of an open file.

```json
{
  "tool": "codeql_update_file",
  "arguments": {
    "file_uri": "file:///workspace/query.ql",
    "content": "import javascript\n\nfrom Function f\nwhere f.getName() = \"eval\"\nselect f, \"Dangerous eval usage\""
  }
}
```

### 9. `codeql_set_workspace`
Set workspace folders for better CodeQL analysis.

```json
{
  "tool": "codeql_set_workspace",
  "arguments": {
    "folders": ["/path/to/codeql/libraries", "/path/to/project"]
  }
}
```

### 10. `codeql_compile`
Compile a CodeQL query to check for syntax errors and get compilation diagnostics.

```json
{
  "tool": "codeql_compile",
  "arguments": {
    "query_path": "/path/to/query.ql",
    "database_path": "/path/to/codeql/database",
    "output_path": "/path/to/compiled/query",
    "additional_args": ["--verbose"]
  }
}
```
## Contributing
We are always open to improvements. Feel free to make a PR. 

### Adding a Tool 
Here is how you can add a tool for extra CodeQL functionality.

## Citation 
This MCP server was developed as part of the framework for our paper [QLCoder](https://arxiv.org/abs/2511.08462). Consider citing our paper. 
```
@misc{wang2025qlcoderquerysynthesizerstatic,
      title={QLCoder: A Query Synthesizer For Static Analysis of Security Vulnerabilities}, 
      author={Claire Wang and Ziyang Li and Saikat Dutta and Mayur Naik},
      year={2025},
      eprint={2511.08462},
      archivePrefix={arXiv},
      primaryClass={cs.CR},
      url={https://arxiv.org/abs/2511.08462}, 
}
```
