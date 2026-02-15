export const ProxyStrategy = {
    name: "ProxyStrategy",
    
    detect: (repoPath, repoUrl) => {
        // Phase 1: Keep existing heuristic
        return repoUrl.toLowerCase().includes('sniproxy');
    },

    analyze: async (repoPath, repoUrl, appName) => {
        console.log("🛡️ [Strategy: Proxy] Applying Sniproxy Max Fallback");
        
        const safetyVars = {
            "SNIPROXY_GENERAL__PUBLIC_IPV4": "127.0.0.1",
            "SNIPROXY_GENERAL__PUBLIC_IPV6": "::1",
            "SNIPROXY_GENERAL__BIND_HTTP": "0.0.0.0:80",
            "SNIPROXY_GENERAL__BIND_HTTPS": "0.0.0.0:443",
            "GOMAXPROCS": "1",
            "PUBLIC_IPV4": "127.0.0.1",
            "BIND_HTTP": "0.0.0.0:80"
        };

        const envContent = Object.entries(safetyVars).map(([k, v]) => `  ${k} = '${v}'`).join('\n');
        
        // CORRECTION: Use two separate service blocks to map ports correctly (80->80, 443->443)
        // CORRECTION: handlers = [] for raw TCP (Fly.io rejects 'tcp' as a handler name)
        const fly_toml = `app = '${appName}'
primary_region = 'iad'

[env]
${envContent}

# Service for HTTP (Port 80)
[[services]]
  protocol = 'tcp'
  internal_port = 80
  processes = ['app']
  
  [[services.ports]]
    port = 80
    handlers = []

# Service for HTTPS (Port 443)
[[services]]
  protocol = 'tcp'
  internal_port = 443
  processes = ['app']
  
  [[services.ports]]
    port = 443
    handlers = []

[[vm]]
  memory = '512mb'
  cpu_kind = 'shared'
  cpus = 1
`;

        const sniproxyConfig = `general:
  upstream_dns: "udp://1.1.1.1:53"
  upstream_dns_over_socks5: false
  bind_dns_over_udp: "0.0.0.0:53"
  bind_http: "0.0.0.0:80"
  bind_https: "0.0.0.0:443"
  public_ipv4: "127.0.0.1"
  public_ipv6: "::1"
  allow_conn_to_local: false
  log_level: info

acl:
  geoip:
    enabled: false
  domain:
    enabled: false
  cidr:
    enabled: false
`;

        const dockerfile = `FROM golang:alpine AS builder
WORKDIR /app
RUN apk add --no-cache git
COPY . .
COPY config.yaml /config.yaml
RUN if [ -d "./cmd/sniproxy" ]; then go build -ldflags "-s -w" -o /sniproxy ./cmd/sniproxy; else go build -ldflags "-s -w" -o /sniproxy .; fi
FROM alpine:latest
RUN apk add --no-cache ca-certificates
COPY --from=builder /sniproxy /sniproxy
COPY config.yaml /config.yaml
ENTRYPOINT ["/sniproxy", "-c", "/config.yaml"]
`;

        const envVars = Object.entries(safetyVars).map(([name, value]) => ({ name, reason: "Crash Prevention (Proxy Preset)" }));

        return {
            fly_toml,
            dockerfile,
            explanation: "Detected Proxy Pattern. Applied Crash Prevention Preset with valid DNS URI scheme and resource limits.",
            envVars: envVars,
            stack: "Golang (Sniproxy Preset)",
            files: [
                { name: "config.yaml", content: sniproxyConfig },
                { name: "sniproxy/cmd/sniproxy/config.defaults.yaml", content: sniproxyConfig }
            ]
        };
    }
};