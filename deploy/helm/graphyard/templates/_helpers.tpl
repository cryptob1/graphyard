{{- define "graphyard.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "graphyard.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "graphyard.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "graphyard.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: {{ include "graphyard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "graphyard.version" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "graphyard.selectorLabels" -}}
app.kubernetes.io/name: {{ include "graphyard.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The control-plane pods, and nothing else in the release. Every workload carries a component
label beside the release selector so the Service (and `kubectl port-forward svc/…`, which
picks any pod the selector matches) never lands on the database, a Job or the test pod.
*/}}
{{- define "graphyard.serverSelectorLabels" -}}
{{ include "graphyard.selectorLabels" . }}
app.kubernetes.io/component: server
{{- end -}}

{{/* The version the image tag names, with any @sha256 digest stripped. */}}
{{- define "graphyard.version" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- index (splitList "@" $tag) 0 -}}
{{- end -}}

{{- define "graphyard.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{/* Which Secret the pods read credentials from. */}}
{{- define "graphyard.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "graphyard.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "graphyard.postgresqlName" -}}
{{- printf "%s-postgresql" (include "graphyard.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Refuse an installation that cannot hold credentials. */}}
{{- define "graphyard.validate" -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.secrets.create) -}}
{{- fail "Set secrets.existingSecret to a Secret holding DATABASE_URL, GRAPHYARD_PRINCIPALS, GITHUB_PRIVATE_KEY and GITHUB_WEBHOOK_SECRET, or secrets.create=true with values (evaluation only)" -}}
{{- end -}}
{{- if and .Values.secrets.create (not .Values.secrets.principals) -}}
{{- fail "secrets.create needs secrets.principals: a JSON array of individual role-scoped credentials" -}}
{{- end -}}
{{- if and .Values.secrets.create (not .Values.postgresql.enabled) (not .Values.secrets.databaseUrl) -}}
{{- fail "secrets.create needs secrets.databaseUrl unless postgresql.enabled provides the bundled database" -}}
{{- end -}}
{{- if and .Values.postgresql.enabled (not .Values.postgresql.password) -}}
{{- fail "postgresql.enabled needs postgresql.password" -}}
{{- end -}}
{{- if and .Values.postgresql.enabled (not .Values.secrets.create) -}}
{{- fail "postgresql.enabled composes DATABASE_URL into the chart-managed Secret; set secrets.create=true" -}}
{{- end -}}
{{- end -}}

{{/* Environment shared by the server, the migration Job and the backup CronJob. */}}
{{- define "graphyard.env" -}}
- name: HOST
  value: "0.0.0.0"
- name: PORT
  value: "4310"
- name: GITHUB_PRIVATE_KEY_FILE
  value: /var/run/graphyard/secrets/GITHUB_PRIVATE_KEY
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "graphyard.secretName" . }}
      key: DATABASE_URL
- name: GRAPHYARD_PRINCIPALS
  valueFrom:
    secretKeyRef:
      name: {{ include "graphyard.secretName" . }}
      key: GRAPHYARD_PRINCIPALS
- name: GITHUB_WEBHOOK_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "graphyard.secretName" . }}
      key: GITHUB_WEBHOOK_SECRET
      optional: true
- name: TMPDIR
  value: /tmp
{{- range $key, $value := .Values.config.extraEnv }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}

{{- define "graphyard.configEnvFrom" -}}
- configMapRef:
    name: {{ include "graphyard.fullname" . }}
{{- end -}}

{{- define "graphyard.secretVolume" -}}
- name: secrets
  secret:
    secretName: {{ include "graphyard.secretName" . }}
    optional: false
    items:
      - key: GITHUB_PRIVATE_KEY
        path: GITHUB_PRIVATE_KEY
        mode: 0440
- name: tmp
  emptyDir: {}
{{- end -}}

{{- define "graphyard.secretMounts" -}}
- name: secrets
  mountPath: /var/run/graphyard/secrets
  readOnly: true
- name: tmp
  mountPath: /tmp
{{- end -}}

{{/* Wait for the bundled evaluation database before a container that needs it starts. */}}
{{- define "graphyard.waitForPostgresql" -}}
{{- if .Values.postgresql.enabled }}
initContainers:
  - name: wait-for-postgresql
    image: {{ .Values.postgresql.image | quote }}
    securityContext:
      {{- toYaml .Values.containerSecurityContext | nindent 6 }}
    command: ["sh", "-c", "until pg_isready -h {{ include "graphyard.postgresqlName" . }} -U {{ .Values.postgresql.username }}; do sleep 2; done"]
{{- end }}
{{- end -}}
