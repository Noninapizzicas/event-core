Cargalo como promt

📌 Prompt Maestro – Diseño Modular Security-First, JSON-Native

🎯 Filosofía de Diseño

Simple by Design: Elegancia sobre complejidad

Security-First: Nunca comprometer seguridad por velocidad

JSON-Native Thinking: Contratos claros, consumibles por IA

Event-Driven: Acoplamiento mínimo vía eventos

No Hardcode / No Placeholder: Todo real o falla explícita en JSON estructurado



---

🔑 Estilo de Código

Archivos: snake_case

Clases: PascalCase

Funciones/variables: snake_case

Constantes: UPPER_CASE

JSON keys: snake_case



---

📂 Entregables

(1) MAPA_DE_MODULOS

{      
  "modules": [      
    {      
      "name": "config_service",      
      "responsibility": "validar y proveer configuración JSON",      
      "inputs": ["config_requested"],      
      "outputs": ["config_validated","config_invalid"],      
      "security_notes": ["firmas o checksum","principio de mínimo privilegio","no lee secretos en claro"]      
    }      
  ]      
}      
      
(2) FLUJO_DE_EVENTOS      
      
{      
  "flows": [      
    {      
      "name": "user_action_to_execution",      
      "start_event": "user_action_requested",      
      "steps": [      
        {"consumer": "auth_gateway", "input": "user_action_requested", "outputs": ["auth_approved","auth_denied"]},      
        {"consumer": "validation_service", "input": "auth_approved", "outputs": ["input_valid","input_invalid"]},      
        {"consumer": "automation_engine", "input": "input_valid", "outputs": ["task_enqueued","task_rejected"]},      
        {"consumer": "audit_logger", "input": "*", "outputs": ["audit_recorded"]}      
      ],      
      "end_events": ["task_enqueued","task_rejected","auth_denied","input_invalid"]      
    }      
  ]      
}      
      
(3) CONTRATOS_JSON – Ejemplo: automation_engine      
      
{      
  "module": "automation_engine",      
  "inputs": [      
    {      
      "event": "input_valid",      
      "schema": {      
        "type": "object",      
        "required": ["event_id","trace_id","occurred_at","payload"],      
        "properties": {      
          "event_id": {"type":"string","format":"uuid"},      
          "trace_id": {"type":"string","format":"uuid"},      
          "occurred_at": {"type":"string","format":"date-time"},      
          "payload": {      
            "type":"object",      
            "required": ["task_type","params"],      
            "properties": {      
              "task_type": {"type":"string","enum":["ingest","transform","notify"]},      
              "params": {"type":"object","additionalProperties": false}      
            },      
            "additionalProperties": false      
          },      
          "schema_version": {"type":"string"}      
        },      
        "additionalProperties": false      
      }      
    }      
  ],      
  "outputs": [      
    {      
      "event": "task_enqueued",      
      "schema": {"$ref": "#/definitions/enqueue_result"}      
    }      
  ],      
  "definitions": {      
    "enqueue_result": {      
      "type":"object",      
      "required":["event_id","trace_id","occurred_at","payload"],      
      "properties": {      
        "event_id":{"type":"string","format":"uuid"},      
        "trace_id":{"type":"string","format":"uuid"},      
        "occurred_at":{"type":"string","format":"date-time"},      
        "payload":{      
          "type":"object",      
          "required":["queue","message_id","ttl_sec"],      
          "properties":{      
            "queue":{"type":"string"},      
            "message_id":{"type":"string"},      
            "ttl_sec":{"type":"integer","minimum":1}      
          },      
          "additionalProperties": false      
        },      
        "schema_version":{"type":"string"}      
      },      
      "additionalProperties": false      
    }      
  ]      
}      
      
(4) ESQUEMA_DE_ERROR_ESTANDAR      
      
{      
  "error": {      
    "type": "object",      
    "required": ["error_code","error_message","trace_id","occurred_at","context"],      
    "properties": {      
      "error_code": {"type":"string","pattern":"^[A-Z_]{3,40}$"},      
      "error_message": {"type":"string","minLength":1},      
      "trace_id": {"type":"string","format":"uuid"},      
      "occurred_at": {"type":"string","format":"date-time"},      
      "context": {"type":"object","additionalProperties": true},      
      "severity": {"type":"string","enum":["LOW","MEDIUM","HIGH","CRITICAL"]},      
      "retryable": {"type":"boolean","default": false}      
    },      
    "additionalProperties": false      
  }      
}      
      
(5) CHECKLIST_SEGURIDAD      
      
{      
  "security_checklist": {      
    "sandboxing": true,      
    "input_validation": "json_schema_strict",      
    "least_privilege": true,      
    "secrets": "managed_via_vault_not_env_plain",      
    "logging": "no_pii_or_secrets",      
    "rate_limits": {"enabled": true, "policy": "token_bucket"},      
    "authz_scope": ["read","write"],      
    "dependency_pins": true      
  }      
}      
      
(6) POLITICA_CONFIG_JSON      
      
{      
  "config_policy": {      
    "source_of_truth": "config_service",      
    "format": "json",      
    "schema_version": "1.0.0",      
    "no_hardcode": true,      
    "required_sections": ["services","endpoints","credentials_ref","timeouts","retries","feature_flags"],      
    "example": {      
      "services": [{"service_id":"openai","enabled":true}],      
      "endpoints": {"event_bus":"amqp://..."},      
      "credentials_ref": {"vault_path":"kv/prod/openai"},      
      "timeouts": {"default_ms": 3000},      
      "retries": {"max_retries": 3, "backoff": "exponential"},      
      "feature_flags": {"strict_validation": true}      
    }      
  }      
}      
      
(7) PLAN_DE_PRUEBAS      
      
{      
  "tests": [      
    {"name":"schema_validation_all_inputs","type":"contract","expected":"rejects_invalid_json"},      
    {"name":"security_least_privilege","type":"security","expected":"no_extra_perms"},      
    {"name":"idempotency_events","type":"resilience","expected":"no_duplicates_on_retry"},      
    {"name":"error_contract_consistency","type":"contract","expected":"standard_error_emitted"},      
    {"name":"config_integrity","type":"config","expected":"rejects_unsigned_or_malformed"}      
  ]      
}      
      
      
---      
      
📘 Esquemas Estándar (Reutilizables)      
      
{      
  "schemas": {      
    "event_envelope": {      
      "type":"object",      
      "required":["event_id","trace_id","occurred_at","producer","schema_version","payload"],      
      "properties":{      
        "event_id":{"type":"string","format":"uuid"},      
        "trace_id":{"type":"string","format":"uuid"},      
        "occurred_at":{"type":"string","format":"date-time"},      
        "producer":{"type":"string","minLength":1},      
        "schema_version":{"type":"string"},      
        "payload":{"type":"object","additionalProperties": false}      
      },      
      "additionalProperties": false      
    },      
    "standard_error": {      
      "type":"object",      
      "required":["error_code","error_message","trace_id","occurred_at","context"],      
      "properties":{      
        "error_code":{"type":"string","pattern":"^[A-Z_]{3,40}$"},      
        "error_message":{"type":"string"},      
        "trace_id":{"type":"string","format":"uuid"},      
        "occurred_at":{"type":"string","format":"date-time"},      
        "context":{"type":"object","additionalProperties": true},      
        "severity":{"type":"string","enum":["LOW","MEDIUM","HIGH","CRITICAL"]},      
        "retryable":{"type":"boolean","default": false}      
      },      
      "additionalProperties": false      
    }      
  }      
}

