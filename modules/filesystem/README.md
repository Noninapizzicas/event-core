# Filesystem Module

Core filesystem operations for the entire system.

## Purpose

Provides unified file operations accessible from:
- **UI** via `mqttRequest('fs', 'action', data)`
- **AI** via tools/function calling
- **Other modules** via eventBus

## Operations

| Action | Description | Confirmation |
|--------|-------------|--------------|
| `list` | List files and directories | No |
| `read` | Read file content | No |
| `write` | Write/create file | Yes |
| `delete` | Delete file or directory | Yes |
| `mkdir` | Create directory | No |
| `move` | Move file or directory | Yes |
| `copy` | Copy file | No |
| `search` | Search by name or content | No |
| `info` | Get file/directory info | No |

## Usage

### From UI (SvelteKit)

```typescript
import { mqttRequest } from '$lib/ui-core/mqtt-request';

// List files
const result = await mqttRequest('fs', 'list', { path: '/projects' });

// Read file
const file = await mqttRequest('fs', 'read', { path: '/config.json' });

// Write file
await mqttRequest('fs', 'write', {
  path: '/notes/todo.txt',
  content: 'Buy milk'
});

// Delete
await mqttRequest('fs', 'delete', { path: '/temp/old-file.txt' });

// Search
const results = await mqttRequest('fs', 'search', {
  query: 'login',
  path: '/src',
  content: true  // Search in file content
});
```

### From AI (via tools)

The AI can use these tools:
- `fs.list` - List directory contents
- `fs.read` - Read file content
- `fs.write` - Write to file (requires confirmation)
- `fs.delete` - Delete file/directory (requires confirmation)
- `fs.mkdir` - Create directory
- `fs.search` - Search files

### From Other Modules

```javascript
// Via UIHandler (recommended)
const result = await this.uiHandler.handle('fs', 'read', {
  path: '/config.json'
});

// Via eventBus
await this.eventBus.publish('fs.read.request', {
  request_id: 'xxx',
  path: '/config.json'
});
```

## Security

- All paths are validated to stay within `/data/` directory
- Path traversal attacks (../) are blocked
- Binary files returned as base64
- Large files (>10MB) are rejected

## Events Published

| Event | When |
|-------|------|
| `fs.file.created` | New file written |
| `fs.file.updated` | Existing file updated |
| `fs.file.deleted` | File or directory deleted |
| `fs.directory.created` | New directory created |

## Data Structure

```
/data/
├── projects/
│   └── {project-id}/
│       └── ... project files
├── system/
│   └── config/
└── temp/
```
