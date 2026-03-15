# Scheduler Module

Advanced job scheduling module with multiple trigger types for Event-Core.

## Features

- **Multiple Trigger Types**: cron, interval, datetime, event-based, condition, composite
- **Multiple Action Types**: MQTT publish, HTTP requests, module calls
- **Persistence**: Jobs saved to JSON file
- **Template Variables**: Dynamic values in topics and payloads
- **Retry Logic**: Configurable retries with exponential backoff
- **Execution History**: Track recent job executions

## Trigger Types

### Cron
Standard cron expressions for time-based scheduling.

```json
{
  "type": "cron",
  "expression": "0 3 * * *",
  "timezone": "Europe/Madrid"
}
```

### Interval
Execute at fixed intervals.

```json
{
  "type": "interval",
  "value": 30,
  "unit": "s"
}
```

Units: `ms`, `s`, `m`, `h`, `d`

### Datetime
Execute at specific date/time with optional repeat.

```json
{
  "type": "datetime",
  "date": "2025-12-25",
  "time": "00:00:00",
  "repeat": "yearly"
}
```

Repeat options: `once`, `daily`, `weekly`, `monthly`, `yearly`

### Event
Trigger when an MQTT event is received.

```json
{
  "type": "event",
  "topic": "file.uploaded",
  "condition": "payload.type === 'pdf'",
  "debounce": 5000
}
```

### Condition
Trigger when a condition becomes true.

```json
{
  "type": "condition",
  "check": "metrics.cpu > 80",
  "interval": 10000,
  "persist": true
}
```

### Composite
Combine multiple triggers with logic operators.

```json
{
  "type": "composite",
  "logic": "AND",
  "triggers": [
    { "type": "cron", "expression": "0 9 * * 1-5" },
    { "type": "condition", "check": "system.load < 50" }
  ]
}
```

Logic operators: `AND`, `OR`, `NAND`, `NOR`, `XOR`

## Action Types

### MQTT
Publish an event to MQTT broker.

```json
{
  "type": "mqtt",
  "topic": "backup.start",
  "payload": { "database": "primary" },
  "qos": 1
}
```

### HTTP
Make an HTTP request.

```json
{
  "type": "http",
  "url": "https://api.example.com/webhook",
  "method": "POST",
  "headers": { "Authorization": "Bearer token" },
  "body": { "event": "scheduled" },
  "timeout": 30000
}
```

### Module
Call a module method via events.

```json
{
  "type": "module",
  "module": "backup-manager",
  "method": "startBackup",
  "params": { "type": "full" }
}
```

## Template Variables

Use `{{variable}}` syntax in topics and payloads:

- `{{now}}` - ISO timestamp
- `{{uuid}}` - Random UUID
- `{{date}}` - Date (YYYY-MM-DD)
- `{{time}}` - Time (HH:mm:ss)
- `{{job.id}}` - Job ID
- `{{job.name}}` - Job name
- `{{trigger.type}}` - Trigger type
- `{{event.payload}}` - Event payload (for event triggers)

## API

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| GET | /jobs | List all jobs |
| GET | /jobs/:id | Get job by ID |
| POST | /jobs | Create job |
| PUT | /jobs/:id | Update job |
| DELETE | /jobs/:id | Delete job |
| POST | /jobs/:id/enable | Enable job |
| POST | /jobs/:id/disable | Disable job |
| POST | /jobs/:id/trigger | Trigger job manually |
| GET | /triggers/types | List trigger types |
| GET | /executions | List recent executions |
| GET | /stats | Get statistics |

### UI Actions (MQTT)

Domain: `scheduler`

Actions: `list`, `get`, `create`, `update`, `delete`, `enable`, `disable`, `trigger`, `triggers`, `stats`, `executions`

## Example Job

```json
{
  "name": "Daily Backup",
  "description": "Database backup at 3am",
  "trigger": {
    "type": "cron",
    "expression": "0 3 * * *"
  },
  "action": {
    "type": "mqtt",
    "topic": "backup.start",
    "payload": {
      "database": "primary",
      "timestamp": "{{now}}"
    }
  },
  "options": {
    "enabled": true,
    "maxRetries": 3,
    "retryDelay": 5000,
    "timeout": 600000
  }
}
```

## Events

Published events:

- `scheduler.job.created` - Job created
- `scheduler.job.updated` - Job updated
- `scheduler.job.deleted` - Job deleted
- `scheduler.job.enabled` - Job enabled
- `scheduler.job.disabled` - Job disabled
- `scheduler.job.triggered` - Job execution started
- `scheduler.job.completed` - Job execution completed
- `scheduler.job.failed` - Job execution failed

## Configuration

In `module.json`:

```json
{
  "config": {
    "jobsPath": "./data/scheduler/jobs.json",
    "autoSave": true,
    "saveInterval": 30000,
    "defaultTimezone": "Europe/Madrid",
    "maxConcurrentJobs": 100,
    "defaultTimeout": 300000,
    "defaultRetries": 3,
    "defaultRetryDelay": 5000
  }
}
```
