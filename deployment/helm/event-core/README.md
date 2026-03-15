# Event Core Helm Chart

Helm chart oficial para desplegar Event Core en Kubernetes.

## Características

- ✅ Deployment con múltiples réplicas
- ✅ StatefulSet para MQTT broker embebido (Mosquitto)
- ✅ Health checks (`/health`) y Readiness probes (`/ready`)
- ✅ Horizontal Pod Autoscaling (HPA) opcional
- ✅ Ingress para exposición externa
- ✅ ConfigMaps para configuración
- ✅ Secrets para API keys de proveedores AI
- ✅ Service Account con RBAC
- ✅ Graceful shutdown

## Requisitos Previos

- Kubernetes 1.19+
- Helm 3.0+
- PersistentVolume provisioner (para MQTT con persistencia)

## Instalación Rápida

### 1. Agregar repositorio (cuando esté disponible)

```bash
helm repo add event-core https://charts.event-core.io
helm repo update
```

### 2. Instalar desde directorio local

```bash
# Desde el directorio raíz del proyecto
cd deployment/helm

# Instalación básica
helm install my-event-core ./event-core

# Con valores personalizados
helm install my-event-core ./event-core -f custom-values.yaml

# En un namespace específico
helm install my-event-core ./event-core --namespace event-core --create-namespace
```

## Configuración

### Valores por Defecto

Ver [values.yaml](values.yaml) para la configuración completa.

### Valores Importantes

#### Réplicas

```yaml
replicaCount: 2
```

#### Imagen

```yaml
image:
  repository: event-core
  tag: "1.0.0"
  pullPolicy: IfNotPresent
```

#### Recursos

```yaml
resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 250m
    memory: 256Mi
```

#### MQTT Broker

```yaml
eventCore:
  mqtt:
    embedded:
      enabled: true  # Usar broker embebido (Mosquitto)
      persistence:
        enabled: true
        size: 1Gi
```

O usar broker externo:

```yaml
eventCore:
  mqtt:
    external:
      enabled: true
      url: "mqtt://mosquitto.messaging.svc.cluster.local:1883"
    embedded:
      enabled: false
```

#### Módulos

```yaml
eventCore:
  modules:
    - name: "prompt-manager"
      enabled: true
    - name: "ai-gateway"
      enabled: true
    - name: "ai-agent-framework"
      enabled: true
```

#### Proveedores AI

```yaml
eventCore:
  ai:
    providers:
      deepseek:
        enabled: true
        apiKeySecret: "event-core-ai-secrets"
        apiKeySecretKey: "deepseek-api-key"
      anthropic:
        enabled: true
      openai:
        enabled: false
      ollama:
        enabled: false
        url: "http://ollama:11434"
```

## Secrets - API Keys

Antes de instalar, crea un Secret con las API keys:

```bash
kubectl create secret generic event-core-ai-secrets \
  --namespace event-core \
  --from-literal=deepseek-api-key='sk-...' \
  --from-literal=anthropic-api-key='sk-ant-...' \
  --from-literal=openai-api-key='sk-...'
```

O desde archivo:

```yaml
# secrets.yaml
apiVersion: v1
kind: Secret
metadata:
  name: event-core-ai-secrets
  namespace: event-core
type: Opaque
stringData:
  deepseek-api-key: "sk-..."
  anthropic-api-key: "sk-ant-..."
  openai-api-key: "sk-..."
```

```bash
kubectl apply -f secrets.yaml
```

## Ingress

Para exponer Event Core al exterior:

```yaml
ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
  hosts:
    - host: event-core.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: event-core-tls
      hosts:
        - event-core.example.com
```

## Autoscaling (HPA)

Habilitar escalado automático:

```yaml
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 80
  targetMemoryUtilizationPercentage: 80
```

## Ejemplos de Deployment

### Producción con Alta Disponibilidad

```yaml
# production-values.yaml
replicaCount: 3

resources:
  limits:
    cpu: 1000m
    memory: 1Gi
  requests:
    cpu: 500m
    memory: 512Mi

autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 70

eventCore:
  mqtt:
    external:
      enabled: true
      url: "mqtt://mosquitto-ha.messaging.svc.cluster.local:1883"
    embedded:
      enabled: false

ingress:
  enabled: true
  className: "nginx"
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/rate-limit: "100"
  hosts:
    - host: event-core.production.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: event-core-prod-tls
      hosts:
        - event-core.production.example.com

affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values:
                  - event-core
          topologyKey: kubernetes.io/hostname
```

Instalar:

```bash
helm install event-core-prod ./event-core \
  --namespace production \
  --create-namespace \
  --values production-values.yaml
```

### Desarrollo / Testing

```yaml
# dev-values.yaml
replicaCount: 1

resources:
  limits:
    cpu: 250m
    memory: 256Mi
  requests:
    cpu: 100m
    memory: 128Mi

eventCore:
  logLevel: "debug"
  mqtt:
    embedded:
      enabled: true
      persistence:
        enabled: false  # Sin persistencia en dev

  ai:
    providers:
      ollama:
        enabled: true
        url: "http://ollama.ai.svc.cluster.local:11434"
      deepseek:
        enabled: false
      anthropic:
        enabled: false
```

Instalar:

```bash
helm install event-core-dev ./event-core \
  --namespace development \
  --create-namespace \
  --values dev-values.yaml
```

## Comandos Útiles

### Ver estado del deployment

```bash
helm status my-event-core
kubectl get pods -l app.kubernetes.io/name=event-core
```

### Ver logs

```bash
# Logs de un pod específico
kubectl logs -f event-core-5d8f7b9c4d-abcde

# Logs de todos los pods
kubectl logs -l app.kubernetes.io/name=event-core --tail=100 -f

# Logs del MQTT broker
kubectl logs -f event-core-mqtt-0
```

### Verificar health checks

```bash
# Port-forward
kubectl port-forward svc/my-event-core 3000:3000

# En otra terminal
curl http://localhost:3000/health
curl http://localhost:3000/ready
curl http://localhost:3000/stats
```

### Actualizar deployment

```bash
# Actualizar valores
helm upgrade my-event-core ./event-core \
  --values custom-values.yaml

# Actualizar solo la imagen
helm upgrade my-event-core ./event-core \
  --set image.tag=1.1.0
```

### Desinstalar

```bash
helm uninstall my-event-core

# Con namespace
helm uninstall my-event-core --namespace event-core
kubectl delete namespace event-core
```

## Testing Local con Minikube

```bash
# Iniciar minikube
minikube start

# Construir imagen localmente
eval $(minikube docker-env)
docker build -t event-core:1.0.0 .

# Instalar chart
helm install event-core-test ./deployment/helm/event-core \
  --set image.pullPolicy=Never \
  --set image.tag=1.0.0

# Acceder al servicio
minikube service event-core-test --url

# O port-forward
kubectl port-forward svc/event-core-test 3000:3000
```

## Troubleshooting

### Pods no arrancan

```bash
# Ver eventos
kubectl describe pod event-core-xxxx

# Ver logs
kubectl logs event-core-xxxx

# Verificar recursos
kubectl top pod event-core-xxxx
```

### MQTT broker no conecta

```bash
# Verificar StatefulSet
kubectl get statefulset event-core-mqtt

# Ver logs del broker
kubectl logs event-core-mqtt-0

# Probar conexión MQTT
kubectl run mqtt-test --image=eclipse-mosquitto:2.0 --rm -it -- mosquitto_sub -h event-core-mqtt -t '#' -v
```

### Readiness probe falla

```bash
# Ver estado del pod
kubectl describe pod event-core-xxxx

# Verificar endpoint /ready
kubectl port-forward event-core-xxxx 3000:3000
curl http://localhost:3000/ready
```

### Secrets no encontrados

```bash
# Verificar secrets
kubectl get secrets

# Crear secrets si faltan
kubectl create secret generic event-core-ai-secrets \
  --from-literal=deepseek-api-key='your-key' \
  --from-literal=anthropic-api-key='your-key'
```

## Arquitectura del Deployment

```
┌─────────────────────────────────────────────┐
│           Kubernetes Cluster                │
│                                             │
│  ┌───────────────────────────────────────┐ │
│  │         Ingress Controller            │ │
│  │      (nginx/traefik/etc)              │ │
│  └──────────────┬────────────────────────┘ │
│                 │                           │
│  ┌──────────────▼────────────────────────┐ │
│  │    Service: event-core (ClusterIP)    │ │
│  │    Port: 3000 (HTTP)                  │ │
│  └──────────────┬────────────────────────┘ │
│                 │                           │
│  ┌──────────────▼────────────────────────┐ │
│  │   Deployment: event-core              │ │
│  │   Replicas: 2+ (autoscaling)          │ │
│  │                                        │ │
│  │   ┌────────┐  ┌────────┐  ┌────────┐ │ │
│  │   │ Pod 1  │  │ Pod 2  │  │ Pod N  │ │ │
│  │   │ :3000  │  │ :3000  │  │ :3000  │ │ │
│  │   └───┬────┘  └───┬────┘  └───┬────┘ │ │
│  └───────┼───────────┼───────────┼──────┘ │
│          │           │           │         │
│          └───────────┼───────────┘         │
│                      │                     │
│  ┌───────────────────▼──────────────────┐ │
│  │  Service: event-core-mqtt (Headless)│ │
│  │  Port: 1883 (MQTT)                  │ │
│  └───────────────────┬──────────────────┘ │
│                      │                     │
│  ┌───────────────────▼──────────────────┐ │
│  │ StatefulSet: event-core-mqtt-0      │ │
│  │ (Mosquitto MQTT Broker)             │ │
│  │                                      │ │
│  │ PersistentVolumeClaim (1Gi)         │ │
│  └──────────────────────────────────────┘ │
│                                             │
│  ┌──────────────────────────────────────┐ │
│  │ ConfigMap: event-core-config         │ │
│  │ - config.json                        │ │
│  │ - ai-config.json                     │ │
│  └──────────────────────────────────────┘ │
│                                             │
│  ┌──────────────────────────────────────┐ │
│  │ Secret: event-core-ai-secrets        │ │
│  │ - deepseek-api-key                   │ │
│  │ - anthropic-api-key                  │ │
│  │ - openai-api-key                     │ │
│  └──────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Monitoreo

### Prometheus Metrics

Event Core expone métricas en `/metrics` (si el módulo de observabilidad está habilitado).

```yaml
# ServiceMonitor para Prometheus Operator
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: event-core
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: event-core
  endpoints:
    - port: http
      path: /metrics
```

### Grafana Dashboard

Dashboard recomendado para visualizar métricas de Event Core (próximamente).

## Seguridad

### Security Context

Los pods corren como usuario no-root (UID 1000):

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  capabilities:
    drop:
      - ALL
```

### Network Policies

Ejemplo de Network Policy para restringir acceso:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: event-core-netpol
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: event-core
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: ingress-nginx
      ports:
        - protocol: TCP
          port: 3000
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: mqtt
      ports:
        - protocol: TCP
          port: 1883
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 53  # DNS
        - protocol: UDP
          port: 53
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: TCP
          port: 443  # HTTPS para AI providers
```

## Contribuir

Para contribuir al chart:

1. Fork el repositorio
2. Crea una rama: `git checkout -b feature/my-feature`
3. Modifica el chart
4. Valida con `helm lint ./deployment/helm/event-core`
5. Crea un PR

## Licencia

MIT

## Soporte

- GitHub Issues: https://github.com/Noninapizzicas/event-core/issues
- Documentación: https://docs.event-core.io
